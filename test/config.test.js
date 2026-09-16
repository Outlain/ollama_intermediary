import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig, parseConfigSource, parseDuration } from '../src/config.js';

test('duration parsing rejects values that would overflow or make Node timers fire immediately', () => {
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.throws(() => parseDuration(`${'9'.repeat(400)}h`), /must not exceed/);
  assert.throws(() => parseDuration(2_147_483_648), /must be a duration/);
});

test('catch-up is opt-in and strict scheduling defaults preserve arbitrary model names', () => {
  const config = normalizeConfig({ server: { listen: '127.0.0.1:0' } });
  assert.equal(config.frigate.enabled, false);
  assert.equal(config.frigate.pollIntervalMs, 30000);
  assert.equal(config.scheduler.mode, 'strict_priority');
  assert.equal(config.scheduler.unknown_model_policy, 'schedule');
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
