import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MaintenanceState, parsePauseDuration } from '../src/maintenance.js';
import { SilentLogger, testConfig } from './helpers.js';

function stateConfig(t, overlay = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-intermediary-maintenance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'maintenance.json');
  return {
    statePath,
    config: testConfig({
      maintenance: {
        enabled: true,
        auth_token: 'test-maintenance-token',
        max_pause: '2h',
        state_path: statePath,
        ...overlay,
      },
    }),
  };
}

test('pause duration accepts bounded strings and treats omission as manual', () => {
  assert.equal(parsePauseDuration(undefined, 3_600_000), null);
  assert.equal(parsePauseDuration('30m', 3_600_000), 1_800_000);
  assert.throws(() => parsePauseDuration(30, 3_600_000), /must be a string/);
  assert.throws(() => parsePauseDuration('0s', 3_600_000), /greater than zero/);
  assert.throws(() => parsePauseDuration('2h', 3_600_000), /exceeds the configured maximum/);
});

test('manual pause is persisted, restored fail-safe, and cleared by resume', async (t) => {
  const { config, statePath } = stateConfig(t);
  let now = 1_000;
  const first = new MaintenanceState(config, { clock: () => now, logger: new SilentLogger() });
  const started = await first.begin({ reason: 'rendering job' });
  assert.equal(started.status.state, 'pausing');
  assert.equal(fs.existsSync(statePath), true);
  await first.markReleased(started.revision);
  assert.equal(first.status().state, 'paused');
  assert.equal(first.status().gpu_released, true);
  first.stop();

  now = 2_000;
  const restored = new MaintenanceState(config, { clock: () => now, logger: new SilentLogger() });
  assert.equal(restored.status().state, 'pausing');
  assert.equal(restored.status().paused, true);
  assert.equal(restored.status().gpu_released, false);
  await restored.resume('test');
  assert.equal(restored.status().state, 'running');
  assert.equal(fs.existsSync(statePath), false);
});

test('timed pause countdown begins only after GPU release and auto-resumes', async (t) => {
  const { config } = stateConfig(t);
  let resolveResume;
  const resumed = new Promise((resolve) => { resolveResume = resolve; });
  let state;
  state = new MaintenanceState(config, {
    logger: new SilentLogger(),
    onAutoResume: async () => {
      await state.resume('timer');
      resolveResume();
    },
  });
  // Leave enough wall-clock margin for loaded CI hosts; the behavior under
  // test is that the timer starts at markReleased(), not millisecond precision.
  const started = await state.begin({ duration: '250ms' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(state.status().resume_at, null);
  await state.markReleased(started.revision);
  assert.equal(state.status().state, 'paused');
  assert.ok(state.status().remaining_seconds > 0);
  let timeout;
  await Promise.race([
    resumed,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('timed pause did not auto-resume')), 1_500);
    }),
  ]);
  clearTimeout(timeout);
  assert.equal(state.status().state, 'running');
  assert.equal(state.status().paused, false);
});

test('failed automatic resume stays fail-closed and reports an operator-visible error', async (t) => {
  const { config } = stateConfig(t);
  let state;
  state = new MaintenanceState(config, {
    logger: new SilentLogger(),
    onAutoResume: () => state.resume('timer'),
  });
  const started = await state.begin({ duration: '10ms' });
  state.clearPersisted = async () => { throw new Error('state volume unavailable'); };
  await state.markReleased(started.revision);

  const deadline = Date.now() + 500;
  while (state.status().state !== 'error' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(state.status().state, 'error');
  assert.equal(state.status().paused, true);
  assert.match(state.status().unload_error, /automatic maintenance resume failed/);
});

test('corrupt persisted pause fails closed instead of enabling inference', (t) => {
  const { config, statePath } = stateConfig(t);
  fs.writeFileSync(statePath, '{not-json', { mode: 0o600 });
  const state = new MaintenanceState(config, { logger: new SilentLogger() });
  assert.equal(state.status().state, 'error');
  assert.equal(state.status().paused, true);
  assert.equal(state.status().gpu_released, false);
  assert.match(state.status().unload_error, /invalid persisted maintenance state/);
});

test('maintenance configuration rejects unsafe persistence and duration values', () => {
  assert.throws(
    () => testConfig({ maintenance: { state_path: 'relative/state.json' } }),
    /state_path must be an absolute path/,
  );
  assert.throws(
    () => testConfig({ maintenance: { max_pause: '0s' } }),
    /max_pause must be greater than zero/,
  );
  assert.throws(
    () => testConfig({ maintenance: { auth_token: 123 } }),
    /auth_token must be a string/,
  );
});
