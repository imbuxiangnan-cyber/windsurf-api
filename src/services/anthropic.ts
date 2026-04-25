/**
 * Anthropic Messages API compatibility layer.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { log } from '../config.js';
import { resolveModel } from '../models.js';
import { runChatCore, ChatError } from './chat.js';

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
        content = msg.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      }
      messages.push({ role: msg.role, content });
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
    const result = await runChatCore(messages, modelKey, authKey);
    const stream = !!body.stream;
    const msgId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20);

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      sse(res, {
        type: 'message_start',
        message: {
          id: msgId, type: 'message', role: 'assistant',
          model: body.model, content: [],
          usage: { input_tokens: result.promptTokens, output_tokens: 0 },
        },
      });

      if (result.thinking) {
        sse(res, {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        });
        sse(res, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: result.thinking },
        });
        sse(res, { type: 'content_block_stop', index: 0 });

        sse(res, {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        });
        sse(res, {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: result.text },
        });
        sse(res, { type: 'content_block_stop', index: 1 });
      } else {
        sse(res, {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        sse(res, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: result.text },
        });
        sse(res, { type: 'content_block_stop', index: 0 });
      }

      sse(res, {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: result.completionTokens },
      });
      sse(res, { type: 'message_stop' });
      res.end();
    } else {
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
      json(res, err.statusCode, {
        type: 'error',
        error: {
          type: err.statusCode === 401 ? 'authentication_error' :
                err.statusCode === 429 ? 'rate_limit_error' : 'api_error',
          message: err.message,
        },
      });
    } else {
      log.error('Anthropic API error:', err.message);
      json(res, 500, {
        type: 'error',
        error: { type: 'api_error', message: err.message },
      });
    }
  }
}
