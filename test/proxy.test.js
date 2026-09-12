import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProxyService } from '../src/proxy.js';
import { MockOllama, requestJson, SilentLogger, testConfig, waitFor } from './helpers.js';

async function setup(t, overlay = {}) {
  const mock = new MockOllama();
  const backendUrl = await mock.start();
  const config = testConfig({ ollama: { url: backendUrl }, ...overlay });
  const service = new ProxyService(config, { logger: new SilentLogger() });
  await service.start();
  t.after(async () => {
    await service.stop(20);
    await mock.stop();
  });
  await waitFor(() => service.backend.canDispatch());
  const address = service.addresses()[0].address;
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  return { mock, service, proxyUrl };
}

test('O1 F1 O2 F2 O3 is grouped by current model instead of global FIFO', async (t) => {
  const { mock, proxyUrl } = await setup(t, {
    models: { 'od-model': { idle_hold: '0ms' } },
    clients: { odysseus: { max_wait: '5s' }, frigate: { max_wait: '5s' } },
  });
  // Keep O1 active long enough for all four concurrent HTTP connections to be
  // admitted even on a loaded CI worker.
  const first = requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'O1', delay_ms: 500 });
  await waitFor(() => mock.order.includes('O1'));
  const requests = [
    requestJson(`${proxyUrl}/api/generate`, { model: 'f-model', id: 'F1' }),
    requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'O2' }),
    requestJson(`${proxyUrl}/api/generate`, { model: 'f-model', id: 'F2' }),
    requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'O3' }),
  ];
  const responses = await Promise.all([first, ...requests]);
  await Promise.all(responses.map((response) => response.text()));
  assert.deepEqual(mock.order, ['O1', 'O2', 'O3', 'F1', 'F2']);
});

test('streaming bytes are forwarded before the complete model response', async (t) => {
  const { proxyUrl } = await setup(t);
  const started = Date.now();
  const response = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'stream', delay_ms: 180 });
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstAt = Date.now() - started;
  assert.match(Buffer.from(first.value).toString(), /first/);
  assert.ok(firstAt < 150, `first chunk took ${firstAt}ms`);
  let done = first.done;
  while (!done) ({ done } = await reader.read());
  assert.ok(Date.now() - started >= 170);
});

test('only one generation request reaches Ollama at a time', async (t) => {
  const { mock, proxyUrl } = await setup(t, { models: { 'od-model': { idle_hold: '0ms' }, 'f-model': { idle_hold: '0ms' } } });
  const requests = Array.from({ length: 6 }, (_, index) => requestJson(`${proxyUrl}/api/chat`, {
    model: index % 2 ? 'f-model' : 'od-model', id: `R${index}`, delay_ms: 30,
  }));
  const responses = await Promise.all(requests);
  await Promise.all(responses.map((response) => response.text()));
  assert.equal(mock.maxActive, 1);
});

test('repeated backend HTTP failures open the circuit breaker', async (t) => {
  const { mock, service, proxyUrl } = await setup(t);
  mock.failuresRemaining = 2;
  const first = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'fail-1' });
  await first.text();
  const second = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'fail-2' });
  await second.text();
  assert.equal(first.status, 500);
  assert.equal(second.status, 500);
  assert.equal(service.backend.circuitOpen(), true);
});

test('metadata calls pass through while a generation is active', async (t) => {
  const { mock, proxyUrl } = await setup(t);
  const generation = requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'slow', delay_ms: 200 });
  await waitFor(() => mock.active === 1);
  const started = Date.now();
  const metadata = await fetch(`${proxyUrl}/api/show`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'od-model' }),
  });
  assert.equal(metadata.status, 200);
  assert.ok(Date.now() - started < 120);
  await metadata.text();
  await (await generation).text();
});

test('model management runs exclusively at the next inference boundary', async (t) => {
  const { mock, proxyUrl } = await setup(t, { models: { 'od-model': { idle_hold: '0ms' } } });
  const first = requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'O1', delay_ms: 120 });
  await waitFor(() => mock.active === 1);
  const second = requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'O2' });
  const management = fetch(`${proxyUrl}/api/pull`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'new-model' }),
  });
  const responses = await Promise.all([first, second, management]);
  await Promise.all(responses.map((response) => response.text()));
  assert.ok(mock.events.indexOf('/api/pull') > mock.events.indexOf('O1'));
  assert.ok(mock.events.indexOf('/api/pull') < mock.events.indexOf('O2'));
});

