import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrigateCatchup, frigateEligibility, hasFrigateDescription } from '../src/frigate-catchup.js';
import { FrigateError } from '../src/frigate-client.js';

function cameraConfig() {
  return {
    genai: { local: { provider: 'ollama', roles: ['descriptions'] } },
    cameras: { yard: {
      enabled: true,
      objects: { genai: { enabled: true, objects: ['person', 'car'], required_zones: ['driveway'], use_snapshot: true } },
      review: {
        genai: { enabled: true, alerts: true, detections: true },
        alerts: { enabled: true, labels: ['person', 'car'], required_zones: ['driveway'] },
        detections: { enabled: true, labels: null, required_zones: [] },
      },
    } },
  };
}

const object = (id, start = 100, overrides = {}) => ({
  id, camera: 'yard', start_time: start, end_time: start + 1, label: 'person',
  zones: ['driveway'], has_snapshot: true, data: {}, ...overrides,
});
const review = (id, start = 100, overrides = {}) => ({
  id, camera: 'yard', start_time: start, end_time: start + 1, severity: 'alert',
  data: { objects: ['person'], zones: ['driveway'] }, ...overrides,
});

class FakeFrigate {
  constructor() {
    this.config = cameraConfig();
    this.rows = { object: [], review: [] };
    this.support = { object: true, review: true };
    this.calls = [];
    this.listCalls = [];
    this.media = true;
  }
  async capabilities() { return this.support; }
  async getConfig() { return this.config; }
  async list(kind, query) {
    this.listCalls.push({ kind, ...structuredClone(query) });
    return this.rows[kind].filter((row) => row.start_time > query.after && row.start_time < query.before)
      .sort((a, b) => b.start_time - a.start_time).slice(0, query.limit);
  }
  async get(kind, id) {
    if (this.getError) throw this.getError;
    const row = this.rows[kind].find((item) => item.id === id);
    if (!row) throw new FrigateError('http_404', 404);
    return row;
  }
  async hasMedia() { return this.media; }
  async regenerate(kind, id, source) {
    this.calls.push({ kind, id, source });
    if (this.regenerateError) throw this.regenerateError;
    return { accepted: true };
  }
  close() {}
}

function setup(t, overlay = {}, existing = {}) {
  const directory = existing.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'frigate-backlog-test-'));
  if (!existing.directory) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = existing.clock ?? { now: 500_000 };
  const client = existing.client ?? new FakeFrigate();
  const gate = existing.gate ?? { ready: true };
  const settings = {
    enabled: true, url: 'http://frigate.test:5000', state_path: path.join(directory, 'state.json'),
    pollIntervalMs: 100, liveGraceMs: 1_000, requestTimeoutMs: 100, generationTimeoutMs: 5_000,
    retryIntervalMs: 1_000, maxRetryIntervalMs: 60_000, page_size: 100, max_jobs: 100, ...overlay,
  };
  const worker = new FrigateCatchup(settings, { client, clock: () => clock.now, canRun: () => gate.ready });
  worker.start();
  clearTimeout(worker.timer);
  worker.timer = null;
  t.after(() => worker.stop());
  const manual = () => { worker.scanMissing(); clearTimeout(worker.timer); worker.timer = null; };
  return { worker, client, gate, clock, settings, directory, manual };
}

test('changing the Frigate origin preserves old backlog and reports a specific host-change diagnostic', async (t) => {
  const first = setup(t);
  await first.worker.stop();
  const original = fs.readFileSync(first.settings.state_path, 'utf8');
  const second = setup(t, { url: 'http://another-frigate.test:5000' }, { directory: first.directory });
  await second.worker.tick();
  assert.equal(second.worker.status().last_error, 'backlog_origin_changed');
  assert.equal(second.client.calls.length, 0);
  assert.equal(fs.readFileSync(first.settings.state_path, 'utf8'), original);
});

