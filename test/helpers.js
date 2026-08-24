import http from 'node:http';
import { once } from 'node:events';
import { normalizeConfig } from '../src/config.js';

export class SilentLogger {
  debug() {}
  info() {}
  warn() {}
  error() {}
}

export function testConfig(overlay = {}) {
  const base = {
    server: { listen: '127.0.0.1:0', shutdown_grace: '100ms' },
    ollama: {
      url: 'http://127.0.0.1:1',
      health_interval: '20ms',
      health_timeout: '200ms',
      request_timeout: '5s',
    },
    circuit_breaker: { failure_threshold: 2, failure_window: '1s', open_duration: '100ms' },
    clients: {
      default: {
        priority: 50, queue_limit: 20, request_ttl: '10s', max_wait: '5s', overflow_policy: 'reject',
      },
      odysseus: {
        priority: 100, queue_limit: 10, request_ttl: '30s', max_wait: '300ms',
        models: ['od-model'],
        model_policy: { idle_hold: '50ms', max_batch_requests: 8, max_batch_time: '2s', keep_alive: '750ms' },
      },
      frigate: {
        priority: 30, queue_limit: 20, request_ttl: '2s', max_wait: '500ms',
        overflow_policy: 'drop_oldest', models: ['f-model'],
        model_policy: { idle_hold: '0ms', max_batch_requests: 10, max_batch_time: '2s', keep_alive: '500ms' },
      },
    },
    models: {
      'od-model': { idle_hold: '50ms', max_batch_requests: 8, max_batch_time: '2s', keep_alive: '1s' },
      'f-model': { idle_hold: '0ms', max_batch_requests: 10, max_batch_time: '2s', keep_alive: '1s' },
    },
    scheduler: { aging_interval: '100ms', aging_bonus: 5 },
  };
  const merge = (left, right) => {
    const result = { ...left };
    for (const [key, value] of Object.entries(right)) {
      result[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? merge(left?.[key] ?? {}, value)
        : value;
    }
    return result;
  };
  return normalizeConfig(merge(base, overlay));
}

export async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export class MockOllama {
  constructor() {
    this.order = [];
    this.events = [];
    this.active = 0;
    this.maxActive = 0;
    this.loadedModel = null;
    this.failuresRemaining = 0;
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  async start() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  async stop() {
    this.server.close();
    this.server.closeAllConnections?.();
    await once(this.server, 'close').catch(() => {});
  }

  async body(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async handle(request, response) {
    const url = new URL(request.url, this.url);
    if (url.pathname === '/api/tags') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (url.pathname === '/api/ps') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: this.loadedModel ? [{ name: this.loadedModel }] : [] }));
      return;
    }
    if (url.pathname === '/api/show') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ details: { family: 'mock' } }));
      return;
    }
    if (url.pathname === '/api/chat' || url.pathname === '/api/generate' || url.pathname === '/api/embed' || url.pathname === '/v1/chat/completions') {
      const raw = await this.body(request);
      const body = JSON.parse(raw.toString() || '{}');
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      this.order.push(body.id ?? body.prompt ?? body.model);
      this.events.push(body.id ?? body.prompt ?? body.model);
      this.loadedModel = body.model;
      response.once('close', () => { this.active = Math.max(0, this.active - 1); });
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        response.statusCode = 500;
        response.end(JSON.stringify({ error: 'mock failure' }));
        return;
      }
      response.setHeader('content-type', 'application/x-ndjson');
      if (body.first_chunk_delay_ms) await new Promise((resolve) => setTimeout(resolve, body.first_chunk_delay_ms));
      response.write(`${JSON.stringify({ response: 'first', done: false })}\n`);
      if (body.delay_ms) await new Promise((resolve) => setTimeout(resolve, body.delay_ms));
      response.end(`${JSON.stringify({ response: 'second', done: true })}\n`);
      return;
    }
    const raw = await this.body(request);
    this.events.push(url.pathname);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ path: url.pathname, bytes: raw.length }));
  }
}

export async function requestJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}
