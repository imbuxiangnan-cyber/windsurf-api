/**
 * Chat completions business logic.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { log } from '../config.js';
import { ChatRequest } from '../types.js';
import { resolveModel, getModelInfo, ModelInfo } from '../models.js';
import { pickChannel, markChannelError, markChannelSuccess } from './channel.js';
import { Channel } from '../types.js';
import { validateToken, isModelAllowedForToken, consumeQuota } from './token.js';
import { recordRequest } from './stats.js';
import { WindsurfClient } from '../core/client.js';
import { getLsPort, getCsrfToken } from '../core/langserver.js';
import { applyMapping, waitForConcurrency, releaseConcurrency } from './routing.js';
import { PathSanitizeStream, sanitizeText } from './sanitize.js';
import { buildToolPreamble, convertToolMessages, ToolCallStreamParser, ParsedToolCall } from './tool-emulation.js';

export class ChatError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

function computeUsage(messages: any[], text: string) {
  const promptTokens = Math.ceil(messages.reduce((s: number, m: any) =>
    s + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4);
  const completionTokens = Math.ceil(text.length / 4);
  return { promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
}

export interface ChatResult {
  text: string;
  thinking: string;
  modelInfo: ModelInfo;
  modelKey: string;
  channel: Channel;
  authKey: string;
  promptTokens: number;
  completionTokens: number;
}

export interface StreamContext {
  modelInfo: ModelInfo;
  modelKey: string;
  channel: Channel;
  authKey: string;
  promptTokens: number;
  serverInputTokens?: number;
  serverOutputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Validate, pick channel, return an async generator that yields chunks in real-time.
 * Caller MUST consume the generator fully (or catch errors) to ensure cleanup.
 */
export interface StreamChunk {
  text: string;
  thinking: string;
  stepKind?: string | null;
  toolCalls?: any[];
  runCommand?: any;
  serverUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
  ctx: StreamContext;
}

export async function* streamChatCore(
  messages: any[],
  modelKey: string,
  authKey: string,
  opts: { thinkingBudget?: number } = {},
): AsyncGenerator<StreamChunk> {
  const tokenCheck = validateToken(authKey);
  if (!tokenCheck.valid) {
    throw new ChatError(tokenCheck.error || 'Unauthorized', 401);
  }

  const mappedKey = applyMapping(modelKey);
  const modelInfo = getModelInfo(mappedKey);
  if (!modelInfo) {
    throw new ChatError(`Model "${modelKey}" not found`, 404);
  }

  if (tokenCheck.token && !isModelAllowedForToken(tokenCheck.token, mappedKey)) {
    throw new ChatError(`Model "${modelKey}" not allowed for this key`, 403);
  }

  const gotSlot = await waitForConcurrency(mappedKey, 30_000);
  if (!gotSlot) {
    throw new ChatError(`Model "${modelKey}" concurrency limit reached, try later`, 429);
  }

  const ch = pickChannel();
  if (!ch) {
    releaseConcurrency(mappedKey);
    throw new ChatError('All channels busy or in error state', 429);
  }

  const promptTokens = Math.ceil(messages.reduce((s: number, m: any) =>
    s + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4);
  const ctx: StreamContext = { modelInfo, modelKey: mappedKey, channel: ch, authKey, promptTokens };

  try {
    const client = new WindsurfClient(ch.apiKey, getLsPort(), getCsrfToken());
    const gen = client.streamChat(messages, modelInfo.enumValue, modelInfo.modelUid!, {
      thinkingBudget: opts.thinkingBudget,
    });

    for await (const chunk of gen) {
      // Capture server-reported usage into ctx when it arrives
      if (chunk.serverUsage) {
        ctx.serverInputTokens = chunk.serverUsage.inputTokens;
        ctx.serverOutputTokens = chunk.serverUsage.outputTokens;
        ctx.cacheReadTokens = chunk.serverUsage.cacheReadTokens;
        ctx.cacheWriteTokens = chunk.serverUsage.cacheWriteTokens;
      }
      yield {
        text: chunk.text || '',
        thinking: chunk.thinking || '',
        stepKind: chunk.stepKind,
        toolCalls: chunk.toolCalls,
        runCommand: chunk.runCommand,
        serverUsage: chunk.serverUsage,
        ctx,
      };
    }

    markChannelSuccess(ch.apiKey);
  } catch (err: any) {
    classifyAndMarkError(ch.apiKey, err);
    throw err;
  } finally {
    releaseConcurrency(mappedKey);
  }
}

/** Non-streaming wrapper for backward compat */
export async function runChatCore(
  messages: any[],
  modelKey: string,
  authKey: string,
): Promise<ChatResult> {
  let fullText = '';
  let fullThinking = '';
  let ctx!: StreamContext;

  for await (const chunk of streamChatCore(messages, modelKey, authKey)) {
    if (chunk.text) fullText += chunk.text;
    if (chunk.thinking) fullThinking += chunk.thinking;
    ctx = chunk.ctx;
  }

  const completionTokens = Math.ceil(fullText.length / 4);
  const tokensUsed = ctx.promptTokens + completionTokens;
  consumeQuota(ctx.authKey, tokensUsed);
  recordRequest({ model: ctx.modelKey, channelId: ctx.channel.id, tokensUsed });

  return {
    text: fullText, thinking: fullThinking,
    modelInfo: ctx.modelInfo, modelKey: ctx.modelKey,
    channel: ctx.channel, authKey: ctx.authKey,
    promptTokens: ctx.promptTokens, completionTokens,
  };
}

function classifyAndMarkError(apiKey: string, err: any): void {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('rate') && msg.includes('limit')) {
    markChannelError(apiKey, 'rate_limited');
  } else if (msg.includes('quota') || msg.includes('exhausted') || msg.includes('exceeded')) {
    markChannelError(apiKey, 'exhausted');
  } else if (msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('401') || msg.includes('403')) {
    markChannelError(apiKey, 'banned');
  } else {
    markChannelError(apiKey);
  }
}