test('Frigate eligibility respects effective per-camera filters and runtime toggles', () => {
  const config = cameraConfig();
  assert.equal(frigateEligibility('object', object('o'), config).source, 'snapshot');
  assert.equal(frigateEligibility('object', object('o', 1, { label: 'dog' }), config).reason, 'label_filtered');
  assert.equal(frigateEligibility('object', object('o', 1, { zones: [] }), config).reason, 'zone_filtered');
  config.cameras.yard.objects.genai.enabled = false;
  assert.equal(frigateEligibility('object', object('o'), config).eligible, false);
  assert.equal(frigateEligibility('review', review('r'), config).eligible, true);
  config.cameras.yard.review.genai.alerts = false;
  assert.equal(frigateEligibility('review', review('r'), config).eligible, false);
  assert.equal(frigateEligibility('review', review('r', 1, { severity: 'detection' }), config).eligible, true);
  config.cameras.yard.enabled = false;
  assert.equal(frigateEligibility('review', review('r'), config).eligible, false);
});

test('existing or partial descriptions are never overwritten', () => {
  assert.equal(hasFrigateDescription('object', { data: { description: 'hello' } }), true);
  assert.equal(hasFrigateDescription('object', { data: { description: ' ' } }), false);
  assert.equal(hasFrigateDescription('review', { data: { metadata: { title: 'hello' } } }), true);
  assert.equal(hasFrigateDescription('review', { data: { metadata: {} } }), false);
});

test('unknown early-trigger eligibility fails closed rather than inventing a live trigger', () => {
  const config = cameraConfig();
  config.cameras.yard.objects.genai.send_triggers = { tracked_object_end: false, after_significant_updates: 5 };
  assert.equal(frigateEligibility('object', object('o'), config).reason, 'early_trigger_only_not_recoverable');
});

test('automatic recovery starts at first enable and remembers its boundary across restart', async (t) => {
  const first = setup(t);
  first.client.rows.object = [object('before', 499), object('after', 501)];
  first.clock.now = 510_000;
  await first.worker.tick();
  assert.deepEqual(first.client.calls.map((call) => call.id), ['after']);
  await first.worker.stop();
  const second = setup(t, {}, first);
  assert.equal(second.worker.status().enabled_at, 500_000);
  assert.equal(second.worker.status().active_job.id, 'after');
  await second.worker.tick();
  assert.equal(first.client.calls.length, 1, 'restart reconciles existing handoff instead of repeating it');
});

test('manual scan includes retained old objects and reviews, newest timestamp first', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('old', 100), object('middle', 200)];
  context.client.rows.review = [review('new', 300)];
  context.manual();
  await context.worker.tick();
  assert.deepEqual(context.client.calls, [{ kind: 'review', id: 'new', source: 'recordings' }]);
  assert.equal(context.worker.status().counts.waiting_result, 1);
  assert.equal(context.worker.status().totals.completed, 0, 'accepted is not complete');
  context.client.rows.review[0].data.metadata = { title: 'done' };
  await context.worker.tick();
  assert.equal(context.worker.status().totals.completed, 1);
  await context.worker.tick();
  assert.equal(context.client.calls[1].id, 'middle');
});

test('live foreground readiness blocks handoff while allowing scan discovery', async (t) => {
  const context = setup(t);
  context.gate.ready = false;
  context.client.rows.object = [object('old')];
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().total_queued, 1);
  assert.equal(context.client.calls.length, 0);
  context.gate.ready = true;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 1);
});

test('readiness is checked again after media validation before handoff', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('old')];
  context.client.hasMedia = async () => { context.gate.ready = false; return true; };
  context.manual();
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
});

test('live generation gets a grace period and an in-progress object is revisited after scan watermark', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('long', 501, { end_time: null })];
  context.clock.now = 503_000;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_live, 1);
  context.client.rows.object[0].end_time = 505;
  context.clock.now = 505_500;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
  context.clock.now = 507_000;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 1);
});

test('normal Frigate completion during grace prevents unnecessary regeneration', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('fresh', 501)];
  context.clock.now = 502_500;
  await context.worker.tick();
  context.client.rows.object[0].data.description = 'a live description';
  context.clock.now = 504_000;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
  assert.equal(context.worker.status().totals.completed, 1);
});

test('deleted media and deleted event are terminal skips, not endless retries', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('missing-media')];
  context.client.media = false;
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().recent_jobs[0].reason, 'media_expired_or_missing');
  assert.equal(context.worker.status().total_queued, 0);
  context.client.rows.object = [object('deleted', 501)];
  context.clock.now = 505_000;
  context.gate.ready = false;
  await context.worker.tick();
  context.client.rows.object = [];
  context.gate.ready = true;
  await context.worker.tick();
  assert.equal(context.worker.status().recent_jobs[0].reason, 'event_deleted');
});

