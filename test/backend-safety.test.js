import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { BackendClient, BackendState } from '../src/backend.js';
import { ResponseOutcomeCollector } from '../src/http-utils.js';
import { Metrics } from '../src/metrics.js';
import { SilentLogger, testConfig } from './helpers.js';

function backend(config) {
  return new BackendState(config, { logger: new SilentLogger(), metrics: new Metrics(), onModel() {} });
}

test('GPU recovery survives restart and only explicit durable acknowledgement clears it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediary-recovery-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = testConfig({ gpu_safety: { state_path: path.join(directory, 'recovery.json') } });
  const first = backend(config);
  first.requireRecovery('GPU completion uncertain');
  assert.equal(first.recoveryRequired, true);
  const restarted = backend(config);
  restarted.reachable = true;
  assert.equal(restarted.canDispatch(), false);
  assert.equal(restarted.recoveryReason, 'GPU completion uncertain');
  restarted.clearRecovery();
  assert.equal(restarted.canDispatch(), true);
  assert.equal(backend(config).recoveryRequired, false);
});

test('corrupt recovery state fails closed and unsuccessful persistence cannot acknowledge it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediary-recovery-corrupt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'recovery.json');
  fs.writeFileSync(target, '{corrupt');
  const state = backend(testConfig({ gpu_safety: { state_path: target } }));
  state.reachable = true;
  assert.equal(state.recoveryRequired, true);
  assert.equal(state.canDispatch(), false);
  assert.ok(state.status().recovery_storage_error);
  // A directory where the file should go deterministically causes rename to
  // fail, without depending on the current process's privilege level.
  fs.unlinkSync(target);
  fs.mkdirSync(target);
  assert.throws(() => state.clearRecovery());
  assert.equal(state.recoveryRequired, true);
});

test('bounded protocol inspection catches later errors after oversized output records', () => {
  const collector = new ResponseOutcomeCollector(100);
  collector.push(Buffer.from(`{"response":"${'x'.repeat(200)}`));
  collector.push(Buffer.from('"}\n{"error":"ROCm error: out of memory"}\n'));
  assert.match(collector.finish().message, /ROCm error/);
});

test('quoted error text inside generated content is not an inference error', () => {
  const collector = new ResponseOutcomeCollector();
  collector.push(Buffer.from(JSON.stringify({ response: '{"error":"ROCm error: out of memory"}', done: true })));
  assert.equal(collector.finish(), null);
});

test('model cleanup rejects malformed loaded-model responses instead of assuming the GPU is empty', async () => {
  const client = new BackendClient(testConfig());
  for (const payload of [{}, { models: null }, { models: [null] }, { models: [{ name: 3 }] }, { models: [] }]) {
    let cleaned = false;
    client.request = async () => {
      const response = Readable.from([Buffer.from(JSON.stringify(payload))]);
      response.statusCode = 200;
      return { response, cleanup: () => { cleaned = true; } };
    };
    if (Array.isArray(payload.models) && payload.models.length === 0) {
      assert.deepEqual(await client.loadedModels(), []);
    } else {
      await assert.rejects(client.loadedModels(), /models array|invalid model entries/);
    }
    assert.equal(cleaned, true);
  }
});
