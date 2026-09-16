import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FrigateClient, FrigateError } from './frigate-client.js';

const SCHEMA = 1;
const KINDS = ['object', 'review'];
const STATES = new Set(['pending', 'waiting_live', 'waiting_result', 'retrying']);
const HISTORY_LIMIT = 200;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const ELIGIBILITY_REASONS = new Set([
  'camera_disabled', 'description_provider_unavailable', 'false_positive', 'object_descriptions_disabled',
  'label_filtered', 'zone_filtered', 'early_trigger_only_not_recoverable', 'review_descriptions_disabled',
]);
const JOB_REASONS = new Set([
  ...ELIGIBILITY_REASONS, 'description_confirmed', 'completed_by_frigate', 'media_expired_or_missing',
  'event_deleted', 'description_not_confirmed', 'generation_requested', 'handoff_uncertain',
  'connection_failed', 'request_timeout', 'stopped', 'response_interrupted', 'response_too_large',
  'authentication_failed', 'invalid_json_response', 'invalid_event_response', 'invalid_recording_list',
  'invalid_media_response', 'generation_not_accepted', 'frigate_operation_failed',
]);
const text = (value, limit = 120) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit);
const seconds = (value) => Number.isFinite(Number(value)) && value !== null ? Number(value) : null;
const list = (value) => Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
const overlaps = (required, actual) => !required.length || required.some((value) => actual.includes(value));
const afterTimestamp = (value) => value + Math.max(0.000001, Math.abs(value) * Number.EPSILON * 2);
const beforeTimestamp = (value) => value - Math.max(0.000001, Math.abs(value) * Number.EPSILON * 2);
const key = (kind, id) => `${kind}:${id}`;
const safeReason = (value) => value === null || value === undefined ? null
  : JOB_REASONS.has(value) || /^http_[1-5][0-9]{2}$/.test(value) ? value : 'frigate_operation_failed';
const counter = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const restoredJob = (job) => ({
  kind: job.kind, id: job.id, camera: job.camera, event_time: job.event_time, state: job.state,
  reason: safeReason(job.reason), attempts: counter(job.attempts), failures: counter(job.failures),
  created_at: Number.isFinite(job.created_at) ? job.created_at : 0,
  next_attempt_at: job.next_attempt_at, ...(Number.isFinite(job.completed_at) ? { completed_at: job.completed_at } : {}),
});

export function hasFrigateDescription(kind, item) {
  if (kind === 'object') return typeof item?.data?.description === 'string' && Boolean(item.data.description.trim());
  const metadata = item?.data?.metadata;
  // Never overwrite partial/manual metadata: repairing existing descriptions is out of scope.
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) && Object.keys(metadata).length > 0;
}

export function frigateEligibility(kind, item, config) {
  const camera = config?.cameras?.[item?.camera];
  if (!camera || camera.enabled !== true) return { eligible: false, reason: 'camera_disabled' };
  const providers = Object.values(config.genai ?? {});
  if (!providers.some((provider) => list(provider?.roles).includes('descriptions'))) {
    return { eligible: false, reason: 'description_provider_unavailable' };
  }
  if (item.false_positive === true) return { eligible: false, reason: 'false_positive' };
  if (kind === 'object') {
    const policy = camera.objects?.genai;
    if (policy?.enabled !== true) return { eligible: false, reason: 'object_descriptions_disabled' };
    if (!overlaps(list(policy.objects), [item.label])) return { eligible: false, reason: 'label_filtered' };
    if (!overlaps(list(policy.required_zones), list(item.zones))) return { eligible: false, reason: 'zone_filtered' };
    // The retained event API does not expose significant-update counts. Do not
    // invent eligibility when the camera explicitly only requests early triggers.
    if (policy.send_triggers?.tracked_object_end === false) {
      return { eligible: false, reason: 'early_trigger_only_not_recoverable' };
    }
    return { eligible: true, source: policy.use_snapshot ? 'snapshot' : 'thumbnails' };
  }
  const review = camera.review;
  const severity = item.severity === 'alert' ? 'alerts' : item.severity === 'detection' ? 'detections' : null;
  if (!severity || review?.genai?.enabled !== true || review.genai[severity] !== true || review[severity]?.enabled !== true) {
    return { eligible: false, reason: 'review_descriptions_disabled' };
  }
  const objects = [...list(item.data?.objects), ...list(item.data?.audio)].map((value) => String(value).replace(/-verified$/, ''));
  if (severity === 'alerts' && !list(review.alerts.labels).length) return { eligible: false, reason: 'label_filtered' };
  if (!overlaps(list(review[severity].labels), objects)) return { eligible: false, reason: 'label_filtered' };
  if (!overlaps(list(review[severity].required_zones), list(item.data?.zones))) return { eligible: false, reason: 'zone_filtered' };
  return { eligible: true, source: 'recordings' };
}