test('maintenance pause drains active work, fails queues, unloads models, and resumes safely', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-intermediary-proxy-pause-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { mock, service, proxyUrl } = await setup(t, {
    models: { 'od-model': { idle_hold: '0ms' }, 'f-model': { idle_hold: '0ms' } },
    maintenance: {
      enabled: true,
      auth_token: 'maintenance-secret',
      max_pause: '2h',
      state_path: path.join(directory, 'maintenance.json'),
    },
  });

  // Leave enough margin for the negative/auth/persistence checks below while
  // keeping a real upstream request active for the eventual pause transition.
  const active = requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'active-before-pause', delay_ms: 1_200 });
  await waitFor(() => service.scheduler.active?.model === 'od-model');
  const queued = requestJson(`${proxyUrl}/api/generate`, { model: 'f-model', id: 'queued-before-pause' });
  await waitFor(() => service.scheduler.status().queues.frigate === 1);

  assert.equal((await fetch(`${proxyUrl}/_intermediary/v1/maintenance/pause`, { method: 'POST' })).status, 401);
  const invalidPause = await fetch(`${proxyUrl}/_intermediary/v1/maintenance/pause`, {
    method: 'POST',
    headers: { authorization: 'Bearer maintenance-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ duration: '0s' }),
  });
  assert.equal(invalidPause.status, 400);
  assert.equal(service.scheduler.status().queues.frigate, 1);
  assert.equal(service.maintenance.status().state, 'running');

  const persist = service.maintenance.persist.bind(service.maintenance);
  service.maintenance.persist = async () => { throw new Error('mock state volume failure'); };
  const failedPause = await fetch(`${proxyUrl}/_intermediary/v1/maintenance/pause`, {
    method: 'POST',
    headers: { authorization: 'Bearer maintenance-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'must not mutate admission' }),
  });
  service.maintenance.persist = persist;
  assert.equal(failedPause.status, 500);
  assert.equal(service.scheduler.status().queues.frigate, 1);
  assert.equal(service.maintenance.status().state, 'running');

  const pause = await fetch(`${proxyUrl}/_intermediary/v1/maintenance/pause`, {
    method: 'POST',
    headers: { authorization: 'Bearer maintenance-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ duration: '1h', reason: 'exclusive renderer' }),
  });
  const pauseBody = await pause.json();
  assert.equal(pause.status, 202);
  assert.equal(pauseBody.maintenance.state, 'pausing');
  assert.equal(pauseBody.maintenance.gpu_released, false);

  const queuedResponse = await queued;
  assert.equal(queuedResponse.status, 503);
  assert.equal((await queuedResponse.json()).code, 'maintenance_paused');
  const rejected = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'rejected-during-pause' });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).code, 'maintenance_paused');
  assert.equal(mock.order.includes('rejected-during-pause'), false);

  assert.equal((await fetch(`${proxyUrl}/api/tags`)).status, 200);
  assert.equal((await fetch(`${proxyUrl}/api/pull`, { method: 'POST', body: '{}' })).status, 503);
  assert.equal((await fetch(`${proxyUrl}/api/future-gpu-endpoint`, { method: 'POST', body: '{}' })).status, 503);

  await (await active).text();
  await waitFor(() => service.maintenance.status().state === 'paused');
  const maintenance = service.maintenance.status();
  assert.equal(maintenance.gpu_released, true);
  assert.equal(mock.loadedModel, null);
  assert.ok(maintenance.resume_at);
  assert.equal((await fetch(`${proxyUrl}/readyz`)).status, 503);

  const stillPaused = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'retry-later' });
  assert.equal(stillPaused.status, 503);
  assert.ok(Number(stillPaused.headers.get('retry-after')) > 0);
  await stillPaused.text();

  assert.equal((await fetch(`${proxyUrl}/_intermediary/v1/maintenance/resume`, { method: 'POST' })).status, 401);
  const resume = await fetch(`${proxyUrl}/_intermediary/v1/maintenance/resume`, {
    method: 'POST', headers: { authorization: 'Bearer maintenance-secret' },
  });
  assert.equal(resume.status, 200);
  assert.equal((await resume.json()).maintenance.state, 'running');
  const after = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'after-maintenance' });
  assert.equal(after.status, 200);
  await after.text();
});

test('queued HTTP client disconnect is removed before dispatch', async (t) => {
  const { mock, service, proxyUrl } = await setup(t);
  const active = requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'active', delay_ms: 180 });
  await waitFor(() => mock.active === 1);
  const target = new URL('/api/generate', proxyUrl);
  const queued = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json' } });
  queued.on('error', () => {});
  queued.end(JSON.stringify({ model: 'f-model', id: 'disconnected' }));
  await waitFor(() => service.scheduler.status().queues.frigate === 1);
  queued.destroy();
  await waitFor(() => service.scheduler.status().queues.frigate === 0);
  await (await active).text();
  assert.equal(mock.order.includes('disconnected'), false);
});