test('timeout handoff is uncertain, reconciled and delayed instead of immediately duplicated', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('slow')];
  context.client.regenerateError = new FrigateError('request_timeout');
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().active_job.reason, 'handoff_uncertain');
  context.clock.now += 4_000;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 1);
  context.clock.now += 2_000;
  context.gate.ready = false;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_result, 1);
  context.gate.ready = true;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.retrying, 1);
  assert.equal(context.client.calls.length, 1);
  context.clock.now += 1_500;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 2);
});

test('missing capabilities do not probe mutation APIs or enqueue unsupported review requests', async (t) => {
  const context = setup(t);
  context.client.support.review = false;
  context.client.rows.review = [review('review')];
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().capabilities.review, false);
  assert.equal(context.client.calls.length, 0);
  assert.equal(context.worker.status().scan.manual, true, 'unsupported manual work stays discoverable after upgrade');
});

test('full queue retains scan cursor, drains, and resumes all rows without losses', async (t) => {
  const context = setup(t, { max_jobs: 1, page_size: 2 });
  context.client.rows.object = [object('one', 300), object('two', 200), object('three', 100)];
  context.manual();
  context.client.media = false;
  for (let index = 0; index < 8; index += 1) await context.worker.tick();
  assert.equal(context.worker.status().totals.skipped, 3);
  assert.equal(context.worker.status().scan.manual, false);
  assert.equal(context.worker.status().total_queued, 0);
});

test('equal timestamps expand page boundary instead of dropping events', async (t) => {
  const context = setup(t, { page_size: 2 });
  context.client.rows.object = [object('a'), object('b'), object('c'), object('d', 99)];
  context.client.media = false;
  context.manual();
  for (let index = 0; index < 8; index += 1) await context.worker.tick();
  assert.equal(context.worker.status().totals.skipped, 4);
  assert.equal(context.worker.status().scan.manual, false);
  assert.ok(context.client.listCalls.some((call) => call.limit > 2));
});

test('interrupted manual scan persists exact progress across restart', async (t) => {
  const context = setup(t, { page_size: 2 });
  context.gate.ready = false;
  context.client.rows.object = [object('a', 300), object('b', 200), object('c', 100)];
  context.manual();
  await context.worker.tick();
  const before = context.worker.state.scans.manual.object.before;
  await context.worker.stop();
  const resumed = setup(t, { page_size: 2 }, context);
  assert.equal(resumed.worker.state.scans.manual.object.before, before);
  await resumed.worker.tick();
  assert.equal(resumed.worker.status().total_queued, 3);
});

test('persisted jobs and public status do not contain prompts, snapshots or description content', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o', 100, { thumbnail: 'PRIVATE_BASE64_IMAGE', data: { private: 'PRIVATE_PROMPT' } })];
  context.manual();
  await context.worker.tick();
  const persisted = fs.readFileSync(context.settings.state_path, 'utf8');
  assert.doesNotMatch(persisted, /PRIVATE_BASE64_IMAGE|PRIVATE_PROMPT|auth_token|password/);
  assert.doesNotMatch(JSON.stringify(context.worker.status()), /PRIVATE_BASE64_IMAGE|PRIVATE_PROMPT|auth_token|password/);
  assert.equal(fs.statSync(context.settings.state_path).mode & 0o777, 0o600);
});

test('corrupt persistence fails closed without overwriting the unreadable file', async (t) => {
  const context = setup(t);
  await context.worker.stop();
  fs.writeFileSync(context.settings.state_path, 'not valid json');
  const resumed = setup(t, {}, context);
  assert.equal(resumed.worker.status().state, 'error');
  assert.equal(resumed.worker.status().last_error, 'backlog_state_unreadable');
  assert.equal(fs.readFileSync(context.settings.state_path, 'utf8'), 'not valid json');
  assert.throws(() => resumed.worker.scanMissing());
});

test('authentication failure during status reconciliation does not release native handoff', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o')];
  context.manual();
  await context.worker.tick();
  context.client.getError = new FrigateError('authentication_failed', 401);
  context.clock.now += 60_000;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_result, 1);
  assert.equal(context.worker.status().last_error, 'authentication_failed');
  assert.equal(context.client.calls.length, 1);
});

