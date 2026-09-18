import assert from 'node:assert/strict';
import test from 'node:test';
import { contextOverflow, contextRequest, rescueTarget, rescueHardwareBlock, validRescue } from '../src/context-rescue.js';
import { testConfig } from './helpers.js';

const typed = { error: { code: 400, type: 'exceed_context_size_error', n_prompt_tokens: 80111, n_ctx: 70400, message: 'private error text' } };
const buffer = (value) => Buffer.from(JSON.stringify(value));
const body = { model: 'qwen3-vl:8b-instruct', prompt: 'private prompt', images: ['private image'], options: { num_ctx: 70341 } };
const fingerprint = (value = body, origin = 'http://ollama:11434') => contextRequest('/api/generate', buffer(value), value, origin);
const settings = { enabled: true, model: body.model, max_context: 90000, output_reserve: 2048, safety_margin: 1024 };
const evidence = () => ({ ...fingerprint(), prompt_tokens: 80111, reported_context: 70400, failed_attempt: 'a'.repeat(64), attempted: false, target_context: null, reason: 'context_overflow' });
const host = () => ({ available: true, stale: false, bound: true, gpus: [{ processes_known: true, processes: [{ is_ollama: true }], utilization_percent: 0, vram_free_bytes: 8 * 1024 ** 3 }] });

test('context rescue recognizes exact typed Ollama rejections, including string-wrapped runner errors', () => {
  for (const error of [typed, { error: JSON.stringify(typed) }, { error: JSON.stringify({ error: JSON.stringify(typed) }) }]) {
    assert.deepEqual(contextOverflow(400, buffer(error)), { prompt_tokens: 80111, reported_context: 70400 });
  }
  assert.doesNotMatch(JSON.stringify(contextOverflow(400, buffer(typed))), /private/);
});

test('context rescue rejects ambiguous, malformed, generated or oversized error evidence', () => {
  for (const value of [
    { error: 'request exceeds context size' }, { response: JSON.stringify(typed), done: true },
    { ...typed, response: 'generated output' }, { error: { ...typed.error, code: 500 } },
    { error: { ...typed.error, type: 'out_of_memory' } }, { error: { ...typed.error, n_prompt_tokens: '80111' } },
    { error: { ...typed.error, n_prompt_tokens: 10 } }, { error: { ...typed.error, n_ctx: 0 } },
    { error: { ...typed.error, n_prompt_tokens: 1.5 } }, { error: { ...typed.error, n_ctx: -1 } },
    { error: { ...typed.error, n_prompt_tokens: 1e20 } }, null, [],
  ]) assert.equal(contextOverflow(400, buffer(value)), null);
  assert.equal(contextOverflow(500, buffer(typed)), null);
  assert.equal(contextOverflow(200, buffer(typed)), null);
  assert.equal(contextOverflow(400, buffer(typed), false), null);
  assert.equal(contextOverflow(400, Buffer.from('{"error":')), null);
  assert.equal(contextOverflow(400, Buffer.concat([buffer(typed), Buffer.alloc(65536, ' ')])), null);
});

test('rescue measurement is bound to complete input, model, options, route and backend without retaining content', () => {
  assert.match(fingerprint().signature, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(fingerprint()), /private/);
  for (const changed of [
    { ...body, prompt: 'different' }, { ...body, images: ['different'] }, { ...body, model: 'other' },
    { ...body, options: { num_ctx: 8192 } }, { ...body, options: { ...body.options, temperature: 0.5 } },
  ]) assert.notEqual(fingerprint().signature, fingerprint(changed).signature);
  assert.notEqual(fingerprint().signature, fingerprint(body, 'http://other:11434').signature);
  assert.notEqual(fingerprint().signature, contextRequest('/api/chat', buffer(body), body, 'http://ollama:11434').signature);
  for (const path of ['/v1/chat/completions', '/api/embed']) assert.equal(contextRequest(path, buffer(body), body, ''), null);
  for (const options of [{}, { num_ctx: 0 }, { num_ctx: '8192' }, { num_ctx: 8192, num_predict: -2 }]) {
    assert.equal(fingerprint({ ...body, options }), null);
  }
});

