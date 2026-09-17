import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProxyService } from '../src/proxy.js';
import { MockOllama, requestJson, SilentLogger, testConfig, waitFor } from './helpers.js';

test('native failure advances immediately and delayed saves pipeline within a bounded single-GPU flow', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frigate-pipeline-'));
  const mock = new MockOllama();
  const backendUrl = await mock.start();
  const config = testConfig({ ollama: { url: backendUrl }, frigate: {
    enabled: true, url: 'http://frigate.test:5000', state_path: path.join(directory, 'backlog.json'),
    max_verifying: 2, confirmation_interval: '1s', live_grace: '0s', retry_interval: '1h', max_retry_interval: '5h',
  } });
  const service = new ProxyService(config, { logger: new SilentLogger() });
  const worker = service.catchup;
  worker.client.close();
  const ids = ['fails', 'save-a', 'save-b', 'save-c'];
  const rows = new Map(ids.map((id, i) => [id, {
    id, camera: 'yard', start_time: 100 - i, end_time: 101 - i, label: 'person', data: {},
  }]));
  const calls = [];
  const tickets = [];
  const errors = [];
  const tasks = [];
  const cameraConfig = {
    genai: { local: { provider: 'ollama', roles: ['descriptions'] } },
    cameras: { yard: { enabled: true, objects: { genai: { enabled: true, use_snapshot: false } } } },
  };
  let proxyUrl;
  worker.client = {
    capabilities: async () => ({ object: true, review: true, bridge: true }),
    getConfig: async () => cameraConfig,
    list: async () => [],
    get: async (_kind, id) => structuredClone(rows.get(id)),
    hasMedia: async () => true,
    close() {},
    regenerate: async (_kind, id, _source, ticket) => {
      calls.push(id);
      tickets.push(ticket);
      const native = async () => {
        const response = await requestJson(`${proxyUrl}/api/generate`, { model: 'f-model', id, delay_ms: 20 }, {
          'x-ollama-intermediary-attempt': ticket,
        });
        await response.text();
        const report = await requestJson(`${proxyUrl}/_intermediary/v1/frigate/attempt`, {
          outcome: response.ok ? 'success' : 'failed', reason: response.ok ? 'generation_finished' : 'generation_failed',
        }, { 'x-ollama-intermediary-attempt': ticket });
        assert.equal(report.status, 202);
        await report.text();
      };
      tasks.push(native().catch((error) => errors.push(error)));
      return { accepted: true };
    },
  };
  const original = mock.handle.bind(mock);
  mock.handle = async (request, response) => {
    if (request.url === '/api/generate' && calls.at(-1) === 'fails') {
      await mock.body(request);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'request exceeds context size' }));
      return;
    }
    return original(request, response);
  };
  t.after(async () => {
    await service.stop(100);
    await Promise.all(tasks);
    await mock.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await service.start();
  proxyUrl = `http://127.0.0.1:${service.addresses()[0].address.port}`;
  await waitFor(() => service.backend.canDispatch() && worker.capabilities.checked);
  worker.state.jobs = ids.map((id, i) => ({
    id, kind: 'object', camera: 'yard', event_time: 100 - i, state: 'pending', attempts: 0,
    failures: 0, created_at: Date.now(), first_failed_at: null, last_attempt_at: null, next_attempt_at: 0,
  }));
  worker.persist();
  await worker.processJobs();
  await waitFor(() => worker.status().verifying_count === 2, 8_000);
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, ['fails', 'save-a', 'save-b']);
  assert.equal(worker.state.jobs.find((job) => job.id === 'fails').state, 'retrying');
  assert.equal(worker.state.jobs.find((job) => job.id === 'fails').reason, 'http_400');
  assert.equal(worker.status().active_job, null);
  assert.equal(mock.maxActive, 1);
  await worker.processJobs();
  assert.equal(worker.status().scan.blocked_reason, 'verification_capacity_reached');
  assert.equal(calls.length, 3);
  // Saving one description opens a verification slot; the other need not save
  // first. A successful HTTP/native result alone never increments completion.
  assert.equal(worker.status().totals.completed, 0);
  rows.get('save-a').data.description = 'A saved description';
  await worker.processJobs();
  await waitFor(() => calls.includes('save-c'));
  await waitFor(() => worker.status().verifying_count === 2, 8_000);
  assert.equal(worker.status().totals.completed, 1);
  assert.equal(mock.maxActive, 1);
  assert.deepEqual(errors, []);
  const persisted = fs.readFileSync(config.frigate.state_path, 'utf8');
  const publicState = JSON.stringify(worker.status());
  for (const ticket of tickets) {
    assert.ok(!persisted.includes(ticket), 'only ticket hashes are persisted');
    assert.ok(!publicState.includes(ticket), 'tickets never enter dashboard state');
  }
  assert.doesNotMatch(publicState, /ticket_hash|A saved description/);
  const stale = await requestJson(`${proxyUrl}/api/generate`, { model: 'f-model', id: 'late' }, {
    'x-ollama-intermediary-attempt': tickets[0],
  });
  assert.equal(stale.status, 409);
  assert.ok(!mock.order.includes('late'));
});