test('scan frontiers defer old jobs until newer unseen review pages are discovered', async (t) => {
  const context = setup(t, { page_size: 2 });
  context.client.rows.object = [object('old-object', 50)];
  context.client.rows.review = [
    review('already-a', 300, { data: { metadata: { title: 'done' } } }),
    review('already-b', 250, { data: { metadata: { title: 'done' } } }),
    review('missing-newer', 200),
  ];
  context.manual();
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
  assert.equal(context.worker.status().scan.blocked_reason, 'discovering_newer_events');
  for (let index = 0; index < 5 && !context.client.calls.length; index += 1) await context.worker.tick();
  assert.equal(context.client.calls[0].id, 'missing-newer');
});

test('unsupported eligibility is visible as bounded exclusion counts and camera warnings', async (t) => {
  const context = setup(t);
  context.client.config.cameras.yard.objects.genai.send_triggers = { tracked_object_end: false };
  context.client.rows.object = [object('early-only')];
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().eligibility_skipped.early_trigger_only_not_recoverable, 1);
  assert.deepEqual(context.worker.status().warnings, [{ camera: 'yard', code: 'early_trigger_only_not_recoverable' }]);
  assert.equal(context.client.calls.length, 0);
});

test('retry backoff also grows for metadata failures before native dispatch', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o')];
  context.client.getError = new FrigateError('request_timeout');
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.state.jobs[0].next_attempt_at - context.clock.now, 1_000);
  context.clock.now += 1_000;
  await context.worker.tick();
  assert.equal(context.worker.state.jobs[0].next_attempt_at - context.clock.now, 2_000);
  assert.equal(context.client.calls.length, 0);
});

test('restore whitelists metadata and does not expose unknown saved reason or extra fields', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o')];
  context.manual();
  context.gate.ready = false;
  await context.worker.tick();
  await context.worker.stop();
  const state = JSON.parse(fs.readFileSync(context.settings.state_path, 'utf8'));
  state.jobs[0].reason = 'PRIVATE_TOKEN';
  state.jobs[0].password = 'PRIVATE_PASSWORD';
  state.totals.completed = -99;
  state.totals.secret = 'PRIVATE_SECRET';
  fs.writeFileSync(context.settings.state_path, JSON.stringify(state));
  const resumed = setup(t, {}, context);
  assert.doesNotMatch(JSON.stringify(resumed.worker.status()), /PRIVATE/);
  assert.equal(resumed.worker.status().totals.completed, 0);
  assert.equal(resumed.worker.status().queue_items[0].reason, 'frigate_operation_failed');
  resumed.worker.persist();
  assert.doesNotMatch(fs.readFileSync(context.settings.state_path, 'utf8'), /PRIVATE/);
});

test('ongoing objects entering required zones after discovery are retained and recovered', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('moving', 501, { end_time: null, zones: [] })];
  context.clock.now = 503_000;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_live, 1);
  context.clock.now = 800_000;
  context.client.rows.object[0].end_time = 790;
  context.client.rows.object[0].zones = ['driveway'];
  await context.worker.tick();
  assert.equal(context.client.calls[0].id, 'moving');
});

test('ongoing review escalating to eligible alert is not lost behind discovery watermark', async (t) => {
  const context = setup(t);
  context.client.config.cameras.yard.review.genai.detections = false;
  context.client.rows.review = [review('escalating', 501, { severity: 'detection', end_time: null })];
  context.clock.now = 503_000;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_live, 1);
  context.clock.now = 800_000;
  context.client.rows.review[0].end_time = 790;
  context.client.rows.review[0].severity = 'alert';
  await context.worker.tick();
  assert.equal(context.client.calls[0].id, 'escalating');
});

test('discovery overlap includes a recently delayed database row without scanning before enable', async (t) => {
  const context = setup(t);
  context.clock.now = 510_000;
  await context.worker.tick();
  context.client.rows.object = [object('late', 509.5), object('old', 499)];
  context.clock.now = 513_000;
  await context.worker.tick();
  assert.deepEqual(context.client.calls.map((call) => call.id), ['late']);
});

test('live completion during media preflight is rechecked immediately before PUT', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o')];
  context.client.hasMedia = async () => {
    context.client.rows.object[0].data.description = 'live completion';
    return true;
  };
  context.manual();
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
  assert.equal(context.worker.status().recent_jobs[0].reason, 'completed_by_frigate');
});
