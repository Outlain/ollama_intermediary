import assert from 'node:assert/strict';
import http from 'node:http';
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
  const { mock, proxyUrl } = await setup(t, { models: { 'od-model': { idle_hold: '0ms' } } });
  const first = requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'O1', delay_ms: 80 });
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

test('status and Prometheus endpoints expose scheduler state', async (t) => {
  const { service, proxyUrl } = await setup(t);
  const status = await (await fetch(`${proxyUrl}/status`)).json();
  assert.equal(status.backend.state, 'healthy');
  assert.equal(status.model_switches, 0);
  const metrics = await (await fetch(`${proxyUrl}/metrics`)).text();
  assert.match(metrics, /proxy_queue_depth\{client="odysseus"\} 0/);
  assert.match(metrics, /proxy_backend_healthy 1/);
  assert.equal(service.scheduler.active, null);
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
