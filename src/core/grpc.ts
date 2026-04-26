/**
 * HTTP/2 gRPC client for local Windsurf language server.
 * Connection pool with auto-reconnect and keepalive.
 */

import http2 from 'http2';

const CONNECT_TIMEOUT = 120_000;
const KEEPALIVE_INTERVAL = 30_000;
const MAX_IDLE_MS = 300_000;

export function grpcFrame(payload: Buffer): Buffer {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

export function stripGrpcFrame(buf: Buffer): Buffer {
  if (buf.length >= 5 && buf[0] === 0) {
    const msgLen = buf.readUInt32BE(1);
    if (buf.length >= 5 + msgLen) {
      return buf.subarray(5, 5 + msgLen);
    }
  }
  return buf;
}

// ─── Connection pool ────────────────────────────────────

interface PoolEntry {
  session: http2.ClientHttp2Session;
  lastUsed: number;
  keepaliveTimer: NodeJS.Timeout | null;
}

const pool: Map<number, PoolEntry> = new Map();

function getSession(port: number): http2.ClientHttp2Session {
  const existing = pool.get(port);
  if (existing && !existing.session.closed && !existing.session.destroyed) {
    existing.lastUsed = Date.now();
    return existing.session;
  }

  // Clean stale entry
  if (existing) {
    if (existing.keepaliveTimer) clearInterval(existing.keepaliveTimer);
    try { existing.session.close(); } catch { /* ignore */ }
    pool.delete(port);
  }

  const session = http2.connect(`http://localhost:${port}`, {
    settings: { enablePush: false },
  });

  session.on('error', () => {
    destroyPoolEntry(port);
  });

  session.on('goaway', () => {
    destroyPoolEntry(port);
  });

  // Keepalive ping every 30s
  const keepaliveTimer = setInterval(() => {
    if (session.closed || session.destroyed) {
      destroyPoolEntry(port);
      return;
    }
    try { session.ping(Buffer.alloc(8), () => {}); } catch { /* ignore */ }
  }, KEEPALIVE_INTERVAL);

  // Don't block process exit
  if (keepaliveTimer.unref) keepaliveTimer.unref();

  pool.set(port, { session, lastUsed: Date.now(), keepaliveTimer });
  return session;
}

function destroyPoolEntry(port: number): void {
  const entry = pool.get(port);
  if (!entry) return;
  if (entry.keepaliveTimer) clearInterval(entry.keepaliveTimer);
  try { entry.session.close(); } catch { /* ignore */ }
  try { entry.session.destroy(); } catch { /* ignore */ }
  pool.delete(port);
}

export function destroyPool(): void {
  for (const port of pool.keys()) destroyPoolEntry(port);
}

// Clean idle connections periodically
const idleCleanup = setInterval(() => {
  const now = Date.now();
  for (const [port, entry] of pool) {
    if (now - entry.lastUsed > MAX_IDLE_MS) destroyPoolEntry(port);
  }
}, 60_000);
if (idleCleanup.unref) idleCleanup.unref();

// ─── gRPC call with retry ───────────────────────────────

export function grpcUnary(
  port: number,
  csrfToken: string,
  path: string,
  body: Buffer,
  timeout = CONNECT_TIMEOUT,
): Promise<Buffer> {
  return grpcUnaryOnce(port, csrfToken, path, body, timeout).catch((err) => {
    // On connection error, destroy pool entry and retry once with fresh connection
    if (isConnectionError(err)) {
      destroyPoolEntry(port);
      return grpcUnaryOnce(port, csrfToken, path, body, timeout);
    }
    throw err;
  });
}

function isConnectionError(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('econnrefused') || msg.includes('econnreset') ||
    msg.includes('goaway') || msg.includes('socket hang up') ||
    msg.includes('stream destroyed') || err?.code === 'ERR_HTTP2_GOAWAY_SESSION';
}

function grpcUnaryOnce(
  port: number,
  csrfToken: string,
  path: string,
  body: Buffer,
  timeout: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let session: http2.ClientHttp2Session;
    try {
      session = getSession(port);
    } catch (err) {
      return reject(err);
    }

    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    timer = setTimeout(() => {
      settle(() => {
        try { req.close(); } catch { /* ignore */ }
        reject(new Error(`gRPC timeout after ${timeout}ms on ${path}`));
      });
    }, timeout);

    const req = session.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      'te': 'trailers',
      'x-codeium-csrf-token': csrfToken,
    });

    req.on('data', (chunk: Buffer) => chunks.push(chunk));

    let grpcStatus = '0', grpcMessage = '';
    req.on('trailers', (trailers: Record<string, string>) => {
      grpcStatus = String(trailers['grpc-status'] ?? '0');
      grpcMessage = String(trailers['grpc-message'] ?? '');
    });

    req.on('end', () => {
      settle(() => {
        if (grpcStatus !== '0') {
          const decoded = grpcMessage ? decodeURIComponent(grpcMessage) : '';
          const isCsrf = grpcStatus === '16' || /csrf|unauthenticated/i.test(decoded);
          const errMsg = isCsrf
            ? `invalid CSRF token (gRPC UNAUTHENTICATED) on ${path}`
            : (decoded || `gRPC status ${grpcStatus}`);
          reject(new Error(errMsg));
          return;
        }
        resolve(stripGrpcFrame(Buffer.concat(chunks)));
      });
    });

    req.on('error', (err: Error) => {
      settle(() => reject(err));
    });

    req.write(body);
    req.end();
  });
}