function safeFailure(error) {
  return error instanceof FrigateError ? text(error.code, 64) : 'frigate_operation_failed';
}

function emptyState(now, origin) {
  return {
    schema_version: SCHEMA, origin, enabled_at: now,
    watermarks: { object: now / 1000, review: now / 1000 },
    scans: { automatic: {}, manual: {} }, jobs: [], recent: [],
    totals: { completed: 0, skipped: 0, retry_attempts: 0 },
    eligibility_skipped: {},
  };
}

/** Persistent descriptions-to-do list, never an archive of HTTP/image payloads.
 * Native regeneration is an asynchronous handoff. At most one handoff is
 * outstanding; completion is confirmed by reading Frigate's saved metadata.
 */
export class FrigateCatchup {
  constructor(config, { logger, canRun = () => false, clock = () => Date.now(), client, onChange = () => {} } = {}) {
    this.settings = config.frigate ?? config;
    this.clock = clock;
    this.logger = logger;
    this.canRun = canRun;
    this.client = client ?? (this.settings.enabled ? new FrigateClient(this.settings) : null);
    this.onChange = onChange;
    this.running = false;
    this.timer = null;
    this.busy = null;
    this.storeError = null;
    this.lastError = null;
    this.blockedReason = null;
    this.capabilities = { object: false, review: false, checked: false };
    this.lastCapabilityCheck = 0;
    this.nextPollAt = null;
    this.runtimeConfig = null;
    this.state = null;
    this.origin = createHash('sha256').update(this.settings.url ? new URL(this.settings.url).origin : '').digest('hex');
  }