test('active client disconnect drains Ollama before the next request dispatches', async (t) => {
  const { mock, service, proxyUrl } = await setup(t, {
    models: { 'od-model': { idle_hold: '0ms' }, 'f-model': { idle_hold: '0ms' } },
  });
  const target = new URL('/api/generate', proxyUrl);
  const abandoned = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json' } });
  abandoned.on('error', () => {});
  abandoned.end(JSON.stringify({ model: 'od-model', id: 'abandoned', first_chunk_delay_ms: 80, delay_ms: 120 }));
  await waitFor(() => mock.active === 1);
  abandoned.destroy();
  await waitFor(() => service.scheduler.status().upstream_draining === true);

  const nextPromise = requestJson(`${proxyUrl}/api/generate`, { model: 'f-model', id: 'after-drain' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(mock.order.includes('after-drain'), false);

  const next = await nextPromise;
  await next.text();
  await waitFor(() => service.scheduler.active === null);
  assert.deepEqual(mock.order, ['abandoned', 'after-drain']);
  assert.ok(mock.events.includes('unload:od-model'));
  assert.equal(mock.maxActive, 1);
  assert.equal(service.scheduler.status().upstream_draining, false);
});

test('streaming client disconnect drains the remaining upstream response', async (t) => {
  const { mock, service, proxyUrl } = await setup(t);
  const target = new URL('/api/generate', proxyUrl);
  let markDisconnected;
  const disconnected = new Promise((resolve) => { markDisconnected = resolve; });
  const abandoned = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json' } });
  abandoned.on('error', () => {});
  abandoned.on('response', (incoming) => {
    incoming.once('data', () => {
      incoming.destroy();
      markDisconnected();
    });
  });
  abandoned.end(JSON.stringify({ model: 'od-model', id: 'stream-abandoned', delay_ms: 140, stream: true }));
  await disconnected;
  await waitFor(() => service.scheduler.status().upstream_draining === true);

  const nextPromise = requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'after-stream-drain' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(mock.order.includes('after-stream-drain'), false);
  const next = await nextPromise;
  await next.text();
  assert.deepEqual(mock.order, ['stream-abandoned', 'after-stream-drain']);
  assert.equal(mock.maxActive, 1);
});

test('a model switch unloads and confirms the previous model before dispatch', async (t) => {
  const { mock, proxyUrl } = await setup(t, {
    models: { 'od-model': { idle_hold: '0ms' }, 'f-model': { idle_hold: '0ms' } },
  });
  const first = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'first-model' });
  await first.text();
  const second = await requestJson(`${proxyUrl}/api/generate`, { model: 'f-model', id: 'second-model' });
  await second.text();
  assert.ok(mock.events.indexOf('unload:od-model') > mock.events.indexOf('first-model'));
  assert.ok(mock.events.indexOf('unload:od-model') < mock.events.indexOf('second-model'));
});

test('one ROCm OOM latches recovery and rejects subsequent inference', async (t) => {
  const { mock, service, proxyUrl } = await setup(t);
  mock.failureMessage = 'ROCm error: out of memory';
  mock.failuresRemaining = 1;
  const failed = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'gpu-oom' });
  assert.equal(failed.status, 500);
  await failed.text();
  await waitFor(() => service.backend.recoveryRequired);

  const ready = await fetch(`${proxyUrl}/readyz`);
  const readyBody = await ready.json();
  assert.equal(ready.status, 503);
  assert.equal(readyBody.backend.state, 'recovery_required');

  const rejected = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'must-not-dispatch' });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).code, 'gpu_recovery_required');
  assert.equal(mock.order.includes('must-not-dispatch'), false);

  const status = await (await fetch(`${proxyUrl}/status`)).json();
  assert.equal(status.backend.recovery_required, true);
  assert.match(status.backend.recovery_reason, /ROCm error: out of memory/i);
  const metrics = await (await fetch(`${proxyUrl}/metrics`)).text();
  assert.match(metrics, /proxy_gpu_recovery_required 1/);
  assert.match(metrics, /proxy_gpu_recovery_required_total 1/);
});

