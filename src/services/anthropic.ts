/**
 * Anthropic Messages API compatibility layer.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { log } from '../config.js';
import { resolveModel } from '../models.js';
import { runChatCore, streamChatCore, StreamContext, StreamChunk, ChatError } from './chat.js';
import { consumeQuota } from './token.js';
import { recordRequest } from './stats.js';

function json(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function sse(res: http.ServerResponse, data: object) {
  res.write(`event: ${(data as any).type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function getApiKey(req: http.IncomingMessage): string | null {
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey) return String(xApiKey);
  const auth = req.headers['authorization'] || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function convertMessages(body: any): any[] {
  const messages: any[] = [];
  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      const systemText = body.system
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
      if (systemText) messages.push({ role: 'system', content: systemText });
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Extract text from all content block types
        const parts: string[] = [];
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'thinking' && block.thinking) {
            parts.push(`<thinking>\n${block.thinking}\n</thinking>`);
          } else if (block.type === 'tool_use') {
            parts.push(`<tool_use id="${block.id}" name="${block.name}">\n${JSON.stringify(block.input)}\n</tool_use>`);
          } else if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string' ? block.content
              : Array.isArray(block.content) ? block.content.map((b: any) => b.text || '').join('\n') : '';
            parts.push(`<tool_result tool_use_id="${block.tool_use_id}">\n${resultContent}\n</tool_result>`);
          }
        }
        content = parts.join('\n');
      }
      if (content) messages.push({ role: msg.role, content });
    }
  }
  return messages;
}

export async function handleAnthropicMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: any,
): Promise<void> {
  try {
    const authKey = getApiKey(req);
    if (!authKey) {
      return json(res, 401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'Missing x-api-key or Authorization header' },
      });
    }

    const modelKey = resolveModel(body.model);
    if (!modelKey) {
      return json(res, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: `Model "${body.model}" not found` },
      });
    }

    const messages = convertMessages(body);
    const stream = !!body.stream;
    const msgId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20);

    // Extract thinking budget from Anthropic API format
    const thinkingBudget = body.thinking?.budget_tokens || 128000;

    if (stream) {
      let headersSent = false;
      let sentStart = false;
      let fullText = '';
      let fullThinking = '';
      let ctx!: StreamContext;

      // Block state tracking
      let blockIndex = 0;
      let thinkingBlockOpen = false;
      let textBlockOpen = false;

      function openThinkingBlock() {
        if (thinkingBlockOpen) return;
        sse(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } });
        thinkingBlockOpen = true;
      }

      function closeThinkingBlock() {
        if (!thinkingBlockOpen) return;
        sse(res, { type: 'content_block_stop', index: blockIndex });
        thinkingBlockOpen = false;
        blockIndex++;
      }

      function openTextBlock() {
        if (textBlockOpen) return;
        closeThinkingBlock(); // close thinking first if open
        sse(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
        textBlockOpen = true;
      }

      function closeTextBlock() {
        if (!textBlockOpen) return;
        sse(res, { type: 'content_block_stop', index: blockIndex });
        textBlockOpen = false;
        blockIndex++;
      }

      for await (const chunk of streamChatCore(messages, modelKey, authKey, { thinkingBudget })) {
        if (!headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          headersSent = true;
        }
        ctx = chunk.ctx;

        if (!sentStart) {
          sse(res, {
            type: 'message_start',
            message: {
              id: msgId, type: 'message', role: 'assistant',
              model: body.model, content: [],
              usage: { input_tokens: ctx.promptTokens, output_tokens: 0 },
            },
          });
          sentStart = true;
        }

        // Thinking deltas → thinking block
        if (chunk.thinking) {
          fullThinking += chunk.thinking;
          openThinkingBlock();
          sse(res, {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'thinking_delta', thinking: chunk.thinking },
          });
        }

        // Text deltas → text block (auto-closes thinking block first)
        if (chunk.text) {
          fullText += chunk.text;
          openTextBlock();
          sse(res, {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'text_delta', text: chunk.text },
          });
        }
      }

      // Close any open blocks
      closeThinkingBlock();
      closeTextBlock();

      // If nothing was output, emit an empty text block
      if (blockIndex === 0) {
        sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        sse(res, { type: 'content_block_stop', index: 0 });
      }

      const completionTokens = Math.ceil(fullText.length / 4);
      sse(res, {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: completionTokens },
      });
      sse(res, { type: 'message_stop' });
      res.end();

      if (ctx) {
        const tokensUsed = ctx.promptTokens + completionTokens;
        consumeQuota(ctx.authKey, tokensUsed);
        recordRequest({ model: ctx.modelKey, channelId: ctx.channel.id, tokensUsed });
      }
    } else {
      const result = await runChatCore(messages, modelKey, authKey);
      const content: any[] = [];
      if (result.thinking) {
        content.push({ type: 'thinking', thinking: result.thinking });
      }
      content.push({ type: 'text', text: result.text });

      json(res, 200, {
        id: msgId, type: 'message', role: 'assistant',
        model: body.model, content,
        stop_reason: 'end_turn', stop_sequence: null,
        usage: {
          input_tokens: result.promptTokens,
          output_tokens: result.completionTokens,
        },
      });
    }
  } catch (err: any) {
    if (err instanceof ChatError) {
      if (!res.headersSent) {
        json(res, err.statusCode, {
          type: 'error',
          error: {
            type: err.statusCode === 401 ? 'authentication_error' :
                  err.statusCode === 429 ? 'rate_limit_error' : 'api_error',
            message: err.message,
          },
        });
      }
    } else {
      log.error('Anthropic API error:', err.message);
      if (!res.headersSent) {
        json(res, 500, {
          type: 'error',
          error: { type: 'api_error', message: err.message },
        });
      }
    }
    if (res.headersSent && !res.writableEnded) res.end();
  }
}
