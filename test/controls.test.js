import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProxyService } from '../src/proxy.js';
import { FrigateCatchup } from '../src/frigate-catchup.js';
import { MockOllama, SilentLogger, testConfig, waitFor } from './helpers.js';

async function fixture(t, overlay = {}, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediary-controls-'));
  const backend = new MockOllama();
  await backend.start();
  const config = testConfig({
    ...overlay,
    ollama: { ...overlay.ollama, url: backend.url },
    maintenance: { ...overlay.maintenance, auth_token: 'maintenance-test', state_path: path.join(directory, 'pause.json') },
    gpu_safety: { ...overlay.gpu_safety, state_path: path.join(directory, 'gpu.json') },
  });
  const service = new ProxyService(config, { logger: new SilentLogger(), settingsToken: 'settings-test', ...options });
  await service.start();
  const base = `http://127.0.0.1:${service.addresses()[0].address.port}`;
  t.after(async () => { await service.stop(); await backend.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await waitFor(() => service.backend.canDispatch());
  return { service, backend, base, directory, config };
}

const post = (url, token, body) => fetch(url, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('catch-up status accepts read/admin tokens but historical scans require admin confirmation', async (t) => {
  let scans = 0;
  const catchup = { start() {}, async stop() {}, status: () => ({ enabled: true, state: 'running' }),
    scanMissing() { scans++; return this.status(); } };
  const { base } = await fixture(t, { observability: { auth_token: 'read-test' } }, { catchup });
  const endpoint = `${base}/_intermediary/v1/frigate`;
  assert.equal((await fetch(`${endpoint}/status`)).status, 401);
  for (const token of ['read-test', 'settings-test']) {
    assert.equal((await fetch(`${endpoint}/status`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  }
  assert.equal((await post(`${endpoint}/scan`, 'read-test', { confirm: true })).status, 401);
  assert.equal((await post(`${endpoint}/scan`, 'settings-test', {})).status, 400);
  assert.equal((await post(`${endpoint}/scan`, 'settings-test', { confirm: true })).status, 202);
  assert.equal(scans, 1);
  const snapshot = await (await fetch(`${base}/_intermediary/v1/status`, { headers: { authorization: 'Bearer read-test' } })).json();
  assert.equal(snapshot.frigate.enabled, true);
  assert.equal(snapshot.build.version, '1.1.0');
});

test('GPU recovery acknowledgment requires admin, pause, empty models, and explicit host confirmation', async (t) => {
  const { base, service, backend } = await fixture(t);
  service.backend.requireRecovery('test fault');
  const endpoint = `${base}/_intermediary/v1/recovery/acknowledge`;
  assert.equal((await post(endpoint, 'wrong', { confirm_gpu_recovered: true })).status, 401);
  assert.equal((await post(endpoint, 'maintenance-test', {})).status, 400);
  assert.equal((await post(endpoint, 'maintenance-test', { confirm_gpu_recovered: true })).status, 409);
  await post(`${base}/_intermediary/v1/maintenance/pause`, 'maintenance-test', {});
  await waitFor(() => !service.gate.active && !service.maintenanceTask);
  backend.loadedModel = 'still-loaded';
  assert.equal((await post(endpoint, 'maintenance-test', { confirm_gpu_recovered: true })).status, 409);
  assert.equal(service.backend.recoveryRequired, true);
  backend.loadedModel = null;
  assert.equal((await post(endpoint, 'maintenance-test', { confirm_gpu_recovered: true })).status, 200);
  assert.equal(service.backend.recoveryRequired, false);
  assert.equal(service.maintenance.paused, true);
});

test('request memory admission includes bodies held by an active HTTP request', async (t) => {
  const { base, service } = await fixture(t, { server: { body_limit_bytes: 300 }, scheduler: { max_queue_bytes: 300 } });
  const body = { model: 'od-model', id: 'long', delay_ms: 150, prompt: 'x'.repeat(160) };
  const first = post(`${base}/api/generate`, '', body);
  await waitFor(() => service.scheduler.active);
  const rejected = await post(`${base}/api/generate`, '', { ...body, id: 'later' });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, 'request_memory_full');
  await (await first).text();
  await waitFor(() => service.reservedBodyBytes === 0);
});

test('queued model management rechecks recovery and restart state before reaching Ollama', async (t) => {
  const { service, base, backend } = await fixture(t);
  for (const stopReason of ['recovery', 'restart']) {
    const release = await service.gate.acquire('inference');
    const pending = post(`${base}/api/pull`, '', { model: 'not-downloaded' });
    await waitFor(() => service.gate.managementPending);
    if (stopReason === 'recovery') service.backend.requireRecovery('test fault while queued');
    else service.beginSettingsRestart();
    release();
    const response = await pending;
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, stopReason === 'recovery' ? 'gpu_recovery_required' : 'shutting_down');
    assert.equal(backend.events.includes('/api/pull'), false);
    if (stopReason === 'recovery') service.backend.clearRecovery();
  }
});

test('recovery acknowledgment does not clear the latch if maintenance resumes during verification', async (t) => {
  const { service, base } = await fixture(t);
  service.backend.requireRecovery('test fault');
  await post(`${base}/_intermediary/v1/maintenance/pause`, 'maintenance-test', {});
  await waitFor(() => !service.gate.active && !service.maintenanceTask);
  let verifying = false;
  let finishVerification;
  const verified = new Promise((resolve) => { finishVerification = resolve; });
  service.backendClient.loadedModels = async () => { verifying = true; await verified; return []; };
  const pending = post(`${base}/_intermediary/v1/recovery/acknowledge`, 'maintenance-test', { confirm_gpu_recovered: true });
  await waitFor(() => verifying);
  await service.resumeMaintenance('test');
  finishVerification();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'recovery_state_changed');
  assert.equal(service.backend.recoveryRequired, true);
});

test('real catch-up worker waits through Odysseus request and idle hold before native Frigate handoff', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediary-catchup-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let service;
  let base;
  let generated = 0;
  let nativeError;
  const item = { id: 'past-object', camera: 'driveway', label: 'person', start_time: Date.now()/1000-500, end_time: Date.now()/1000-400, data: {} };
  const client = {
    close() {}, capabilities: async () => ({ object: true, review: true }),
    getConfig: async () => ({ genai: { local: { roles: ['descriptions'] } }, cameras: {
      driveway: { enabled: true, objects: { genai: { enabled: true, use_snapshot: true } } },
    } }),
    list: async (kind, scan) => kind === 'object' && item.start_time > scan.after && item.start_time < scan.before ? [item] : [],
    get: async () => item, hasMedia: async () => true,
    regenerate: async () => {
      generated++;
      fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ollama-client': 'frigate' },
        body: JSON.stringify({ model: 'f-model', id: 'catch-up', stream: false }),
      }).then(async (response) => { await response.text(); if (response.ok) item.data.description = 'Saved by Frigate'; else nativeError = response.status; }).catch((error) => { nativeError = error; });
      return { accepted: true };
    },
  };
  const workerConfig = testConfig({ frigate: {
    enabled: true, url: 'http://frigate.invalid', state_path: path.join(directory, 'jobs.json'),
    poll_interval: '10ms', live_grace: '0s', generation_timeout: '1s',
  } });
  const catchup = new FrigateCatchup(workerConfig, { logger: new SilentLogger(), client,
    canRun: () => service ? service.backgroundReadiness() : false });
  ({ service, base } = await fixture(t, { scheduler: { default_client: 'odysseus' } }, { catchup }));
  const active = post(`${base}/api/generate`, '', { model: 'od-model', id: 'foreground', delay_ms: 120 });
  await waitFor(() => service.scheduler.active);
  catchup.scanMissing();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(generated, 0);
  await (await active).text();
  await waitFor(() => catchup.status().totals.completed === 1);
  assert.equal(generated, 1);
  assert.equal(nativeError, undefined);
});