test('an unconfirmed model unload suspends inference instead of risking overlap', async (t) => {
  const { mock, service, proxyUrl } = await setup(t, {
    models: { 'od-model': { idle_hold: '0ms' }, 'f-model': { idle_hold: '0ms' } },
  });
  const first = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'before-unload-failure' });
  await first.text();
  mock.unloadFailuresRemaining = 1;
  const second = await requestJson(`${proxyUrl}/api/generate`, { model: 'f-model', id: 'blocked-switch' });
  assert.equal(second.status, 503);
  assert.equal((await second.json()).code, 'gpu_recovery_required');
  assert.equal(mock.order.includes('blocked-switch'), false);
  assert.equal(service.backend.recoveryRequired, true);
});

test('status and Prometheus endpoints expose scheduler state', async (t) => {
  const { service, proxyUrl } = await setup(t);
  const status = await (await fetch(`${proxyUrl}/status`)).json();
  assert.equal(status.backend.state, 'healthy');
  assert.equal(status.model_switches, 0);
  const metrics = await (await fetch(`${proxyUrl}/metrics`)).text();
  assert.match(metrics, /proxy_queue_depth\{client="odysseus"\} 0/);
  assert.match(metrics, /proxy_backend_healthy 1/);
  assert.match(metrics, /proxy_gpu_recovery_required 0/);
  assert.match(metrics, /proxy_upstream_draining 0/);
  assert.match(metrics, /proxy_maintenance_paused 0/);
  assert.match(metrics, /proxy_maintenance_gpu_released 0/);
  assert.equal(service.scheduler.active, null);
});

test('detailed observability status shows safe active and queued request metadata', async (t) => {
  const { service, proxyUrl } = await setup(t, {
    models: { 'od-model': { idle_hold: '0ms' }, 'f-model': { idle_hold: '0ms' } },
  });
  const active = requestJson(`${proxyUrl}/api/chat`, {
    model: 'od-model', id: 'active-observed', messages: [{ role: 'user', content: 'private question' }], delay_ms: 180,
  }, { 'x-request-id': 'private-request-id' });
  await waitFor(() => service.scheduler.active?.model === 'od-model');
  const queued = requestJson(`${proxyUrl}/api/generate`, {
    model: 'f-model', id: 'queued-observed', prompt: 'another secret', stream: false,
  });
  await waitFor(() => service.scheduler.status().queues.frigate === 1);

  const response = await fetch(`${proxyUrl}/_intermediary/v1/status`);
  const status = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(status.schema_version, 1);
  assert.equal(status.service.state, 'ready');
  assert.equal(status.scheduler.state, 'busy');
  assert.equal(status.active_request.client, 'odysseus');
  assert.equal(status.active_request.type, 'chat');
  assert.equal(status.active_request.request.message_count, 1);
  assert.equal(status.active_request.request.input_characters, 16);
  assert.equal(status.queue.total, 1);
  assert.equal(status.queue.by_client.frigate, 1);
  assert.equal(status.queue.items[0].type, 'generate');
  assert.match(status.active_request.id, /^r-\d+$/);
  assert.doesNotMatch(JSON.stringify(status), /private question|another secret|private-request-id/);

  const legacyStatus = await (await fetch(`${proxyUrl}/status`)).json();
  assert.match(legacyStatus.active_request_id, /^r-\d+$/);
  assert.doesNotMatch(JSON.stringify(legacyStatus), /private-request-id/);

  await (await active).text();
  await (await queued).text();
});

test('observability bearer authentication rejects missing, query, and incorrect tokens', async (t) => {
  const { proxyUrl } = await setup(t, { observability: { auth_token: 'correct-token' } });
  assert.equal((await fetch(`${proxyUrl}/_intermediary/v1/status`)).status, 401);
  assert.equal((await fetch(`${proxyUrl}/_intermediary/v1/status?token=correct-token`)).status, 401);
  assert.equal((await fetch(`${proxyUrl}/_intermediary/v1/status`, {
    headers: { authorization: 'Bearer wrong-token' },
  })).status, 401);
  const authorized = await fetch(`${proxyUrl}/_intermediary/v1/status`, {
    headers: { authorization: 'Bearer correct-token' },
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).schema_version, 1);
});

