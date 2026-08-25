import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorized, Observability, ResponseStatsCollector, summarizeRequest,
} from '../src/observability.js';
import { testConfig } from './helpers.js';

test('request summaries expose counts without retaining prompt contents', () => {
  const parsed = {
    prompt: 'private prompt',
    system: 'secret system',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: 'private' }] },
      { role: 'assistant', content: 'world' },
    ],
    images: ['base64-private'],
    tools: [{ type: 'function', function: { name: 'search' } }],
    options: { num_ctx: 65_536, num_predict: 512 },
  };
  const summary = summarizeRequest('/api/chat', parsed, 1_024);
  assert.deepEqual(summary, {
    body_bytes: 1_024,
    input_characters: 37,
    message_count: 2,
    image_count: 2,
    tool_count: 1,
    requested_context: 65_536,
    requested_output_tokens: 512,
    summary_truncated: false,
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /private|secret|hello|world/);
});

test('request summaries use a bounded iterative traversal for deeply nested or large input', () => {
  let deeplyNested = 'private leaf';
  for (let index = 0; index < 50_000; index += 1) deeplyNested = [deeplyNested];
  const deepSummary = summarizeRequest('/v1/chat/completions', { input: deeplyNested }, 123);
  assert.equal(deepSummary.summary_truncated, true);
  assert.equal(Number.isFinite(deepSummary.input_characters), true);

  const largeSummary = summarizeRequest('/v1/chat/completions', {
    input: Array.from({ length: 20_000 }, () => 'do not retain me'),
  }, 456);
  assert.equal(largeSummary.summary_truncated, true);
  assert.ok(largeSummary.input_characters > 0);
  assert.doesNotMatch(JSON.stringify(largeSummary), /do not retain me|private leaf/);
});

test('response collector counts bytes and reads Ollama final usage without retaining output', () => {
  const collector = new ResponseStatsCollector();
  const first = Buffer.from(`${JSON.stringify({ response: 'private output', done: false })}\n`);
  const second = Buffer.from(`${JSON.stringify({
    response: '', done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 5,
    total_duration: 2_000_000_000, load_duration: 500_000_000, eval_duration: 1_000_000_000,
  })}\n`);
  collector.push(first);
  collector.push(second);
  const result = collector.finish();
  assert.equal(result.response_bytes, first.length + second.length);
  assert.equal(result.prompt_tokens, 20);
  assert.equal(result.output_tokens, 5);
  assert.equal(result.output_tokens_per_second, 5);
  assert.doesNotMatch(JSON.stringify(result), /private output/);
});

test('response collector only retains whitelisted completion reasons', () => {
  const collector = new ResponseStatsCollector();
  collector.push(Buffer.from(`${JSON.stringify({
    done: true,
    done_reason: 'private upstream diagnostic text',
    prompt_eval_count: 1,
  })}\n`));
  const result = collector.finish();
  assert.equal(result.done_reason, null);
  assert.doesNotMatch(JSON.stringify(result), /private upstream diagnostic text/);
});

test('observability history and subscribers are strictly bounded', () => {
  const config = testConfig({ observability: { history_limit: 2, recent_events: 2, max_event_clients: 1 } });
  const observability = new Observability(config, { clock: () => 1_000 });
  const received = [];
  const unsubscribe = observability.subscribe((event) => received.push(event.type));
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(observability.subscribe(() => {}), null);
  observability.record('one');
  observability.record('two');
  observability.record('three');
  assert.deepEqual(received, ['one', 'two', 'three']);
  assert.deepEqual(observability.recent().map((event) => event.type), ['two', 'three']);
  unsubscribe();
  assert.equal(observability.listeners.size, 0);
});

test('bearer authorization is optional and rejects incorrect values', () => {
  assert.equal(authorized({ headers: {} }, ''), true);
  assert.equal(authorized({ headers: {} }, 'expected'), false);
  assert.equal(authorized({ headers: { authorization: 'Bearer wrong' } }, 'expected'), false);
  assert.equal(authorized({ headers: { authorization: 'Bearer expected' } }, 'expected'), true);
});

test('observability configuration rejects unsafe resource limits', () => {
  assert.throws(
    () => testConfig({ observability: { history_limit: 1_001 } }),
    /history_limit cannot exceed 1000/,
  );
  assert.throws(
    () => testConfig({ observability: { max_event_clients: 101 } }),
    /max_event_clients cannot exceed 100/,
  );
  assert.throws(
    () => testConfig({ observability: { queue_items_limit: 501 } }),
    /queue_items_limit cannot exceed 500/,
  );
  assert.throws(
    () => testConfig({ observability: { history_limit: 2, recent_events: 3 } }),
    /recent_events cannot exceed/,
  );
});