test('target fits measured input plus reply room, rounds conservatively and never exceeds the tested cap', () => {
  assert.equal(rescueTarget(evidence(), fingerprint(), settings).context, 86016);
  assert.deepEqual(rescueTarget(evidence(), fingerprint(), { ...settings, max_context: 84000 }), { context: 84000, required: 83183 });
  assert.equal(rescueTarget(evidence(), fingerprint(), { ...settings, max_context: 83000 }).blocked, 'rescue_above_cap');
  const request = fingerprint({ ...body, options: { num_ctx: 70341, num_predict: 8192 } });
  assert.equal(rescueTarget({ ...evidence(), ...request }, request, settings).context, 90000);
  assert.equal(rescueTarget({ ...evidence(), attempted: true }, fingerprint(), settings).blocked, 'rescue_used');
  assert.equal(rescueTarget(evidence(), fingerprint(), { ...settings, enabled: false }), null);
  assert.equal(rescueTarget(undefined, fingerprint(), settings), null);
  assert.equal(rescueTarget(evidence(), undefined, settings), null);
  assert.equal(rescueTarget(evidence(), fingerprint({ ...body, prompt: 'changed' }), settings), null);
  assert.equal(rescueTarget(evidence(), fingerprint(), { ...settings, model: 'other' }), null);
  assert.ok(validRescue(evidence()));
  assert.ok(validRescue({ ...evidence(), attempted: true, target_context: 86016 }));
  for (const target_context of [null, 8192, 2e6]) assert.equal(validRescue({ ...evidence(), attempted: true, target_context }), false);
});

test('rescue hardware guard requires fresh bound telemetry, idle GPU and free memory on every GPU', () => {
  assert.equal(rescueHardwareBlock(host()), null);
  for (const patch of [{ available: false }, { stale: true }, { bound: false }, { gpus: [] }]) {
    assert.equal(rescueHardwareBlock({ ...host(), ...patch }), 'rescue_telemetry_unavailable');
  }
  for (const patch of [{ processes_known: false }, { utilization_percent: null }, { vram_free_bytes: null }]) {
    const snapshot = host(); Object.assign(snapshot.gpus[0], patch);
    assert.equal(rescueHardwareBlock(snapshot), 'rescue_telemetry_unavailable');
  }
  for (const patch of [{ utilization_percent: 1 }, { processes: [{ is_ollama: false }] }]) {
    const snapshot = host(); Object.assign(snapshot.gpus[0], patch);
    assert.equal(rescueHardwareBlock(snapshot), 'rescue_gpu_busy');
  }
  const snapshot = host(); snapshot.gpus.push({ ...snapshot.gpus[0], vram_free_bytes: 1024 });
  assert.equal(rescueHardwareBlock(snapshot), 'rescue_vram_headroom');
});

test('rescue configuration upgrades default off and require an explicit model, tested cap, catch-up and host monitoring', () => {
  assert.deepEqual(testConfig().frigate.context_rescue, { enabled: false, model: '', max_context: 0, output_reserve: 2048, safety_margin: 1024 });
  const overlay = { host_helper: { enabled: true }, frigate: { enabled: true, url: 'http://frigate:5000', context_rescue: settings } };
  assert.equal(testConfig(overlay).frigate.context_rescue.max_context, 90000);
  for (const patch of [{ model: '' }, { model: 'not a tag' }, { max_context: 0 }, { max_context: 2048 },
    { max_context: 2e6 }, { max_context: 90000.5 }, { output_reserve: 1 }, { safety_margin: 0 }]) {
    assert.throws(() => testConfig({ ...overlay, frigate: { ...overlay.frigate, context_rescue: { ...settings, ...patch } } }), /context_rescue/);
  }
  assert.throws(() => testConfig({ ...overlay, host_helper: { enabled: false } }), /context_rescue/);
  assert.throws(() => testConfig({ ...overlay, frigate: { ...overlay.frigate, enabled: false } }), /context_rescue/);
});
