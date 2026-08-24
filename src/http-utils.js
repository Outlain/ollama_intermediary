import { isIP } from 'node:net';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export async function readBody(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      const error = new Error(`request body exceeds ${limit} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function copyRequestHeaders(headers, backendUrl, requestIdValue) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'host' && value !== undefined) result[name] = value;
  }
  result.host = new URL(backendUrl).host;
  result['x-request-id'] = requestIdValue;
  result['x-forwarded-host'] = headers.host ?? '';
  return result;
}

export function copyResponseHeaders(source, response) {
  const entries = typeof source.entries === 'function' ? source.entries() : Object.entries(source);
  for (const [name, value] of entries) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'content-length') response.setHeader(name, value);
  }
}

export function sendJson(response, status, body, requestIdValue) {
  if (response.headersSent || response.destroyed) return;
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.length,
    'x-request-id': requestIdValue,
  });
  response.end(encoded);
}

export function clientIp(request, trustedProxy = false) {
  if (trustedProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();
    if (first && isIP(first)) return first;
  }
  return request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
}

export function streamBody(upstream, downstream, { flush = false } = {}) {
  if (typeof upstream.body?.getReader !== 'function') {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        upstream.removeListener('error', finish);
        downstream.removeListener('error', finish);
        if (error) reject(error); else resolve();
      };
      upstream.on('data', (chunk) => {
        if (!downstream.write(chunk)) upstream.pause();
        if (flush && typeof downstream.flushHeaders === 'function') downstream.flushHeaders();
      });
      downstream.on('drain', () => upstream.resume());
      upstream.once('end', () => { downstream.end(); finish(); });
      upstream.once('error', finish);
      downstream.once('error', finish);
      downstream.once('close', () => {
        if (!downstream.writableEnded) upstream.destroy(new Error('downstream closed'));
      });
    });
  }
  return new Promise((resolve, reject) => {
    const reader = upstream.body?.getReader();
    if (!reader) {
      downstream.end();
      resolve();
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    };
    downstream.once('error', finish);
    downstream.once('close', () => {
      if (!downstream.writableEnded) reader.cancel('downstream closed').catch(() => {});
    });

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!downstream.write(Buffer.from(value))) {
            await new Promise((res, rej) => {
              downstream.once('drain', res);
              downstream.once('error', rej);
            });
          }
          if (flush && typeof downstream.flushHeaders === 'function') downstream.flushHeaders();
        }
        downstream.end();
        finish();
      } catch (error) {
        downstream.destroy(error);
        finish(error);
      }
    };
    pump();
  });
}
