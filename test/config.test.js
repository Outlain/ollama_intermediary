import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHostEnvironment, normalizeConfig, parseConfigSource, parseDuration } from '../src/config.js';

test('host monitoring and automatic recovery remain disabled on an ordinary upgrade', () => {
  const config = normalizeConfig({ server: { listen: '127.0.0.1:0' } });
  assert.equal(config.host_helper.enabled, false);
  assert.equal(config.auto_recovery.enabled, false);
  assert.equal(config.host_helper.pollIntervalMs, 5000);
  assert.equal(config.host_helper.requestTimeoutMs, 15000);
  assert.equal(config.host_helper.staleAfterMs, 30000);
  assert.equal(config.auto_recovery.cooldownMs, 300000);
  assert.equal(config.auto_recovery.windowMs, 3600000);
  assert.equal(config.auto_recovery.max_restarts, 2);
  assert.equal(config.auto_recovery.stable_samples, 3);
});

test('automatic recovery needs explicit helper installation opt-in and maintenance credentials', () => {
  const normalize = (overlay) => normalizeConfig({ server: { listen: '127.0.0.1:0' }, ...overlay });
  assert.throws(() => normalize({ auto_recovery: { enabled: true } }), /requires host_helper.enabled/);
  assert.throws(() => normalize({ host_helper: { enabled: true }, auto_recovery: { enabled: true } }), /maintenance.auth_token/);
  assert.throws(() => normalize({ host_helper: { enabled: true }, auto_recovery: { enabled: true }, maintenance: { enabled: false, auth_token: 'test' } }), /maintenance.enabled/);
  assert.doesNotThrow(() => normalize({ host_helper: { enabled: true }, auto_recovery: { enabled: true }, maintenance: { enabled: true, auth_token: 'test' } }));
});

test('host safety configuration rejects unsafe paths, timings, and restart limits', () => {
  const normalize = (section, value) => normalizeConfig({ server: { listen: '127.0.0.1:0' }, [section]: value });
  for (const [section, fields] of Object.entries({
    host_helper: { enabled: ['true'], socket_path: ['relative.sock', '/tmp/bad\0socket'], poll_interval: ['0s', '61s'], request_timeout: ['0s', '61s'], stale_after: ['999ms', '301s'] },
    auto_recovery: { enabled: ['false'], state_path: ['relative.json'], check_interval: ['0s', '61s'], restart_timeout: ['9s', '301s'], verification_timeout: ['9s', '301s'], cooldown: ['4m', '25h'], window: ['59m', '169h'], max_restarts: [0, 3, 1.5], stable_samples: [1, 11], max_idle_vram_mb: [63, 4097] },
  })) {
    for (const [field, values] of Object.entries(fields)) {
      for (const value of values) assert.throws(() => normalize(section, { [field]: value }), new RegExp(`${section}\\.${field}`));
    }
  }
  assert.throws(() => normalize('host_helper', { poll_interval: '30s', stale_after: '20s' }), /stale_after/);
  assert.throws(() => normalize('auto_recovery', { cooldown: '2h', window: '1h' }), /auto_recovery.window/);
  assert.throws(() => normalize('auto_recovery', { check_interval: '30s', stable_samples: 3, verification_timeout: '60s' }), /verification_timeout.*stable_samples/);
  assert.doesNotThrow(() => normalize('auto_recovery', { check_interval: '30s', stable_samples: 3, verification_timeout: '120s' }));
});

test('host environment bootstrap accepts exact booleans without overriding absent values', () => {
  const raw = { host_helper: { enabled: true }, auto_recovery: { enabled: false } };
  assert.deepEqual(applyHostEnvironment(raw, {}), raw);
  assert.deepEqual(applyHostEnvironment(raw, { HOST_HELPER_ENABLED: '', AUTO_RECOVERY_ENABLED: '' }), raw);
  const enabled = applyHostEnvironment(raw, { HOST_HELPER_ENABLED: '1', AUTO_RECOVERY_ENABLED: 'true', HOST_HELPER_SOCKET_PATH: '/run/custom.sock' });
  assert.equal(enabled.auto_recovery.enabled, true);
  assert.equal(enabled.host_helper.socket_path, '/run/custom.sock');
  assert.equal(applyHostEnvironment(raw, { HOST_HELPER_ENABLED: 'false' }).host_helper.enabled, false);
  assert.equal(applyHostEnvironment(raw, { HOST_HELPER_ENABLED: '0' }).host_helper.enabled, false);
  assert.equal(raw.auto_recovery.enabled, false);
  for (const value of ['"1"', 'yes', 'TRUE', ' true ']) {
    assert.throws(() => applyHostEnvironment(raw, { AUTO_RECOVERY_ENABLED: value }), /must be exactly/);
  }
});

