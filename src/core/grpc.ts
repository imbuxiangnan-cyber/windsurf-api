/**
 * HTTP/2 gRPC client for local Windsurf language server.
 */

import http2 from 'http2';

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

export function grpcUnary(
  port: number,
  csrfToken: string,
  path: string,
  body: Buffer,
  timeout = 30000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`http://localhost:${port}`);
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout;

    client.on('error', (err) => {
      clearTimeout(timer);
      client.close();
      reject(err);
    });

    timer = setTimeout(() => {
      client.close();
      reject(new Error('gRPC unary timeout'));
    }, timeout);

    const req = client.request({
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
      clearTimeout(timer);
      client.close();
      if (grpcStatus !== '0') {
        reject(new Error(grpcMessage ? decodeURIComponent(grpcMessage) : `gRPC status ${grpcStatus}`));
        return;
      }
      resolve(stripGrpcFrame(Buffer.concat(chunks)));
    });

    req.on('error', (err: Error) => {
      clearTimeout(timer);
      client.close();
      reject(err);
    });

    req.write(body);
    req.end();
  });
}
