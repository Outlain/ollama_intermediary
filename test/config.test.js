import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig, parseConfigSource, parseDuration } from '../src/config.js';

test('duration parsing rejects values that would overflow or make Node timers fire immediately', () => {
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.throws(() => parseDuration(`${'9'.repeat(400)}h`), /must not exceed/);
  assert.throws(() => parseDuration(2_147_483_648), /must be a duration/);
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