test('duration parsing rejects values that would overflow or make Node timers fire immediately', () => {
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.throws(() => parseDuration(`${'9'.repeat(400)}h`), /must not exceed/);
  assert.throws(() => parseDuration(2_147_483_648), /must be a duration/);
});

test('catch-up is opt-in and strict scheduling defaults preserve arbitrary model names', () => {
  const config = normalizeConfig({ server: { listen: '127.0.0.1:0' } });
  assert.equal(config.frigate.enabled, false);
  assert.equal(config.frigate.pollIntervalMs, 30000);
  assert.equal(config.frigate.confirmationIntervalMs, 2000);
  assert.equal(config.frigate.cleanupIntervalMs, 60000);
  assert.equal(config.frigate.cleanup_batch_size, 25);
  assert.equal(config.frigate.history_limit, 1000);
  assert.equal(config.frigate.max_verifying, 4);
  assert.equal(config.frigate.maxRetryIntervalMs, 5 * 60 * 60 * 1000);
  assert.equal(config.frigate.attentionAfterMs, 24 * 60 * 60 * 1000);
  assert.equal(config.scheduler.mode, 'strict_priority');
  assert.equal(config.scheduler.unknown_model_policy, 'schedule');
});

test('catch-up cadence, cleanup, and retained history bounds prevent unbounded work', () => {
  const normalized = (frigate) => normalizeConfig({ server: { listen: '127.0.0.1:0' }, frigate });
  for (const [field, values] of Object.entries({
    confirmation_interval: ['0s', '999ms'],
    cleanup_interval: ['0s', '9999ms'],
    cleanup_batch_size: [0, 101, 1.5],
    history_limit: [0, 5001, 1.5],
    max_verifying: [0, 17, 1.5],
    attention_after: ['0s'],
  })) {
    for (const value of values) assert.throws(() => normalized({ [field]: value }), new RegExp(`frigate\\.${field}`));
  }
  assert.doesNotThrow(() => normalized({ confirmation_interval: '1s', cleanup_interval: '10s', cleanup_batch_size: 100, history_limit: 5000 }));
  assert.doesNotThrow(() => normalized({ max_verifying: 16 }));
});

test('new catch-up defaults do not replace existing retry or model policies', () => {
  const config = normalizeConfig({
    server: { listen: '127.0.0.1:0' },
    frigate: { max_retry_interval: '1h', generation_timeout: '20m' },
    clients: { frigate: { model_policy: { keep_alive: '15s', idle_hold: '3s' } } },
  });
  assert.equal(config.frigate.maxRetryIntervalMs, 3600000);
  assert.equal(config.frigate.generationTimeoutMs, 1200000);
  assert.equal(config.frigate.confirmationIntervalMs, 2000);
  assert.equal(config.frigate.history_limit, 1000);
  assert.equal(config.clients.frigate.model_policy.keep_alive, '15s');
});

test('Frigate connection and operational bounds fail safely', () => {
  const normalized = (overlay) => normalizeConfig({ server: { listen: '127.0.0.1:0' }, ...overlay });
  assert.throws(() => normalized({ frigate: { enabled: true } }), /frigate.url/);
  for (const url of ['file:///etc/passwd', 'http://name:secret@example.test', 'http://example.test/api', 'http://example.test/?token=secret']) {
    assert.throws(() => normalized({ frigate: { url } }), /frigate.url/);
  }
  assert.throws(() => normalized({ frigate: { max_jobs: 0 } }), /frigate.max_jobs/);
  assert.throws(() => normalized({ frigate: { page_size: 1001 } }), /frigate.page_size/);
  assert.throws(() => normalized({ frigate: { poll_interval: '0s' } }), /frigate.poll_interval must be greater than zero/);
  assert.throws(() => normalized({ circuit_breaker: { failure_threshold: 0 } }), /circuit_breaker.failure_threshold/);
  assert.throws(() => normalized({ scheduler: { max_queue_bytes: -1 } }), /scheduler.max_queue_bytes/);
  assert.throws(() => normalized({ scheduler: { mode: 'unknown' } }), /scheduler.mode/);
});

