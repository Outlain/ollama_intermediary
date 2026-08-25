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

function captureChunk(chunks, state, chunk, limit) {
  if (!limit || state.length >= limit) return;
  const buffer = Buffer.from(chunk);
  const remaining = limit - state.length;
  const captured = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
  chunks.push(captured);
  state.length += captured.length;
}

export function streamBody(upstream, downstream, { flush = false, drainOnClose = false, captureLimit = 0 } = {}) {
  if (typeof upstream.body?.getReader !== 'function') {
    return new Promise((resolve, reject) => {
      let settled = false;
      let downstreamOpen = !downstream.destroyed;
      let pausedForBackpressure = false;
      const captured = [];
      const captureState = { length: 0 };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        upstream.removeListener('data', onData);
        upstream.removeListener('end', onEnd);
        upstream.removeListener('error', onUpstreamError);
        downstream.removeListener('drain', onDrain);
        downstream.removeListener('error', onDownstreamError);
        downstream.removeListener('close', onDownstreamClose);
        if (error) reject(error);
        else resolve({ captured: Buffer.concat(captured), downstreamClosed: !downstreamOpen });
      };
      const onData = (chunk) => {
        captureChunk(captured, captureState, chunk, captureLimit);
        if (!downstreamOpen) return;
        if (!downstream.write(chunk)) {
          pausedForBackpressure = true;
          upstream.pause();
        }
        if (flush && typeof downstream.flushHeaders === 'function') downstream.flushHeaders();
      };
      const onDrain = () => {
        pausedForBackpressure = false;
        upstream.resume();
      };
      const onEnd = () => {
        if (downstreamOpen && !downstream.writableEnded) downstream.end();
        finish();
      };
      const onUpstreamError = (error) => finish(error);
      const stopWriting = () => {
        downstreamOpen = false;
        if (pausedForBackpressure) {
          pausedForBackpressure = false;
          upstream.resume();
        }
      };
      const onDownstreamError = (error) => {
        if (drainOnClose) stopWriting();
        else finish(error);
      };
      const onDownstreamClose = () => {
        if (downstream.writableEnded) return;
        if (drainOnClose) stopWriting();
        else upstream.destroy(new Error('downstream closed'));
      };
      upstream.on('data', onData);
      upstream.once('end', onEnd);
      upstream.once('error', onUpstreamError);
      downstream.on('drain', onDrain);
      downstream.once('error', onDownstreamError);
      downstream.once('close', onDownstreamClose);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = upstream.body?.getReader();
    if (!reader) {
      if (!downstream.destroyed) downstream.end();
      resolve({ captured: Buffer.alloc(0), downstreamClosed: downstream.destroyed });
      return;
    }
    let settled = false;
    let downstreamOpen = !downstream.destroyed;
    const captured = [];
    const captureState = { length: 0 };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ captured: Buffer.concat(captured), downstreamClosed: !downstreamOpen });
    };
    downstream.once('error', (error) => {
      if (drainOnClose) downstreamOpen = false;
      else finish(error);
    });
    downstream.once('close', () => {
      if (downstream.writableEnded) return;
      downstreamOpen = false;
      if (!drainOnClose) reader.cancel('downstream closed').catch(() => {});
    });

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          captureChunk(captured, captureState, value, captureLimit);
          if (downstreamOpen && !downstream.write(Buffer.from(value))) {
            await new Promise((res, rej) => {
              downstream.once('drain', res);
              downstream.once('close', res);
              downstream.once('error', drainOnClose ? res : rej);
            });
          }
          if (downstreamOpen && flush && typeof downstream.flushHeaders === 'function') downstream.flushHeaders();
        }
        if (downstreamOpen && !downstream.writableEnded) downstream.end();
        finish();
      } catch (error) {
        if (downstreamOpen) downstream.destroy(error);
        finish(error);
      }
    };
    pump();
  });
}
