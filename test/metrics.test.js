import assert from 'node:assert/strict';
import test from 'node:test';
import { Metrics } from '../src/metrics.js';

test('size histograms use byte/character buckets instead of second buckets', () => {
  const metrics = new Metrics();
  metrics.observe('proxy_request_body_bytes', 10_000);
  metrics.observe('proxy_request_input_characters', 5000);
  metrics.observe('proxy_queue_wait_seconds', 0.1);
  const text = metrics.render();
  assert.match(text, /proxy_request_body_bytes_bucket\{le="16384"\} 1/);
  assert.match(text, /proxy_request_body_bytes_bucket\{le="4096"\} 0/);
  assert.match(text, /proxy_request_input_characters_bucket\{le="16384"\} 1/);
  assert.match(text, /proxy_queue_wait_seconds_bucket\{le="0.1"\} 1/);
});

test('untrusted model labels are capped with excess values aggregated', () => {
  const metrics = new Metrics({ maxModelNames: 2 });
  for (let index = 0; index < 100; index += 1) metrics.increment('proxy_test_total', { model: `model-${index}` });
  assert.equal(metrics.modelNames.size, 2);
  assert.equal(metrics.counters.size, 3);
  assert.match(metrics.render(), /proxy_test_total\{model="__other__"\} 98/);
});

test('metric series and label lengths are bounded without losing counter totals', () => {
  const metrics = new Metrics({ maxSeriesPerMetric: 3, maxLabelLength: 10 });
  for (let index = 0; index < 100; index += 1) {
    metrics.increment('proxy_test_total', { reason: `${index}-${'a'.repeat(100)}` });
    metrics.observe('proxy_test_seconds', index, { reason: index });
  }
  assert.equal(metrics.counters.size, 4);
  assert.equal(metrics.histograms.size, 4);
  assert.equal([...metrics.counters.values()].reduce((sum, entry) => sum + entry.value, 0), 100);
  for (const entry of metrics.counters.values()) for (const value of Object.values(entry.labels)) assert.ok(value.length <= 10);
});

test('label delimiters do not collide and histogram buckets remain consistent', () => {
  const metrics = new Metrics();
  metrics.increment('proxy_test_total', { a: 'b|c=d' });
  metrics.increment('proxy_test_total', { a: 'b', c: 'd' });
  assert.equal(metrics.counters.size, 2);
  metrics.observe('proxy_test_seconds', 1, {}, [1, 2]);
  metrics.observe('proxy_test_seconds', 1.5, {}, [5]);
  assert.deepEqual([...metrics.histograms.values()][0].counts, [1, 2]);
});

test('dynamic loaded model metrics aggregate overflow without duplicate samples', () => {
  const metrics = new Metrics({ maxModelNames: 1 });
  const text = metrics.render({ loadedModels: [
    { name: 'one', size_vram: 1 }, { name: 'two', size_vram: 2 }, { name: 'three', size_vram: 3 },
  ] });
  assert.match(text, /proxy_ollama_loaded_model_vram_bytes\{model="__other__"\} 5/);
  assert.equal(text.split('\n').filter((line) => line.startsWith('proxy_ollama_loaded_model_vram_bytes')).length, 2);
});
