import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProxyService } from '../src/proxy.js';
import { MockOllama, requestJson, SilentLogger, testConfig, waitFor } from './helpers.js';

const maintenanceHeaders = { authorization: 'Bearer recovery-maintenance-test' };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function stopCatchupTimers(worker) {
  for (const name of ['timer', 'confirmationTimer', 'cleanupTimer']) {
    clearTimeout(worker[name]);
    worker[name] = null;
  }
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-proxy-integration-'));
  const mock = new MockOllama();
  await mock.start();
  const clock = { now: Date.now() };
  const transportLost = deferred();
  const replacementProven = deferred();
  let service;
  let brokenSent = false;
  const restarts = [];
  const host = {
    enabled: true, available: true, stale: false, error: null, bound: true,
    service: { active: true, invocation_id: 'service-before', kill_mode: 'control-group' },
    restart_policy: { available: true },
    memory: { available: true, total_bytes: 30 * 1024 ** 3, available_bytes: 10 * 1024 ** 3 },
    gpus: [{ id: '0', name: 'Mock AMD GPU', vram_total_bytes: 32 * 1024 ** 3,
      vram_used_bytes: 57 * 1024 ** 2, utilization_percent: 0, processes_known: true, processes: [] }],
  };
  const helper = {
    start() {}, stop() {},
    async refresh() { host.sampled_at = new Date(clock.now).toISOString(); return this.snapshot(); },
    snapshot() { return structuredClone(host); },
    async restart(id, before) {
      assert.equal(service.gate.activeKind, 'maintenance');
      assert.equal(service.scheduler.active, null);
      assert.equal(service.backend.recoveryRequired, true);
      assert.equal(before, 'service-before');
      restarts.push(id);
      // The disconnected old operation remains physically active until the
      // mock host provides a proven replacement boundary. API emptiness is
      // deliberately insufficient to release it.
      await replacementProven.promise;
      mock.active = 0;
      mock.loadedModel = null;
      host.service.invocation_id = 'service-after';
      host.gpus[0].processes = [];
      host.gpus[0].vram_used_bytes = 57 * 1024 ** 2;
      return { operation_id: id, state: 'completed', restarted: true,
        before_invocation_id: before, after_invocation_id: 'service-after' };
    },
  };
  const original = mock.handle.bind(mock);
  mock.handle = async (request, response) => {
    if (request.url !== '/api/generate' || brokenSent) return original(request, response);
    brokenSent = true;
    const body = JSON.parse((await mock.body(request)).toString());
    assert.equal(body.id, 'broken-native');
    mock.active += 1;
    mock.maxActive = Math.max(mock.maxActive, mock.active);
    mock.order.push(body.id);
    host.gpus[0].processes = [{ pid: 123, is_ollama: true }];
    host.gpus[0].vram_used_bytes = 16 * 1024 ** 3;
    await transportLost.promise;
    // This models a runner/transport failure before response headers. Unlike
    // MockOllama's ordinary completion path, socket close does not establish
    // physical compute completion and therefore does not decrement active.
    mock.loadedModel = null;
    response.destroy(new Error('simulated post-dispatch socket hang up'));
  };
  const config = testConfig({
    ollama: { url: mock.url },
    maintenance: { enabled: true, auth_token: 'recovery-maintenance-test', state_path: path.join(directory, 'pause.json') },
    gpu_safety: { state_path: path.join(directory, 'gpu.json') },
    host_helper: { enabled: true },
    auto_recovery: { enabled: true, state_path: path.join(directory, 'recovery.json'), check_interval: '1s', verification_timeout: '10s' },
    frigate: { enabled: true, url: 'http://frigate.test:5000', state_path: path.join(directory, 'backlog.json'),
      poll_interval: '1h', live_grace: '0s', retry_interval: '1h', max_retry_interval: '5h', confirmation_interval: '1s' },
  });
  service = new ProxyService(config, { logger: new SilentLogger(), hostHelper: helper, clock: () => clock.now });
  const worker = service.catchup;
  worker.client.close();
  const rows = new Map(['broken-native', 'older-pending'].map((id, index) => [id, {
    id, camera: 'yard', start_time: 100 - index, end_time: 101 - index, label: 'person', data: {},
  }]));
  const handoffs = [];
  worker.client = {
    close() {}, capabilities: async () => ({ object: true, review: true, bridge: true }),
    getConfig: async () => ({ genai: { local: { provider: 'ollama', roles: ['descriptions'] } },
      cameras: { yard: { enabled: true, objects: { genai: { enabled: true, use_snapshot: false } } } } }),
    list: async () => [], get: async (_kind, id) => structuredClone(rows.get(id)), hasMedia: async () => true,
    regenerate: async (_kind, id, _source, ticket) => { handoffs.push({ id, ticket }); return { accepted: true }; },
  };
  t.after(async () => {
    transportLost.resolve();
    replacementProven.resolve();
    await service.stop();
    await mock.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await service.start();
  // Use actual HTTP lifecycle/scheduling with a stepped clock for deterministic
  // stable-sample assertions; never sleep through production-scale cooldowns.
  clearInterval(service.automaticRecovery.timer);
  await waitFor(() => service.backend.canDispatch() && worker.capabilities.checked && !service.automaticRecovery.busy);
  stopCatchupTimers(worker);
  const base = `http://127.0.0.1:${service.addresses()[0].address.port}`;
  worker.state.jobs = [...rows.values()].map((row) => ({ id: row.id, kind: 'object', camera: row.camera,
    event_time: row.start_time, state: 'pending', attempts: 0, failures: 0, created_at: clock.now,
    first_failed_at: null, last_attempt_at: null, next_attempt_at: 0 }));
  worker.persist();
  await worker.processJobs();
  assert.equal(handoffs[0].id, 'broken-native');
  return { service, worker, mock, clock, base, handoffs, restarts, transportLost, replacementProven,
    async step() { clock.now += 1000; await service.automaticRecovery.tick(); } };
}

for (const preservePause of [false, true]) {
  test(`post-dispatch disconnect is recovered without overlapping GPU work${preservePause ? ' or losing a manual pause' : ''}`, async (t) => {
    const f = await fixture(t);
    const ticket = f.handoffs[0].ticket;
    const failed = requestJson(`${f.base}/api/generate`, { model: 'f-model', id: 'broken-native' }, {
      'x-ollama-intermediary-attempt': ticket,
    });
    await waitFor(() => f.mock.active === 1 && f.service.scheduler.active);
    const queued = requestJson(`${f.base}/api/generate`, { model: 'od-model', id: 'queued-before-fault' });
    await waitFor(() => f.service.scheduler.status().queues.odysseus === 1);
    f.transportLost.resolve();
    const failedResponse = await failed;
    await failedResponse.text();
    assert.equal(failedResponse.status, 503);
    assert.equal((await queued).status, 503);
    await waitFor(() => f.service.backend.recoveryRequired && f.service.scheduler.active === null && f.worker.requiresRecovery);
    stopCatchupTimers(f.worker);
    assert.equal(f.service.backend.recoveryCode, 'upstream_disconnected');
    assert.equal(f.mock.active, 1);
    assert.equal(f.mock.loadedModel, null);
    assert.deepEqual(f.mock.order, ['broken-native']);
    const report = await requestJson(`${f.base}/_intermediary/v1/frigate/attempt`, { outcome: 'failed', reason: 'generation_failed' }, {
      'x-ollama-intermediary-attempt': ticket,
    });
    assert.equal(report.status, 202);
    assert.equal(f.worker.requiresRecovery, true, 'native failure alone cannot resolve uncertain compute');
    stopCatchupTimers(f.worker);

    if (preservePause) {
      assert.equal((await requestJson(`${f.base}/_intermediary/v1/maintenance/pause`, {}, maintenanceHeaders)).status, 202);
      await waitFor(() => !f.service.maintenanceTask && !f.service.gate.active);
      await f.step();
      assert.equal(f.restarts.length, 0);
      assert.equal(f.service.automaticRecovery.reason, 'manual_pause');
      assert.equal((await requestJson(`${f.base}/_intermediary/v1/recovery/check`, { confirm: true }, maintenanceHeaders)).status, 202);
    } else {
      // Begin the normal periodic engine step; the helper holds its reply until
      // the test provides a completed service replacement proof.
      f.service.automaticRecovery.tick();
    }
    await waitFor(() => f.restarts.length === 1);
    assert.equal(f.service.gate.activeKind, 'maintenance');
    assert.equal((await requestJson(`${f.base}/api/generate`, { model: 'od-model', id: 'before-proof' })).status, 503);
    assert.deepEqual(f.mock.order, ['broken-native']);
    f.replacementProven.resolve();
    await f.service.automaticRecovery.busy;
    assert.equal(f.service.automaticRecovery.state, 'verifying');
    assert.equal(f.service.backend.recoveryRequired, true);
    assert.equal(f.mock.active, 0);

    for (let sample = 1; sample <= 2; sample++) {
      await f.step();
      assert.equal(f.service.automaticRecovery.saved.current.samples, sample);
      assert.equal(f.service.backend.recoveryRequired, true);
      assert.equal((await requestJson(`${f.base}/api/generate`, { model: 'od-model', id: `before-sample-${sample + 1}` })).status, 503);
      assert.deepEqual(f.mock.order, ['broken-native']);
    }
    await f.step();
    assert.equal(f.service.backend.recoveryRequired, false);
    assert.equal(f.worker.requiresRecovery, false);
    assert.equal(f.service.automaticRecovery.state, 'recovered');
    const failedJob = f.worker.state.jobs.find((job) => job.id === 'broken-native');
    assert.equal(failedJob.state, 'retrying');
    assert.equal(failedJob.attempt.revoked, true);
    assert.ok(f.worker.state.jobs.some((job) => job.id === 'older-pending'), 'unrelated backlog work survives recovery');
    assert.equal(f.restarts.length, 1);

    if (preservePause) {
      assert.equal(f.service.maintenance.paused, true);
      assert.equal((await requestJson(`${f.base}/api/generate`, { model: 'od-model', id: 'still-paused' })).status, 503);
      assert.equal((await requestJson(`${f.base}/_intermediary/v1/maintenance/resume`, {}, maintenanceHeaders)).status, 200);
    }
    const late = await requestJson(`${f.base}/api/generate`, { model: 'f-model', id: 'late-old-attempt' }, {
      'x-ollama-intermediary-attempt': ticket,
    });
    assert.equal(late.status, 409);
    const success = await requestJson(`${f.base}/api/generate`, { model: 'od-model', id: 'after-recovery', delay_ms: 25 });
    assert.equal(success.status, 200);
    await success.text();
    await waitFor(() => f.mock.active === 0);
    assert.deepEqual(f.mock.order, ['broken-native', 'after-recovery']);
    assert.equal(f.mock.maxActive, 1, 'the retired physical operation never overlaps a subsequent inference');
  });
}