function json(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function sse(res: http.ServerResponse, data: object) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function handleChatCompletion(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  body: ChatRequest,
  authKey: string,
): Promise<void> {
  try {
    if (!Array.isArray(body.messages)) {
      return json(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
    }

    const modelKey = resolveModel(body.model);
    if (!modelKey) {
      return json(res, 404, { error: { message: `Model "${body.model}" not found`, type: 'invalid_request_error' } });
    }

    const stream = !!body.stream;
    const chatId = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 20);
    const created = Math.floor(Date.now() / 1000);

    // Tool emulation: inject preamble and convert tool messages
    const hasTools = Array.isArray((body as any).tools) && (body as any).tools.length > 0;
    let chatMessages = body.messages;
    if (hasTools) {
      const preamble = buildToolPreamble((body as any).tools);
      chatMessages = convertToolMessages([...chatMessages]);
      // Prepend tool preamble to system prompt
      const sysIdx = chatMessages.findIndex((m: any) => m.role === 'system');
      if (sysIdx >= 0) {
        chatMessages[sysIdx] = { ...chatMessages[sysIdx], content: preamble + chatMessages[sysIdx].content };
      } else {
        chatMessages.unshift({ role: 'system', content: preamble });
      }
    }

    if (stream) {
      let headersSent = false;
      let sentRole = false;
      let fullText = '';
      let ctx!: StreamContext;
      const textSanitizer = new PathSanitizeStream();
      const toolParser = hasTools ? new ToolCallStreamParser() : null;
      let accToolCalls: ParsedToolCall[] = [];

      // Extract thinking budget: OpenAI uses reasoning_effort or custom header
      const thinkingBudget = (body as any).thinking_budget || 128000;
      for await (const chunk of streamChatCore(chatMessages, modelKey, authKey, { thinkingBudget })) {
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
        if (!sentRole) {
          sse(res, {
            id: chatId, object: 'chat.completion.chunk', created, model: ctx.modelInfo.name,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          });
          sentRole = true;
        }
        // Thinking → reasoning_content (o1/extended thinking style)
        if (chunk.thinking) {
          sse(res, {
            id: chatId, object: 'chat.completion.chunk', created, model: ctx.modelInfo.name,
            choices: [{ index: 0, delta: { reasoning_content: chunk.thinking }, finish_reason: null }],
          });
        }
        // Text → content (sanitized, tool-parsed)
        if (chunk.text) {
          const safeText = textSanitizer.feed(chunk.text);
          if (safeText) {
            if (toolParser) {
              const parsed = toolParser.feed(safeText);
              if (parsed.text) {
                fullText += parsed.text;
                sse(res, {
                  id: chatId, object: 'chat.completion.chunk', created, model: ctx.modelInfo.name,
                  choices: [{ index: 0, delta: { content: parsed.text }, finish_reason: null }],
                });
              }
              accToolCalls.push(...parsed.toolCalls);
            } else {
              fullText += safeText;
              sse(res, {
                id: chatId, object: 'chat.completion.chunk', created, model: ctx.modelInfo.name,
                choices: [{ index: 0, delta: { content: safeText }, finish_reason: null }],
              });
            }
          }
        }
      }
      // Flush sanitizer + tool parser
      const flushed = textSanitizer.flush();
      if (flushed) {
        if (toolParser) {
          const parsed = toolParser.feed(flushed);
          if (parsed.text) {
            fullText += parsed.text;
            sse(res, {
              id: chatId, object: 'chat.completion.chunk', created, model: ctx?.modelInfo?.name || body.model,
              choices: [{ index: 0, delta: { content: parsed.text }, finish_reason: null }],
            });
          }
          accToolCalls.push(...parsed.toolCalls);
          // Final flush of tool parser
          const finalParsed = toolParser.flush();
          if (finalParsed.text) {
            fullText += finalParsed.text;
            sse(res, {
              id: chatId, object: 'chat.completion.chunk', created, model: ctx?.modelInfo?.name || body.model,
              choices: [{ index: 0, delta: { content: finalParsed.text }, finish_reason: null }],
            });
          }
          accToolCalls.push(...finalParsed.toolCalls);
        } else {
          fullText += flushed;
          sse(res, {
            id: chatId, object: 'chat.completion.chunk', created, model: ctx?.modelInfo?.name || body.model,
            choices: [{ index: 0, delta: { content: flushed }, finish_reason: null }],
          });
        }
      }

      // Emit accumulated tool calls as separate SSE chunks
      for (const tc of accToolCalls) {
        sse(res, {
          id: chatId, object: 'chat.completion.chunk', created, model: ctx?.modelInfo?.name || body.model,
          choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
        });
      }

      const finishReason = accToolCalls.length > 0 ? 'tool_calls' : 'stop';
      sse(res, {
        id: chatId, object: 'chat.completion.chunk', created, model: ctx?.modelInfo?.name || body.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      });
      res.write('data: [DONE]\n\n');
      res.end();

      if (ctx) {
        const completionTokens = Math.ceil(fullText.length / 4);
        consumeQuota(ctx.authKey, ctx.promptTokens + completionTokens);
        recordRequest({ model: ctx.modelKey, channelId: ctx.channel.id, tokensUsed: ctx.promptTokens + completionTokens });
      }
    } else {
      const result = await runChatCore(chatMessages, modelKey, authKey);
      json(res, 200, {
        id: chatId, object: 'chat.completion', created, model: result.modelInfo.name,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: sanitizeText(result.text) },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: result.promptTokens,
          completion_tokens: result.completionTokens,
          total_tokens: result.promptTokens + result.completionTokens,
        },
      });
    }
  } catch (err: any) {
    if (err instanceof ChatError) {
      if (!res.headersSent) json(res, err.statusCode, { error: { message: err.message, type: 'api_error' } });
    } else {
      log.error('Chat error:', err.message);
      if (!res.headersSent) json(res, 500, { error: { message: err.message, type: 'api_error' } });
    }
    if (res.headersSent && !res.writableEnded) res.end();
  }
}
