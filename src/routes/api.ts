/**
 * API routes — OpenAI/Anthropic compatible endpoints.
 */

import http from 'http';
import { listModels, listAnthropicModels } from '../models.js';
import { handleChatCompletion } from '../services/chat.js';
import { handleAnthropicMessage } from '../services/anthropic.js';
import { handleCountTokens } from '../services/count-tokens.js';
import { hasActiveChannels } from '../services/channel.js';
import { isLsReady } from '../core/langserver.js';

function json(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function getAuthKey(req: http.IncomingMessage): string | null {
  const auth = req.headers['authorization'] || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  const xApiKey = req.headers['x-api-key'];
  return xApiKey ? String(xApiKey) : null;
}

export async function handleApiRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  const method = req.method || 'GET';

  // GET /v1/models
  if (path === '/v1/models' && method === 'GET') {
    const ua = String(req.headers['user-agent'] || '');
    if (ua.startsWith('claude-cli') || ua.includes('claude-code')) {
      json(res, 200, listAnthropicModels());
    } else {
      json(res, 200, { object: 'list', data: listModels() });
    }
    return true;
  }

  // POST /v1/chat/completions
  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!isLsReady()) {
      json(res, 503, { error: { message: 'Language server not ready', type: 'server_error' } });
      return true;
    }
    if (!hasActiveChannels()) {
      json(res, 503, { error: { message: 'No active channels. Add an account first.', type: 'server_error' } });
      return true;
    }
    const authKey = getAuthKey(req) || 'anonymous';
    const body = (req as any).parsedBody;
    if (!body) {
      json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
      return true;
    }
    await handleChatCompletion(req, res, body, authKey);
    return true;
  }

  // POST /v1/messages/count_tokens (Claude Code token counting)
  if (path === '/v1/messages/count_tokens' && method === 'POST') {
    const body = (req as any).parsedBody;
    if (!body) {
      json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
      return true;
    }
    await handleCountTokens(req, res, body);
    return true;
  }

  // POST /v1/messages (Anthropic) — also match with ?beta= query
  if (path === '/v1/messages' && method === 'POST') {
    if (!isLsReady()) {
      json(res, 503, { type: 'error', error: { type: 'api_error', message: 'Language server not ready' } });
      return true;
    }
    if (!hasActiveChannels()) {
      json(res, 503, { type: 'error', error: { type: 'api_error', message: 'No active channels' } });
      return true;
    }
    const body = (req as any).parsedBody;
    if (!body) {
      json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
      return true;
    }
    await handleAnthropicMessage(req, res, body);
    return true;
  }

  return false;
}
