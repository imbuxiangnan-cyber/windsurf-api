/**
 * HTTP server — route dispatcher with request logging.
 */

import http from 'http';
import { log } from './config.js';
import { handleApiRoutes } from './routes/api.js';
import { handleSystemRoutes } from './routes/system.js';

function formatTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function startServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    try {
      const method = req.method || 'GET';
      const fullUrl = req.url || '/';
      const path = fullUrl.split('?')[0];

      // Parse POST/PUT body
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        await new Promise<void>(resolve => req.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          try {
            (req as any).parsedBody = JSON.parse(bodyStr);
          } catch { /* not JSON */ }
          resolve();
        }));
      }

      // Extract model name for logging (from parsed body)
      const model = (req as any).parsedBody?.model || '';
      const logPrefix = model ? `[${model}]` : '';

      // Request log — incoming
      if (path.startsWith('/v1/')) {
        log.info(`${logPrefix} ${formatTime()} <-- ${method} ${fullUrl}`);
      }

      // CORS
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-dashboard-password, anthropic-version',
        });
        return res.end();
      }

      // Routes
      if (await handleSystemRoutes(req, res, path)) {
        logResponse(logPrefix, method, fullUrl, res.statusCode, startTime, path);
        return;
      }
      if (await handleApiRoutes(req, res, path)) {
        logResponse(logPrefix, method, fullUrl, res.statusCode, startTime, path);
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: `${method} ${path} not found` }));
    } catch (err: any) {
      log.error('Handler error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`Server listening on http://0.0.0.0:${port}`);
    log.info('Endpoints:');
    log.info('  POST /v1/chat/completions   (OpenAI compatible)');
    log.info('  POST /v1/messages           (Anthropic compatible)');
    log.info('  GET  /v1/models');
    log.info('  GET  /health');
    log.info('  GET  /dashboard');
    log.info('Management:');
    log.info('  GET  /api/accounts          Account management');
    log.info('  GET  /api/stats             Usage statistics');
    log.info('  GET  /api/models/mapping    Model name mapping');
    log.info('  GET  /api/models/concurrency');
  });

  return server;
}

function logResponse(prefix: string, method: string, url: string, status: number, startTime: number, path: string): void {
  if (!path.startsWith('/v1/')) return;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`${prefix} ${formatTime()} --> ${method} ${url} ${status} ${elapsed}s`);
}
