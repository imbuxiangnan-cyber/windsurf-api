/**
 * HTTP server — route dispatcher.
 */

import http from 'http';
import { log } from './config.js';
import { handleApiRoutes } from './routes/api.js';
import { handleSystemRoutes } from './routes/system.js';

export function startServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const path = req.url?.split('?')[0] || '/';

      // Parse POST body
      if (method === 'POST') {
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

      // CORS
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-dashboard-password, anthropic-version',
        });
        return res.end();
      }

      // Routes
      if (await handleSystemRoutes(req, res, path)) return;
      if (await handleApiRoutes(req, res, path)) return;

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
  });

  return server;
}