test('dashboard assets are same-origin, secured, and contain no external dependencies', async (t) => {
  const { mock, proxyUrl } = await setup(t);
  const dashboard = await fetch(`${proxyUrl}/debug`);
  const html = await dashboard.text();
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(dashboard.headers.get('x-frame-options'), 'DENY');
  assert.match(html, /Ollama Intermediary/i);
  assert.doesNotMatch(html, /https?:\/\//);

  const script = await fetch(`${proxyUrl}/_intermediary/ui/dashboard.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /text\/javascript/);
  assert.doesNotMatch(await script.text(), /https?:\/\//);

  const before = mock.events.length;
  const reserved = await fetch(`${proxyUrl}/_intermediary/v1/not-real`, { method: 'POST' });
  assert.equal(reserved.status, 405);
  assert.equal(mock.events.length, before);
});

test('history contains bounded lifecycle metadata and Ollama usage without response text', async (t) => {
  const { service, proxyUrl } = await setup(t, { observability: { history_limit: 8, recent_events: 4 } });
  const response = await requestJson(`${proxyUrl}/api/generate`, {
    model: 'od-model', id: 'history-request', prompt: 'never retain this prompt', stream: true,
  });
  await response.text();
  await waitFor(() => service.scheduler.active === null);
  const historyResponse = await fetch(`${proxyUrl}/_intermediary/v1/history?limit=8`);
  const history = await historyResponse.json();
  const completed = history.events.find((event) => event.type === 'request_completed');
  assert.equal(historyResponse.status, 200);
  assert.equal(historyResponse.headers.get('cache-control'), 'no-store');
  assert.ok(history.events.length <= 8);
  assert.equal(completed.response.prompt_tokens, 12);
  assert.equal(completed.response.output_tokens, 4);
  assert.equal(completed.response.output_tokens_per_second, 4);
  assert.doesNotMatch(JSON.stringify(history), /never retain this prompt|"response":"first"|"response":"second"/);
});

test('authorized live event stream sends a snapshot and releases its subscriber on close', async (t) => {
  const { service, proxyUrl } = await setup(t, { observability: { auth_token: 'stream-token' } });
  const controller = new AbortController();
  const stream = await fetch(`${proxyUrl}/_intermediary/v1/events`, {
    headers: { authorization: 'Bearer stream-token' },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const first = await reader.read();
  const text = Buffer.from(first.value).toString('utf8');
  assert.match(text, /event: snapshot/);
  assert.match(text, /"schema_version":1/);
  controller.abort();
  await reader.cancel().catch(() => {});
  await waitFor(() => service.observability.listeners.size === 0);
});

test('a backpressured live event stream is destroyed and released from connection limits', () => {
  const service = new ProxyService(testConfig(), { logger: new SilentLogger() });
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.writeHead = () => {};
  response.flushHeaders = () => {};
  response.write = () => false;
  response.end = () => { response.writableEnded = true; };
  response.destroy = () => {
    response.destroyed = true;
    response.emit('close');
  };

  service.handleEventStream(request, response, 'test-request');

  assert.equal(response.destroyed, true);
  assert.equal(service.eventStreams.size, 0);
  assert.equal(service.observability.listeners.size, 0);
});

test('configured keep_alive is normalized before Ollama receives a request', async (t) => {
  const { mock, proxyUrl } = await setup(t);
  let received;
  const original = mock.handle.bind(mock);
  mock.handle = async (request, response) => {
    if (request.url === '/api/generate') {
      const raw = await mock.body(request);
      received = JSON.parse(raw.toString());
      mock.order.push(received.id);
      mock.loadedModel = received.model;
      response.end(JSON.stringify({ done: true }));
      return;
    }
    return original(request, response);
  };
  const response = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'keepalive', keep_alive: '99h', stream: false });
  await response.text();
  assert.equal(received.keep_alive, '1s');
});

test('an unregistered model uses client-wide policy without a model mapping update', async (t) => {
  const { mock, proxyUrl } = await setup(t, { models: {} });
  let received;
  const original = mock.handle.bind(mock);
  mock.handle = async (request, response) => {
    if (request.url === '/api/generate') {
      const raw = await mock.body(request);
      received = JSON.parse(raw.toString());
      mock.order.push(received.id);
      mock.loadedModel = received.model;
      response.end(JSON.stringify({ done: true }));
      return;
    }
    return original(request, response);
  };
  const response = await requestJson(`${proxyUrl}/api/generate`, {
    model: 'newly-downloaded-odysseus-model:latest', id: 'dynamic-model', stream: false,
  }, { 'x-ollama-client': 'odysseus' });
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(received.model, 'newly-downloaded-odysseus-model:latest');
  assert.equal(received.keep_alive, '750ms');
});

test('idle graceful shutdown does not wait for the full grace period', async () => {
  const mock = new MockOllama();
  const backendUrl = await mock.start();
  const service = new ProxyService(testConfig({
    server: { shutdown_grace: '2s' },
    ollama: { url: backendUrl },
  }), { logger: new SilentLogger() });
  await service.start();
  await waitFor(() => service.backend.canDispatch());
  const started = Date.now();
  await service.stop();
  const elapsed = Date.now() - started;
  await mock.stop();
  assert.ok(elapsed < 500, `idle shutdown took ${elapsed}ms`);
});