test('Frigate authentication is explicit and authenticated modes require host-managed credentials', () => {
  const normalize = (frigate) => normalizeConfig({ server: { listen: '127.0.0.1:0' }, frigate: { enabled: true, url: 'http://frigate.test:5000', ...frigate } });
  assert.equal(normalize({ auth_mode: 'none' }).frigate.auth_mode, 'none');
  assert.equal(normalize({}).frigate.auth_mode, 'auto');
  assert.throws(() => normalize({ auth_mode: 'invalid' }), /frigate.auth_mode/);
  assert.throws(() => normalize({ auth_mode: 'password' }), /FRIGATE_USERNAME/);
  assert.throws(() => normalize({ auth_mode: 'token' }), /FRIGATE_AUTH_TOKEN/);
  assert.equal(normalize({ auth_mode: 'password', username: 'admin', password: 'test' }).frigate.auth_mode, 'password');
});

test('configuration environment values are expanded after YAML parsing', () => {
  const injected = 'http://192.0.2.10:11434\nscheduler:\n  default_client: attacker';
  const source = parseConfigSource('ollama:\n  url: "${OLLAMA_URL:?required}"\n', { OLLAMA_URL: injected });
  assert.equal(source.raw.ollama.url, injected);
  assert.equal(source.raw.scheduler, undefined);
});

test('lenient recovery parsing reports the exact path of missing required environment values', () => {
  const source = parseConfigSource([
    'ollama:',
    '  url: "${OLLAMA_URL:?Set Ollama URL}"',
    'maintenance:',
    '  auth_token: "${MAINTENANCE_TOKEN:?Set maintenance token}"',
  ].join('\n'), {}, { allowMissingRequired: true });
  assert.equal(source.raw.ollama.url, '');
  assert.equal(source.raw.maintenance.auth_token, '');
  assert.deepEqual(source.missingEnvironment.map(({ variable, path }) => ({ variable, path })), [
    { variable: 'OLLAMA_URL', path: 'ollama.url' },
    { variable: 'MAINTENANCE_TOKEN', path: 'maintenance.auth_token' },
  ]);
});

test('strict parsing still rejects a missing required environment value', () => {
  assert.throws(
    () => parseConfigSource('ollama:\n  url: "${OLLAMA_URL:?Set Ollama URL}"\n', {}),
    /Set Ollama URL/,
  );
});

test('normalization rejects unsafe backend URLs and invalid source networks', () => {
  const base = {
    server: { listen: '127.0.0.1:11434' },
    ollama: { url: 'http://127.0.0.1:11434' },
  };
  assert.throws(() => normalizeConfig(base), /points back to the intermediary/);
  assert.throws(
    () => normalizeConfig({ ...base, ollama: { url: 'http://user:password@192.0.2.10:11434' } }),
    /without credentials/,
  );
  assert.throws(
    () => normalizeConfig({
      ...base,
      ollama: { url: 'http://192.0.2.10:11434' },
      clients: { default: { source_ips: ['192.0.2.0/99'] } },
    }),
    /invalid CIDR prefix/,
  );
});

test('normalization rejects every local alias that targets any intermediary listener', () => {
  const listeners = {
    listen: '0.0.0.0:11434',
    dedicated_listeners: [{ listen: '0.0.0.0:11436', client: 'default' }],
  };
  for (const url of [
    'http://localhost:11434',
    'http://127.42.0.1:11434',
    'http://0.0.0.0:11434',
    'http://[::]:11434',
    'http://[::1]:11434',
    'http://localhost:11436',
  ]) {
    assert.throws(
      () => normalizeConfig({ server: listeners, ollama: { url } }),
      /points back to the intermediary/,
      url,
    );
  }
  assert.doesNotThrow(() => normalizeConfig({
    server: listeners,
    ollama: { url: 'http://127.0.0.1:11435' },
  }));
});
