import assert from 'node:assert/strict';
import test from 'node:test';
import { Classifier } from '../src/classifier.js';
import { expandEnvironment } from '../src/config.js';
import { Metrics } from '../src/metrics.js';
import { createJob, Scheduler } from '../src/scheduler.js';
import { SilentLogger, testConfig } from './helpers.js';

function harness(overlay = {}) {
  let now = 0;
  const config = testConfig(overlay);
  const scheduler = new Scheduler(config, { logger: new SilentLogger(), metrics: new Metrics(), clock: () => now });
  let sequence = 0;
  const add = (id, client, model, extra = {}) => {
    const controller = new AbortController();
    const job = createJob({ id, client, model, pathname: '/api/chat', streaming: true, sequence: ++sequence, signal: controller.signal, enqueuedAt: now, ...extra });
    assert.equal(scheduler.enqueue(job).accepted, true);
    return job;
  };
  return { config, scheduler, add, setNow: (value) => { now = value; }, now: () => now };
}

test('FIFO is preserved within a client and model', () => {
  const { scheduler, add } = harness();
  add('O1', 'odysseus', 'od-model');
  add('O2', 'odysseus', 'od-model');
  assert.equal(scheduler.take().job.id, 'O1');
  scheduler.complete(scheduler.active);
  assert.equal(scheduler.take().job.id, 'O2');
});

test('interactive priority wins when models begin queued together', () => {
  const { scheduler, add } = harness();
  add('F1', 'frigate', 'f-model');
  add('O1', 'odysseus', 'od-model');
  assert.equal(scheduler.take().job.id, 'O1');
});

test('maximum wait prevents Frigate starvation and overrides affinity', () => {
  const { scheduler, add, setNow } = harness();
  add('O1', 'odysseus', 'od-model');
  const first = scheduler.take().job;
  scheduler.complete(first);
  add('F1', 'frigate', 'f-model');
  add('O2', 'odysseus', 'od-model');
  setNow(501);
  assert.equal(scheduler.take().job.id, 'F1');
  assert.equal(scheduler.active.scheduleReason, 'max_wait_exceeded');
});

test('current-model requests are batched ahead of other queued models', () => {
  const { scheduler, add } = harness();
  add('O1', 'odysseus', 'od-model');
  let active = scheduler.take().job;
  scheduler.complete(active);
  add('F1', 'frigate', 'f-model');
  add('O2', 'odysseus', 'od-model');
  add('O3', 'odysseus', 'od-model');
  active = scheduler.take().job;
  assert.equal(active.id, 'O2');
  scheduler.complete(active);
  active = scheduler.take().job;
  assert.equal(active.id, 'O3');
});

test('model lease waits for a follow-up and avoids an immediate switch', () => {
  const { scheduler, add, setNow } = harness();
  add('O1', 'odysseus', 'od-model');
  scheduler.complete(scheduler.take().job);
  add('F1', 'frigate', 'f-model');
  let selection = scheduler.take();
  assert.equal(selection.job, null);
  assert.equal(selection.reason, 'model_lease');
  setNow(8);
  add('O2', 'odysseus', 'od-model');
  selection = scheduler.take();
  assert.equal(selection.job.id, 'O2');
  assert.equal(scheduler.switches, 0);
});

test('batch request limit causes reevaluation and a model switch', () => {
  const { scheduler, add } = harness({ models: {
    'od-model': { idle_hold: '0ms', max_batch_requests: 2, max_batch_time: '2s' },
    'f-model': { idle_hold: '0ms', max_batch_requests: 10, max_batch_time: '2s' },
  } });
  add('O1', 'odysseus', 'od-model');
  scheduler.complete(scheduler.take().job);
  add('O2', 'odysseus', 'od-model');
  add('O3', 'odysseus', 'od-model');
  add('F1', 'frigate', 'f-model');
  scheduler.complete(scheduler.take().job);
  assert.equal(scheduler.take().job.id, 'F1');
});

test('stale Frigate jobs expire', async () => {
  const { scheduler, add, setNow } = harness({ clients: { frigate: { request_ttl: '100ms' } } });
  const job = add('F1', 'frigate', 'f-model');
  setNow(101);
  scheduler.expire();
  const result = await job.result;
  assert.equal(result.code, 'queue_ttl_expired');
  assert.equal(scheduler.status().queues.frigate, 0);
});

test('Frigate drop_oldest overflow policy admits fresh work', async () => {
  const { scheduler, add } = harness({ clients: { frigate: { queue_limit: 2, overflow_policy: 'drop_oldest' } } });
  const first = add('F1', 'frigate', 'f-model');
  add('F2', 'frigate', 'f-model');
  add('F3', 'frigate', 'f-model');
  assert.equal((await first.result).code, 'queue_overflow_drop_oldest');
  assert.deepEqual(scheduler.jobs.map((job) => job.id), ['F2', 'F3']);
});

test('queued disconnect cancels and removes work', async () => {
  const { scheduler, add } = harness();
  const job = add('O1', 'odysseus', 'od-model');
  scheduler.cancel(job);
  assert.equal((await job.result).code, 'client_closed');
  assert.equal(scheduler.jobs.length, 0);
});

test('model and header client mappings use the documented precedence', () => {
  const config = testConfig();
  const classifier = new Classifier(config);
  const request = { headers: { 'x-ollama-client': 'frigate' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.deepEqual(classifier.identify(request, { model: 'od-model' }), { client: 'frigate', method: 'header' });
  request.headers = {};
  assert.deepEqual(classifier.identify(request, { model: 'od-model' }), { client: 'odysseus', method: 'model' });
});

test('unknown models are scheduled as default and can be rejected by policy', () => {
  let config = testConfig();
  let classifier = new Classifier(config);
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(classifier.identify(request, { model: 'unknown' }).client, 'default');
  config = testConfig({ scheduler: { unknown_model_policy: 'reject' } });
  assert.equal(config.scheduler.unknown_model_policy, 'reject');
});

test('backend reconciliation clears stale scheduler model state after restart', () => {
  const { scheduler, add } = harness();
  add('O1', 'odysseus', 'od-model');
  scheduler.complete(scheduler.take().job);
  assert.equal(scheduler.currentModel, 'od-model');
  scheduler.reconcile(null);
  assert.equal(scheduler.currentModel, null);
});

test('environment placeholders support required values and defaults', () => {
  const text = 'url: ${OLLAMA_URL:?missing backend}\nsource: ${CLIENT_SOURCE:-}\n';
  assert.equal(expandEnvironment(text, { OLLAMA_URL: 'http://ollama:11434' }), 'url: http://ollama:11434\nsource: \n');
  assert.throws(() => expandEnvironment(text, {}), /missing backend/);
});

test('client-wide model policy applies to an arbitrary requested model', () => {
  const { scheduler, add } = harness({ models: {} });
  const job = add('O-new', 'odysseus', 'not-registered-anywhere');
  scheduler.complete(scheduler.take().job);
  assert.equal(scheduler.modelPolicy(job.model, job.client).keep_alive, '750ms');
  assert.equal(scheduler.leaseUntil, 50);
});
