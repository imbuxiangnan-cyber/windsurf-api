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

export async function runChatCore(
  messages: any[],
  modelKey: string,
  authKey: string,
): Promise<ChatResult> {
  const tokenCheck = validateToken(authKey);
  if (!tokenCheck.valid) {
    throw new ChatError(tokenCheck.error || 'Unauthorized', 401);
  }

  const modelInfo = getModelInfo(modelKey);
  if (!modelInfo) {
    throw new ChatError(`Model "${modelKey}" not found`, 404);
  }

  if (tokenCheck.token && !isModelAllowedForToken(tokenCheck.token, modelKey)) {
    throw new ChatError(`Model "${modelKey}" not allowed for this key`, 403);
  }

  const ch = pickChannel();
  if (!ch) {
    throw new ChatError('All channels busy or in error state', 429);
  }

  try {
    const client = new WindsurfClient(ch.apiKey, getLsPort(), getCsrfToken());
    const gen = client.streamChat(messages, modelInfo.enumValue, modelInfo.modelUid!);

    let fullText = '';
    let fullThinking = '';
    for await (const chunk of gen) {
      if (chunk.text) fullText += chunk.text;
      if (chunk.thinking) fullThinking += chunk.thinking;
    }

    const { promptTokens, completionTokens, tokensUsed } = computeUsage(messages, fullText);
    markChannelSuccess(ch.apiKey);
    consumeQuota(authKey, tokensUsed);
    recordRequest({ model: modelKey, channelId: ch.id, tokensUsed });

    return {
      text: fullText, thinking: fullThinking,
      modelInfo, modelKey, channel: ch, authKey,
      promptTokens, completionTokens,
    };
  } catch (err: any) {
    markChannelError(ch.apiKey);
    throw err;
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

    const result = await runChatCore(body.messages, modelKey, authKey);
    const stream = !!body.stream;
    const chatId = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 20);
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      sse(res, {
        id: chatId, object: 'chat.completion.chunk', created, model: result.modelInfo.name,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });
      sse(res, {
        id: chatId, object: 'chat.completion.chunk', created, model: result.modelInfo.name,
        choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
      });
      sse(res, {
        id: chatId, object: 'chat.completion.chunk', created, model: result.modelInfo.name,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      json(res, 200, {
        id: chatId, object: 'chat.completion', created, model: result.modelInfo.name,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.text },
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
      json(res, err.statusCode, { error: { message: err.message, type: 'api_error' } });
    } else {
      log.error('Chat error:', err.message);
      json(res, 500, { error: { message: err.message, type: 'api_error' } });
    }
  }
}
