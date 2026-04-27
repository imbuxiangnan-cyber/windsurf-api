/**
 * System routes — health, dashboard API, dashboard page.
 */

import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { isLsReady } from '../core/langserver.js';
import { listChannels, hasActiveChannels, addChannel, removeChannel, updateChannelStatus, getChannelCount } from '../services/channel.js';
import { listTokens, createToken, removeToken } from '../services/token.js';
import { getStats, getTodayStats } from '../services/stats.js';
import { windsurfLogin } from '../core/login.js';

function json(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function checkDashboardAuth(req: http.IncomingMessage): boolean {
  if (!config.dashboardPassword) return true;
  const pw = req.headers['x-dashboard-password'] || '';
  return String(pw) === config.dashboardPassword;
}

export async function handleSystemRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  const method = req.method || 'GET';

  // Health check
  if (path === '/health' && method === 'GET') {
    json(res, 200, {
      status: 'ok',
      lsReady: isLsReady(),
      channels: getChannelCount(),
      hasActive: hasActiveChannels(),
    });
    return true;
  }

  // Dashboard page
  if (path === '/dashboard' && method === 'GET') {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const htmlPath = resolve(__dirname, '..', 'dashboard', 'index.html');
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Dashboard HTML not found</h1><p>Place index.html in dashboard/ directory.</p></body></html>');
    }
    return true;
  }

  // Dashboard API — Overview
  if (path === '/dashboard/api/overview' && method === 'GET') {
    if (!checkDashboardAuth(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const stats = getStats();
    const today = getTodayStats();
    json(res, 200, {
      lsReady: isLsReady(),
      channels: listChannels(),
      totalRequests: stats.totalRequests,
      totalTokens: stats.totalTokens,
      todayRequests: today.requests,
      todayTokens: today.tokens,
    });
    return true;
  }

  // Dashboard API — Channels
  if (path === '/dashboard/api/channels' && method === 'GET') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    json(res, 200, { channels: listChannels() });
    return true;
  }

  if (path === '/dashboard/api/channels' && method === 'POST') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const body = (req as any).parsedBody;
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return true; }

    // Login with email/password or add directly with apiKey
    if (body.email && body.password) {
      try {
        const result = await windsurfLogin(body.email, body.password);
        const ch = addChannel(body.email, result.sessionToken, body.tier || 'pro');
        json(res, 200, { channel: ch });
      } catch (err: any) {
        json(res, 400, { error: err.message });
      }
    } else if (body.email && body.apiKey) {
      const ch = addChannel(body.email, body.apiKey, body.tier || 'pro');
      json(res, 200, { channel: ch });
    } else {
      json(res, 400, { error: 'Provide email+password or email+apiKey' });
    }
    return true;
  }

  // Dashboard API — Channel operations
  const channelMatch = path.match(/^\/dashboard\/api\/channels\/([^/]+)$/);
  if (channelMatch && method === 'DELETE') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const ok = removeChannel(channelMatch[1]);
    json(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Channel not found' });
    return true;
  }

  const channelStatusMatch = path.match(/^\/dashboard\/api\/channels\/([^/]+)\/status$/);
  if (channelStatusMatch && method === 'POST') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const body = (req as any).parsedBody;
    const ok = updateChannelStatus(channelStatusMatch[1], body?.status || 'active');
    json(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Channel not found' });
    return true;
  }

  // Dashboard API — Tokens
  if (path === '/dashboard/api/tokens' && method === 'GET') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    json(res, 200, { tokens: listTokens() });
    return true;
  }

  if (path === '/dashboard/api/tokens' && method === 'POST') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const body = (req as any).parsedBody;
    const token = createToken(body?.name || 'default', body?.totalQuota || 0);
    json(res, 200, { token });
    return true;
  }

  const tokenMatch = path.match(/^\/dashboard\/api\/tokens\/([^/]+)$/);
  if (tokenMatch && method === 'DELETE') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const ok = removeToken(tokenMatch[1]);
    json(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Token not found' });
    return true;
  }

  // Dashboard API — Stats
  if (path === '/dashboard/api/stats' && method === 'GET') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    json(res, 200, getStats());
    return true;
  }

  // ─── management API endpoints ───

  // GET /api/accounts — same as /dashboard/api/channels
  if (path === '/api/accounts' && method === 'GET') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    json(res, 200, { accounts: listChannels() });
    return true;
  }

  if (path === '/api/accounts' && method === 'POST') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const body = (req as any).parsedBody;
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return true; }
    if (body.email && body.password) {
      try {
        const result = await windsurfLogin(body.email, body.password);
        const ch = addChannel(body.email, result.sessionToken, body.tier || 'pro');
        json(res, 200, { account: ch });
      } catch (err: any) {
        json(res, 400, { error: err.message });
      }
    } else if (body.email && body.apiKey) {
      const ch = addChannel(body.email, body.apiKey, body.tier || 'pro');
      json(res, 200, { account: ch });
    } else {
      json(res, 400, { error: 'Provide email+password or email+apiKey' });
    }
    return true;
  }

  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && method === 'DELETE') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const ok = removeChannel(accountMatch[1]);
    json(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Account not found' });
    return true;
  }

  // GET /api/stats
  if (path === '/api/stats' && method === 'GET') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const stats = getStats();
    const today = getTodayStats();
    json(res, 200, {
      totalRequests: stats.totalRequests,
      totalTokens: stats.totalTokens,
      todayRequests: today.requests,
      todayTokens: today.tokens,
      daily: stats.daily,
    });
    return true;
  }

  // GET /api/models
  if (path === '/api/models' && method === 'GET') {
    const { listModels } = await import('../models.js');
    json(res, 200, { models: listModels() });
    return true;
  }

  // GET/PUT /api/models/mapping
  if (path === '/api/models/mapping' && method === 'GET') {
    const { getMapping } = await import('../services/routing.js');
    json(res, 200, { mapping: getMapping() });
    return true;
  }

  if (path === '/api/models/mapping' && method === 'PUT') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const body = (req as any).parsedBody;
    if (!body?.mapping) { json(res, 400, { error: 'Provide mapping object' }); return true; }
    const { setMapping, getMapping } = await import('../services/routing.js');
    setMapping(body.mapping);
    json(res, 200, { mapping: getMapping() });
    return true;
  }

  // GET/PUT /api/models/concurrency
  if (path === '/api/models/concurrency' && method === 'GET') {
    const { getConcurrencyConfig } = await import('../services/routing.js');
    json(res, 200, { concurrency: getConcurrencyConfig() });
    return true;
  }

  if (path === '/api/models/concurrency' && method === 'PUT') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const body = (req as any).parsedBody;
    if (!body?.concurrency) { json(res, 400, { error: 'Provide concurrency object' }); return true; }
    const { setConcurrencyConfig, getConcurrencyConfig } = await import('../services/routing.js');
    setConcurrencyConfig(body.concurrency);
    json(res, 200, { concurrency: getConcurrencyConfig() });
    return true;
  }

  // GET/PUT /api/models/ratelimit
  if (path === '/api/models/ratelimit' && method === 'GET') {
    const { getRateLimitConfig } = await import('../services/routing.js');
    json(res, 200, { rateLimit: getRateLimitConfig() });
    return true;
  }

  if (path === '/api/models/ratelimit' && method === 'PUT') {
    if (!checkDashboardAuth(req)) { json(res, 401, { error: 'Unauthorized' }); return true; }
    const body = (req as any).parsedBody;
    if (!body?.rateLimit) { json(res, 400, { error: 'Provide rateLimit object' }); return true; }
    const { setRateLimitConfig, getRateLimitConfig } = await import('../services/routing.js');
    setRateLimitConfig(body.rateLimit);
    json(res, 200, { rateLimit: getRateLimitConfig() });
    return true;
  }

  // GET /api/models/available
  if (path === '/api/models/available' && method === 'GET') {
    const { listModels } = await import('../models.js');
    const { getMapping } = await import('../services/routing.js');
    json(res, 200, { models: listModels(), mapping: getMapping() });
    return true;
  }

  // POST /v1/messages/count_tokens (Anthropic)
  if (path === '/v1/messages/count_tokens' && method === 'POST') {
    const body = (req as any).parsedBody;
    if (!body) { json(res, 400, { error: 'Invalid JSON' }); return true; }
    const messages = body.messages || [];
    const system = typeof body.system === 'string' ? body.system : '';
    const totalChars = system.length + messages.reduce((s: number, m: any) => {
      if (typeof m.content === 'string') return s + m.content.length;
      if (Array.isArray(m.content)) return s + m.content.reduce((a: number, b: any) => a + (b.text?.length || 0), 0);
      return s;
    }, 0);
    json(res, 200, { input_tokens: Math.ceil(totalChars / 4) });
    return true;
  }

  return false;
}