  restore() {
    let raw;
    try {
      if (fs.statSync(this.settings.state_path).size > MAX_STATE_BYTES) throw new Error('too_large');
      raw = JSON.parse(fs.readFileSync(this.settings.state_path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.state = emptyState(this.clock(), this.origin);
        this.persist();
        return;
      }
      this.storeError = 'backlog_state_unreadable';
      return;
    }
    try {
      if (raw.schema_version === SCHEMA && typeof raw.origin === 'string' && raw.origin !== this.origin) {
        this.storeError = 'backlog_origin_changed';
        return;
      }
      if (raw.schema_version !== SCHEMA || raw.origin !== this.origin || !Number.isFinite(raw.enabled_at)
        || !raw.watermarks || !raw.scans?.automatic || !raw.scans?.manual || !Array.isArray(raw.jobs)
        || !Array.isArray(raw.recent) || raw.jobs.length > 100_000) throw new Error('invalid');
      const ids = new Set();
      for (const job of raw.jobs) {
        if (!KINDS.includes(job.kind) || typeof job.id !== 'string' || !job.id || job.id.length > 256
          || typeof job.camera !== 'string' || job.camera.length > 256 || !STATES.has(job.state)
          || !Number.isFinite(job.event_time) || !Number.isFinite(job.next_attempt_at)
          || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || ids.has(key(job.kind, job.id))) throw new Error('invalid_job');
        ids.add(key(job.kind, job.id));
        // Keep waiting_result intact: a restart is not evidence the earlier
        // native request stopped. Verify it before contemplating another PUT.
      }
      for (const kind of KINDS) {
        if (!Number.isFinite(raw.watermarks[kind])) throw new Error('invalid_cursor');
        for (const mode of ['automatic', 'manual']) {
          const scan = raw.scans[mode][kind];
          if (scan && (!Number.isFinite(scan.after) || !Number.isFinite(scan.before)
            || !Number.isFinite(scan.until) || !Number.isInteger(scan.limit) || scan.limit < 1
            || scan.limit > 10_000 || (scan.seen && (!Array.isArray(scan.seen) || scan.seen.length > 10_000
              || scan.seen.some((id) => typeof id !== 'string' || id.length > 264))))) throw new Error('invalid_scan');
        }
      }
      if (raw.jobs.filter((job) => job.state === 'waiting_result').length > 1) throw new Error('multiple_handoffs');
      this.state = {
        ...emptyState(raw.enabled_at, this.origin),
        watermarks: { object: raw.watermarks.object, review: raw.watermarks.review },
        scans: { automatic: {}, manual: {} }, jobs: raw.jobs.map(restoredJob),
        recent: raw.recent.slice(-HISTORY_LIMIT).filter((job) => KINDS.includes(job.kind)
          && ['completed', 'skipped'].includes(job.state) && typeof job.id === 'string'
          && typeof job.camera === 'string' && Number.isFinite(job.event_time)).map(restoredJob),
        totals: Object.fromEntries(['completed', 'skipped', 'retry_attempts'].map((name) => [name, counter(raw.totals?.[name])])),
        eligibility_skipped: Object.fromEntries([...ELIGIBILITY_REASONS].map((reason) => [reason, counter(raw.eligibility_skipped?.[reason])])),
      };
      for (const mode of ['automatic', 'manual']) for (const kind of KINDS) {
        const scan = raw.scans[mode][kind];
        if (scan) this.state.scans[mode][kind] = {
          after: scan.after, before: scan.before, until: scan.until, limit: scan.limit, seen: scan.seen ?? [],
        };
      }
    } catch {
      this.storeError = 'backlog_state_invalid';
    }
  }

  persist() {
    if (this.storeError || !this.state) return false;
    const target = this.settings.state_path;
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(this.state)}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, target);
      // Make the rename durable as well as the file contents on Linux.
      const directory = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      this.storeError = 'backlog_state_write_failed';
      try { fs.unlinkSync(temporary); } catch { /* nothing to clean */ }
      this.logger?.error('Frigate backlog stopped: state could not be persisted');
      return false;
    }
    this.onChange(this.status());
    return true;
  }

  start() {
    if (!this.settings.enabled || this.running) return this.status();
    this.restore();
    if (this.storeError) return this.status();
    this.running = true;
    this.schedule(0);
    return this.status();
  }

  schedule(delay = this.settings.pollIntervalMs ?? 30_000) {
    if (!this.running || this.storeError) return;
    clearTimeout(this.timer);
    this.nextPollAt = this.clock() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    this.nextPollAt = null;
    clearTimeout(this.timer);
    this.timer = null;
    this.client?.close?.();
    await this.busy;
    if (this.state && !this.storeError) this.persist();
  }

  status() {
    const counts = { pending: 0, waiting_live: 0, waiting_result: 0, retrying: 0 };
    for (const job of this.state?.jobs ?? []) counts[job.state] += 1;
    const publicJob = (job) => ({
      kind: job.kind, id: text(job.id), camera: text(job.camera), event_time: job.event_time,
      state: job.state, reason: safeReason(job.reason), attempts: job.attempts,
      next_attempt_at: job.next_attempt_at ?? null, completed_at: job.completed_at ?? null,
    });
    const queueItems = [...(this.state?.jobs ?? [])].sort((a, b) => b.event_time - a.event_time).slice(0, 30).map(publicJob);
    return {
      enabled: Boolean(this.settings.enabled),
      state: !this.settings.enabled ? 'disabled' : this.storeError ? 'error' : !this.running ? 'stopped'
        : this.lastError ? 'degraded' : 'running',
      enabled_at: this.state?.enabled_at ?? null,
      capabilities: { ...this.capabilities }, counts,
      total_queued: Object.values(counts).reduce((sum, value) => sum + value, 0),
      totals: { ...(this.state?.totals ?? {}) },
      active_job: this.state?.jobs.find((job) => job.state === 'waiting_result')
        ? publicJob(this.state.jobs.find((job) => job.state === 'waiting_result')) : null,
      recent_jobs: (this.state?.recent ?? []).slice(-30).reverse().map(publicJob),
      pending_jobs: queueItems, queue_items: queueItems,
      eligibility_skipped: { ...(this.state?.eligibility_skipped ?? {}) },
      warnings: Object.entries(this.runtimeConfig?.cameras ?? {})
        .filter(([, camera]) => camera.enabled && camera.objects?.genai?.enabled
          && camera.objects.genai.send_triggers?.tracked_object_end === false)
        .slice(0, 100).map(([name]) => ({ camera: text(name), code: 'early_trigger_only_not_recoverable' })),
      scan: {
        automatic: Object.keys(this.state?.scans.automatic ?? {}).length > 0,
        manual: Object.keys(this.state?.scans.manual ?? {}).length > 0,
        blocked_reason: this.blockedReason,
      },
      last_error: this.storeError ?? this.lastError, next_poll_at: this.nextPollAt,
    };
  }

  scanMissing() {
    if (!this.settings.enabled || !this.running || !this.state || this.storeError) {
      const error = new Error('Frigate catch-up must be enabled and its state writable');
      error.statusCode = this.storeError ? 503 : 409;
      throw error;
    }
    const now = this.clock();
    for (const kind of KINDS) {
      // Clicking twice resumes the same scan; it never resets a pending cursor.
      this.state.scans.manual[kind] ??= this.newScan(1, now / 1000);
    }
    if (!this.persist()) {
      const error = new Error('Frigate catch-up state could not be saved');
      error.statusCode = 503;
      throw error;
    }
    this.schedule(0);
    return this.status();
  }

  newScan(after, until) {
    return { after, before: afterTimestamp(until), until, limit: this.settings.page_size ?? 100, seen: [] };
  }

  tick() {
    if (this.busy) return this.busy;
    if (!this.running || this.storeError) return Promise.resolve();
    this.busy = this.runTick().catch((error) => {
      if (this.running) {
        this.lastError = safeFailure(error);
        this.logger?.warn('Frigate backlog operation failed', { code: this.lastError });
      }
    }).finally(() => { this.busy = null; this.onChange(this.status()); });
    return this.busy;
  }

  async runTick() {
    this.blockedReason = null;
    if (!this.capabilities.checked || this.clock() - this.lastCapabilityCheck >= 300_000) {
      this.capabilities = { ...await this.client.capabilities(), checked: true };
      this.lastCapabilityCheck = this.clock();
    }
    this.runtimeConfig = await this.client.getConfig();
    if (!this.runtimeConfig?.cameras || typeof this.runtimeConfig.cameras !== 'object') {
      throw new FrigateError('invalid_camera_configuration');
    }
    if (!this.running) return;
    this.lastError = null;
    for (const kind of KINDS) {
      if (!this.capabilities[kind]) continue;
      // Frigate writes event metadata asynchronously. Revisit a small discovery
      // window so a just-committed row is not missed at the last poll boundary.
      const lookback = Math.max(this.settings.liveGraceMs ?? 120_000, (this.settings.pollIntervalMs ?? 30_000) * 2) / 1000;
      this.state.scans.automatic[kind] ??= this.newScan(
        beforeTimestamp(Math.max(this.state.enabled_at / 1000, this.state.watermarks[kind] - lookback)), this.clock() / 1000,
      );
      for (const mode of ['automatic', 'manual']) {
        if (!this.running || this.storeError) return;
        const scan = this.state.scans[mode][kind];
        if (scan) await this.scanPage(mode, kind, scan);
      }
    }
    if (!this.running || this.storeError) return;
    await this.processJobs();
    this.persist();
  }

  async scanPage(mode, kind, scan) {
    const rows = await this.client.list(kind, scan);
    if (!this.running) return;
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.id !== 'string' || !row.id || row.id.length > 256
      || typeof row.camera !== 'string' || !row.camera || row.camera.length > 256 || !Number.isFinite(seconds(row.start_time)))) {
      throw new FrigateError('invalid_event_list');
    }
    const known = new Set([...this.state.jobs.map((job) => key(job.kind, job.id)), ...(scan.seen ?? [])]);
    const completedRecently = new Set(this.state.recent.map((job) => key(job.kind, job.id)));
    for (const item of rows) {
      const start = seconds(item.start_time);
      if (start < scan.after || start > scan.until || (mode === 'automatic' && start * 1000 < this.state.enabled_at)) continue;
      if (known.has(key(kind, item.id)) || completedRecently.has(key(kind, item.id)) || hasFrigateDescription(kind, item)) continue;
      const eligibility = frigateEligibility(kind, item, this.runtimeConfig);
      const end = seconds(item.end_time);
      const camera = this.runtimeConfig.cameras[item.camera];
      // An active object can enter a required zone later, and an active review
      // can escalate from a detection to an alert. Remember such IDs until they
      // end; their start times will eventually fall behind the scan watermark.
      const watchUntilEnded = end === null && camera?.enabled === true
        && (kind === 'object' ? camera.objects?.genai?.enabled : camera.review?.genai?.enabled) === true
        && Object.values(this.runtimeConfig.genai ?? {}).some((provider) => list(provider?.roles).includes('descriptions'));
      if (!eligibility.eligible && !watchUntilEnded) {
        this.state.eligibility_skipped[eligibility.reason] = counter(this.state.eligibility_skipped[eligibility.reason]) + 1;
        (scan.seen ??= []).push(key(kind, item.id));
        continue;
      }
      if (this.state.jobs.length >= (this.settings.max_jobs ?? 10_000)) {
        this.blockedReason = 'backlog_capacity_reached';
        this.persist();
        return; // Do not advance: this page is retried when capacity is available.
      }
      this.state.jobs.push({
        kind, id: text(item.id, 256), camera: text(item.camera, 256), event_time: start,
        state: end === null || end * 1000 + (this.settings.liveGraceMs ?? 120_000) > this.clock() ? 'waiting_live' : 'pending',
        reason: null, attempts: 0, failures: 0, created_at: this.clock(), next_attempt_at: end === null
          ? this.clock() + (this.settings.pollIntervalMs ?? 30_000)
          : Math.max(this.clock(), end * 1000 + (this.settings.liveGraceMs ?? 120_000)),
      });
      known.add(key(kind, item.id));
      (scan.seen ??= []).push(key(kind, item.id));
    }
    if (rows.length < scan.limit) {
      if (mode === 'automatic') this.state.watermarks[kind] = scan.until;
      delete this.state.scans[mode][kind];
    } else {
      // before is exclusive and these APIs do not have an ID cursor. Revisit the
      // entire last timestamp and expand ties rather than silently losing rows.
      const oldest = Math.min(...rows.map((row) => seconds(row.start_time)));
      const next = afterTimestamp(oldest);
      if (next >= scan.before || rows.every((row) => seconds(row.start_time) === oldest)) {
        if (scan.limit >= 10_000) {
          this.blockedReason = 'pagination_tie_limit';
          this.persist();
          return;
        }
        scan.limit = Math.min(scan.limit * 2, 10_000);
      } else {
        scan.before = next;
        scan.limit = this.settings.page_size ?? 100;
        const boundary = new Set(rows.filter((row) => seconds(row.start_time) === oldest).map((row) => key(kind, row.id)));
        scan.seen = (scan.seen ?? []).filter((id) => boundary.has(id));
      }
    }
    this.persist();
  }

  readiness() {
    if (!this.running || this.storeError) return false;
    const result = this.canRun();
    const allowed = typeof result === 'boolean' ? result : result?.allowed === true || result?.ready === true;
    if (!allowed) this.blockedReason = typeof result === 'object' ? text(result.reason, 80) || 'foreground_busy' : 'foreground_busy';
    return allowed;
  }

  finish(job, state, reason) {
    this.state.jobs = this.state.jobs.filter((other) => other !== job);
    this.state.recent.push({ ...job, state, reason, completed_at: this.clock(), next_attempt_at: null });
    this.state.recent = this.state.recent.slice(-HISTORY_LIMIT);
    this.state.totals[state] = (this.state.totals[state] ?? 0) + 1;
    this.persist();
  }

  retry(job, reason) {
    const base = this.settings.retryIntervalMs ?? 60_000;
    job.failures = (job.failures ?? 0) + 1;
    const delay = Math.min(this.settings.maxRetryIntervalMs ?? 3_600_000, base * (2 ** Math.min(16, job.failures - 1)));
    job.state = 'retrying';
    job.reason = reason;
    job.next_attempt_at = this.clock() + Math.max(delay, this.settings.liveGraceMs ?? 120_000);
    this.state.totals.retry_attempts += 1;
    this.persist();
  }

  async processJobs() {
    const active = this.state.jobs.find((job) => job.state === 'waiting_result');
    if (active) {
      await this.checkJob(active, true);
      return; // Never dispatch a second background job in the same tick.
    }
    if (!this.readiness()) return;
    const jobs = this.state.jobs.filter((job) => job.next_attempt_at <= this.clock())
      .sort((a, b) => b.event_time - a.event_time || a.id.localeCompare(b.id));
    // Bound metadata checks in one poll, including expired/disabled jobs.
    for (const job of jobs.slice(0, 10)) {
      if (!this.readiness()) return;
      if (!this.capabilities[job.kind]) continue;
      const frontier = Math.max(0, ...['automatic', 'manual'].flatMap((mode) => KINDS
        .filter((kind) => this.capabilities[kind] && this.state.scans[mode][kind])
        .map((kind) => this.state.scans[mode][kind].before)));
      if (job.event_time < frontier) {
        if (this.state.jobs.length < (this.settings.max_jobs ?? 10_000)) {
          this.blockedReason = 'discovering_newer_events';
          return;
        }
        // A full bounded queue must be allowed to drain or scanning deadlocks.
        // In that case ordering is newest-first among discovered jobs only.
        this.blockedReason = 'ordering_capacity_limited';
      }
      const dispatched = await this.checkJob(job, false);
      if (dispatched || this.storeError || !this.running) return;
    }
  }

  async checkJob(job, verifyOnly) {
    try {
      const item = await this.client.get(job.kind, job.id);
      if (!this.running) return false;
      if (hasFrigateDescription(job.kind, item)) {
        this.finish(job, 'completed', job.attempts ? 'description_confirmed' : 'completed_by_frigate');
        return false;
      }
      if (verifyOnly) {
        if (this.clock() < job.next_attempt_at) return true;
        // A timeout is not proof of failure. Require a foreground-idle window
        // before releasing our native handoff, then impose another retry grace.
        if (this.readiness()) this.retry(job, 'description_not_confirmed');
        return true;
      }
      const end = seconds(item.end_time);
      if (end === null || end * 1000 + (this.settings.liveGraceMs ?? 120_000) > this.clock()) {
        job.state = 'waiting_live';
        job.next_attempt_at = end === null ? this.clock() + (this.settings.pollIntervalMs ?? 30_000)
          : end * 1000 + (this.settings.liveGraceMs ?? 120_000);
        return false;
      }
      const eligibility = frigateEligibility(job.kind, item, this.runtimeConfig);
      if (!eligibility.eligible) { this.finish(job, 'skipped', eligibility.reason); return false; }
      if (!await this.client.hasMedia(job.kind, item, eligibility.source)) {
        if (this.running) this.finish(job, 'skipped', 'media_expired_or_missing');
        return false;
      }
      if (!this.readiness()) return false;
      // Metadata/media checks may take seconds. Re-read uncached configuration
      // and description immediately before PUT to avoid replacing a live result
      // or acting on a camera toggle changed while this poll was in progress.
      const latestConfig = await this.client.getConfig();
      const latestItem = await this.client.get(job.kind, job.id);
      if (!this.running) return false;
      if (hasFrigateDescription(job.kind, latestItem)) {
        this.finish(job, 'completed', 'completed_by_frigate');
        return false;
      }
      const latestEligibility = frigateEligibility(job.kind, latestItem, latestConfig);
      if (!latestEligibility.eligible) { this.finish(job, 'skipped', latestEligibility.reason); return false; }
      if (latestEligibility.source !== eligibility.source || seconds(latestItem.end_time) === null) {
        job.state = 'waiting_live';
        job.next_attempt_at = this.clock() + (this.settings.pollIntervalMs ?? 30_000);
        return false;
      }
      if (!this.readiness()) return false;
      // Persist BEFORE the non-idempotent handoff. A crash or network timeout
      // after this point must reconcile metadata, never immediately repeat PUT.
      job.state = 'waiting_result';
      job.reason = 'generation_requested';
      job.attempts += 1;
      job.next_attempt_at = this.clock() + (this.settings.generationTimeoutMs ?? 600_000);
      if (!this.persist() || !this.readiness()) {
        if (!this.storeError) { job.state = 'pending'; this.persist(); }
        return false;
      }
      try {
        await this.client.regenerate(job.kind, job.id, eligibility.source);
      } catch (error) {
        if ([400, 401, 403, 404, 405, 422, 429].includes(error.statusCode)) {
          if (error.statusCode === 404) this.finish(job, 'skipped', 'event_deleted');
          else this.retry(job, safeFailure(error));
        } else {
          // Transport/5xx errors can occur after native dispatch; wait and verify.
          job.reason = 'handoff_uncertain';
          this.persist();
        }
      }
      return true;
    } catch (error) {
      if (!this.running) return false;
      if (error.statusCode === 404) { this.finish(job, 'skipped', 'event_deleted'); return false; }
      if (verifyOnly) {
        this.lastError = safeFailure(error);
        return true; // Cannot confirm status; keep the single native handoff.
      }
      this.retry(job, safeFailure(error));
      return false;
    }
  }
}
