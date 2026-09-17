import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FrigateClient, FrigateError } from './frigate-client.js';

const SCHEMA = 1;
const KINDS = ['object', 'review'];
const STATES = new Set(['pending', 'waiting_live', 'waiting_result', 'retrying']);
const HISTORY_LIMIT = 1_000;
const SUPPRESSION_LIMIT = 10_000;
const SUPPRESSION_TTL = 30 * 24 * 60 * 60 * 1_000;
const VIEWS = new Set(['all', 'waiting', 'awaiting', 'retrying', 'attention', 'completed', 'skipped']);
const MEDIA_REASONS = new Set(['media_expired_or_missing', 'event_deleted']);
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
  'invalid_media_response', 'invalid_camera_configuration', 'generation_not_accepted', 'frigate_operation_failed',
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
  first_failed_at: Number.isFinite(job.first_failed_at) ? job.first_failed_at : null,
  last_attempt_at: Number.isFinite(job.last_attempt_at) ? job.last_attempt_at : null,
  next_attempt_at: job.next_attempt_at, ...(Number.isFinite(job.completed_at) ? { completed_at: job.completed_at } : {}),
});
const publicJob = (job, now, attentionAfterMs) => ({
  kind: job.kind, id: text(job.id, 256), camera: text(job.camera), event_time: job.event_time,
  state: job.state, reason: safeReason(job.reason), attempts: job.attempts,
  failures: counter(job.failures), first_failed_at: job.first_failed_at ?? null,
  last_attempt_at: job.last_attempt_at ?? null,
  needs_attention: STATES.has(job.state) && Number.isFinite(job.first_failed_at)
    && now - job.first_failed_at >= attentionAfterMs,
  next_attempt_at: job.next_attempt_at ?? null, completed_at: job.completed_at ?? null,
});
const newestFirst = (a, b) => b.event_time - a.event_time || key(a.kind, a.id).localeCompare(key(b.kind, b.id));

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
    scans: { automatic: {}, manual: {} }, jobs: [], recent: [], suppressed: [],
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
    this.processBusy = null;
    this.cleanupBusy = null;
    this.cleanupTimer = null;
    this.confirmationTimer = null;
    this.nextConfirmationAt = null;
    this.confirmationFailures = 0;
    this.confirmationBackoffUntil = 0;
    this.lockedJobs = new Set();
    this.nextCleanupAt = 0;
    this.cleanupCursor = null;
    this.cleanupLastError = null;
    this.lastCleanupAt = null;
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
      if (raw.suppressed !== undefined && (!Array.isArray(raw.suppressed) || raw.suppressed.length > SUPPRESSION_LIMIT
        || raw.suppressed.some((entry) => !KINDS.includes(entry.kind) || typeof entry.id !== 'string'
          || !entry.id || entry.id.length > 256 || !MEDIA_REASONS.has(entry.reason)
          || !Number.isFinite(entry.recheck_after)))) throw new Error('invalid_suppression');
      this.state = {
        ...emptyState(raw.enabled_at, this.origin),
        watermarks: { object: raw.watermarks.object, review: raw.watermarks.review },
        scans: { automatic: {}, manual: {} }, jobs: raw.jobs.map(restoredJob),
        recent: raw.recent.slice(-(this.settings.history_limit ?? HISTORY_LIMIT)).filter((job) => KINDS.includes(job.kind)
          && ['completed', 'skipped'].includes(job.state) && typeof job.id === 'string'
          && typeof job.camera === 'string' && Number.isFinite(job.event_time)).map(restoredJob),
        suppressed: (raw.suppressed ?? []).filter((entry) => entry.recheck_after > this.clock()).map((entry) => ({
          kind: entry.kind, id: entry.id, reason: entry.reason, recheck_after: entry.recheck_after,
        })),
        totals: Object.fromEntries(['completed', 'skipped', 'retry_attempts'].map((name) => [name, counter(raw.totals?.[name])])),
        eligibility_skipped: Object.fromEntries([...ELIGIBILITY_REASONS].map((reason) => [reason, counter(raw.eligibility_skipped?.[reason])])),
      };
      for (const mode of ['automatic', 'manual']) for (const kind of KINDS) {
        const scan = raw.scans[mode][kind];
        if (scan) this.state.scans[mode][kind] = {
          after: scan.after, before: scan.before, until: scan.until, limit: scan.limit, seen: scan.seen ?? [],
        };
      }
      // Version-one states did not have separate suppression metadata. Seed
      // only known missing-media skips; this never invents a failure timestamp.
      if (raw.suppressed === undefined) {
        this.state.suppressed = this.state.recent.filter((job) => MEDIA_REASONS.has(job.reason)).map((job) => ({
          kind: job.kind, id: job.id, reason: job.reason,
          recheck_after: (job.completed_at ?? this.clock()) + SUPPRESSION_TTL,
        })).filter((entry) => entry.recheck_after > this.clock());
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
    this.scheduleConfirmation();
    this.scheduleCleanup();
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

  // Discovery/cleanup may involve many slow HTTP requests. They have their own
  // timer; this single-flight lane only reconciles/dispatches individual jobs.
  scheduleConfirmation(delay) {
    if (!this.running || this.storeError) return;
    delay ??= Math.max(this.settings.confirmationIntervalMs ?? 2_000, this.confirmationBackoffUntil - this.clock());
    clearTimeout(this.confirmationTimer);
    this.nextConfirmationAt = this.clock() + delay;
    this.confirmationTimer = setTimeout(() => {
      this.confirmationTimer = null;
      this.processJobs().finally(() => this.scheduleConfirmation());
    }, delay);
    this.confirmationTimer.unref?.();
  }

  operationFailed(error) {
    this.lastError = safeFailure(error);
    this.confirmationFailures += 1;
    const base = this.settings.confirmationIntervalMs ?? 2_000;
    this.confirmationBackoffUntil = this.clock()
      + Math.min(Math.max(base, 60_000), base * 2 ** Math.min(5, this.confirmationFailures));
  }

  scheduleCleanup() {
    if (!this.running || this.storeError) return;
    clearTimeout(this.cleanupTimer);
    const delay = Math.max(0, this.nextCleanupAt - this.clock());
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      this.nextCleanupAt = this.clock() + (this.settings.cleanupIntervalMs ?? 60_000);
      this.cleanupJobs().finally(() => {
        this.nextCleanupAt = this.clock() + (this.settings.cleanupIntervalMs ?? 60_000);
        this.scheduleCleanup();
      });
    }, delay);
    this.cleanupTimer.unref?.();
  }

  async stop() {
    this.running = false;
    this.nextPollAt = null;
    this.nextConfirmationAt = null;
    clearTimeout(this.timer);
    this.timer = null;
    clearTimeout(this.confirmationTimer);
    this.confirmationTimer = null;
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
    this.client?.close?.();
    await this.busy;
    await this.processBusy;
    await this.cleanupBusy;
    if (this.state && !this.storeError) this.persist();
  }

  status() {
    const counts = { pending: 0, waiting_live: 0, waiting_result: 0, retrying: 0 };
    for (const job of this.state?.jobs ?? []) counts[job.state] += 1;
    const queueItems = this.jobs().items;
    const views = {
      all: Object.values(counts).reduce((sum, value) => sum + value, 0),
      waiting: counts.pending + counts.waiting_live, awaiting: counts.waiting_result, retrying: counts.retrying,
      attention: (this.state?.jobs ?? []).filter((job) => this.publicJob(job).needs_attention).length,
      completed: (this.state?.recent ?? []).filter((job) => job.state === 'completed').length,
      skipped: (this.state?.recent ?? []).filter((job) => job.state === 'skipped').length,
    };
    return {
      enabled: Boolean(this.settings.enabled),
      state: !this.settings.enabled ? 'disabled' : this.storeError ? 'error' : !this.running ? 'stopped'
        : this.lastError ? 'degraded' : 'running',
      enabled_at: this.state?.enabled_at ?? null,
      capabilities: { ...this.capabilities }, counts,
      views, attention_count: views.attention, history_limit: this.settings.history_limit ?? HISTORY_LIMIT,
      total_queued: Object.values(counts).reduce((sum, value) => sum + value, 0),
      totals: { ...(this.state?.totals ?? {}) },
      active_job: this.state?.jobs.find((job) => job.state === 'waiting_result')
        ? this.publicJob(this.state.jobs.find((job) => job.state === 'waiting_result')) : null,
      recent_jobs: (this.state?.recent ?? []).slice(-30).reverse().map((job) => this.publicJob(job)),
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
      next_confirmation_at: this.nextConfirmationAt, next_cleanup_at: this.nextCleanupAt || null,
      suppression_count: this.state?.suppressed.length ?? 0,
      cleanup: { last_checked_at: this.lastCleanupAt, next_check_at: this.nextCleanupAt || null,
        last_error: this.cleanupLastError, batch_size: this.settings.cleanup_batch_size ?? 25 },
    };
  }

  publicJob(job) {
    return publicJob(job, this.clock(), this.settings.attentionAfterMs ?? 86_400_000);
  }

  jobs({ view = 'all', offset = 0, limit = 30 } = {}) {
    if (!VIEWS.has(view) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Invalid backlog page');
    }
    const historical = view === 'completed' || view === 'skipped';
    const jobs = [...(historical ? this.state?.recent ?? [] : this.state?.jobs ?? [])].filter((job) => {
      if (view === 'all') return true;
      if (view === 'waiting') return job.state === 'pending' || job.state === 'waiting_live';
      if (view === 'awaiting') return job.state === 'waiting_result';
      if (view === 'attention') return this.publicJob(job).needs_attention;
      return job.state === view;
    }).sort(historical ? (a, b) => b.completed_at - a.completed_at || newestFirst(a, b) : newestFirst);
    // A live queue can shrink between pages; return the last valid page, not a blank screen.
    const start = Math.min(offset, Math.max(0, Math.floor((jobs.length - 1) / limit) * limit));
    return { items: jobs.slice(start, start + limit).map((job) => this.publicJob(job)), offset: start, limit, view,
      total: jobs.length, has_more: start + limit < jobs.length };
  }

  actionError(code, statusCode = 409) {
    const error = new Error(code);
    error.code = code;
    error.statusCode = statusCode;
    return error;
  }

  requireAvailable() {
    if (!this.settings.enabled || !this.running || !this.state || this.storeError) {
      throw this.actionError('catchup_unavailable', this.storeError ? 503 : 409);
    }
  }

  retryJob(kind, id) {
    this.requireAvailable();
    const job = this.state.jobs.find((entry) => entry.kind === kind && entry.id === id);
    if (!job) throw this.actionError('job_not_found', 404);
    if (job.state === 'waiting_result') throw this.actionError('handoff_outstanding');
    if (this.lockedJobs.has(key(kind, id))) throw this.actionError('operation_in_progress');
    if (job.state !== 'retrying') throw this.actionError('job_not_retryable');
    // A previous native handoff may still exist in Frigate. Manual retry cannot
    // shorten its reconciliation grace; pre-dispatch/read-only failures can be
    // made eligible now. Normal readiness and a fresh description check remain.
    if (['description_not_confirmed', 'handoff_uncertain'].includes(job.reason)) {
      job.next_attempt_at = Math.max(job.next_attempt_at, this.clock());
    } else job.next_attempt_at = this.clock();
    if (!this.persist()) throw this.actionError('catchup_unavailable', 503);
    this.scheduleConfirmation(0);
    return this.status();
  }

  recheckJob(kind, id) {
    this.requireAvailable();
    const existing = this.state.jobs.find((entry) => entry.kind === kind && entry.id === id);
    if (existing) throw this.actionError(existing.state === 'waiting_result' ? 'handoff_outstanding' : 'job_not_recheckable');
    const history = this.state.recent.findLast((entry) => entry.kind === kind && entry.id === id && entry.state === 'skipped');
    if (!history) throw this.actionError('job_not_found', 404);
    if (this.state.jobs.length >= (this.settings.max_jobs ?? 10_000)) throw this.actionError('backlog_capacity_reached');
    this.state.suppressed = this.state.suppressed.filter((entry) => entry.kind !== kind || entry.id !== id);
    this.state.jobs.push({
      kind, id, camera: history.camera, event_time: history.event_time, state: 'pending', reason: null,
      attempts: 0, failures: 0, created_at: this.clock(), next_attempt_at: this.clock(),
      first_failed_at: null, last_attempt_at: null,
    });
    if (!this.persist()) throw this.actionError('catchup_unavailable', 503);
    this.nextCleanupAt = 0;
    this.schedule(0);
    return this.status();
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
    this.runtimeConfig = await this.readConfig();
    if (!this.running) return;
    this.lastError = null;
    // Establish every scan frontier before making a network call. The fast
    // dispatch lane must not jump ahead while another kind's page is in flight.
    for (const kind of KINDS) {
      if (!this.capabilities[kind]) continue;
      // Frigate writes event metadata asynchronously. Revisit a small discovery
      // window so a just-committed row is not missed at the last poll boundary.
      const lookback = Math.max(this.settings.liveGraceMs ?? 120_000, (this.settings.pollIntervalMs ?? 30_000) * 2) / 1000;
      this.state.scans.automatic[kind] ??= this.newScan(
        beforeTimestamp(Math.max(this.state.enabled_at / 1000, this.state.watermarks[kind] - lookback)), this.clock() / 1000,
      );
    }
    for (const kind of KINDS) {
      if (!this.capabilities[kind]) continue;
      for (const mode of ['automatic', 'manual']) {
        if (!this.running || this.storeError) return;
        const scan = this.state.scans[mode][kind];
        if (scan) await this.scanPage(mode, kind, scan);
      }
    }
    if (!this.running || this.storeError) return;
    await this.processJobs();
    if (this.clock() >= this.nextCleanupAt) {
      this.nextCleanupAt = this.clock() + (this.settings.cleanupIntervalMs ?? 60_000);
      await this.cleanupJobs();
    }
    this.persist();
  }

  async readConfig() {
    const config = await this.client.getConfig();
    if (!config?.cameras || typeof config.cameras !== 'object' || Array.isArray(config.cameras)) {
      throw new FrigateError('invalid_camera_configuration');
    }
    return config;
  }

  async scanPage(mode, kind, scan) {
    const rows = await this.client.list(kind, scan);
    if (!this.running) return;
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.id !== 'string' || !row.id || row.id.length > 256
      || typeof row.camera !== 'string' || !row.camera || row.camera.length > 256 || !Number.isFinite(seconds(row.start_time)))) {
      throw new FrigateError('invalid_event_list');
    }
    const known = new Set([...this.state.jobs.map((job) => key(job.kind, job.id)), ...(scan.seen ?? [])]);
    this.state.suppressed = this.state.suppressed.filter((entry) => entry.recheck_after > this.clock());
    const suppressed = new Set(this.state.suppressed.map((entry) => key(entry.kind, entry.id)));
    const completedRecently = new Set(this.state.recent
      // Missing-media skips have their own expiry; the browsable history must
      // not prevent an eventual recheck after that expiry.
      .filter((job) => !MEDIA_REASONS.has(job.reason)).map((job) => key(job.kind, job.id)));
    for (const item of rows) {
      const start = seconds(item.start_time);
      if (start < scan.after || start > scan.until || (mode === 'automatic' && start * 1000 < this.state.enabled_at)) continue;
      if (known.has(key(kind, item.id)) || completedRecently.has(key(kind, item.id))
        || suppressed.has(key(kind, item.id)) || hasFrigateDescription(kind, item)) continue;
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
        first_failed_at: null, last_attempt_at: null,
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
    if (!this.state.jobs.includes(job)) return;
    this.state.jobs = this.state.jobs.filter((other) => other !== job);
    this.state.recent.push({ ...job, state, reason, completed_at: this.clock(), next_attempt_at: null });
    this.state.recent = this.state.recent.slice(-(this.settings.history_limit ?? HISTORY_LIMIT));
    if (state === 'skipped' && MEDIA_REASONS.has(reason)) {
      this.state.suppressed = this.state.suppressed.filter((entry) => key(entry.kind, entry.id) !== key(job.kind, job.id)
        && entry.recheck_after > this.clock());
      this.state.suppressed.push({ kind: job.kind, id: job.id, reason, recheck_after: this.clock() + SUPPRESSION_TTL });
      this.state.suppressed = this.state.suppressed.slice(-SUPPRESSION_LIMIT);
    }
    this.state.totals[state] = (this.state.totals[state] ?? 0) + 1;
    this.persist();
  }

  retry(job, reason) {
    const base = this.settings.retryIntervalMs ?? 60_000;
    job.failures = (job.failures ?? 0) + 1;
    job.first_failed_at ??= this.clock();
    const delay = Math.min(this.settings.maxRetryIntervalMs ?? 18_000_000, base * (2 ** Math.min(30, job.failures - 1)));
    job.state = 'retrying';
    job.reason = reason;
    job.next_attempt_at = this.clock() + delay;
    if (reason === 'description_not_confirmed' || reason === 'handoff_uncertain') {
      job.next_attempt_at = Math.max(job.next_attempt_at, this.clock() + (this.settings.liveGraceMs ?? 120_000));
    }
    this.state.totals.retry_attempts += 1;
    this.persist();
  }

  processJobs() {
    if (this.processBusy) return this.processBusy;
    if (!this.running || this.storeError || this.clock() < this.confirmationBackoffUntil) return Promise.resolve();
    this.processBusy = this.runProcessJobs().catch((error) => {
      if (this.running) {
        this.operationFailed(error);
      }
    }).finally(() => { this.processBusy = null; this.onChange(this.status()); });
    return this.processBusy;
  }

  async runProcessJobs() {
    const active = this.state.jobs.find((job) => job.state === 'waiting_result');
    if (active) {
      await this.checkJob(active, true);
      // A confirmed saved description releases the handoff immediately. Merely
      // reaching its timeout never confirms failure, and still keeps retry grace.
      if (this.state.jobs.some((job) => job.state === 'waiting_result')) return;
    }
    if (!this.runtimeConfig || !this.capabilities.checked) return;
    if (!this.readiness()) return;
    const jobs = this.state.jobs.filter((job) => job.next_attempt_at <= this.clock())
      .sort((a, b) => b.event_time - a.event_time || a.id.localeCompare(b.id));
    // Bound metadata checks in one poll, including expired/disabled jobs.
    for (const job of jobs.slice(0, 10)) {
      if (!this.readiness()) return;
      if (!this.capabilities[job.kind]) continue;
      if (this.lockedJobs.has(key(job.kind, job.id))) return;
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

  cleanupJobs() {
    if (this.cleanupBusy) return this.cleanupBusy;
    if (!this.running || this.storeError || !this.runtimeConfig) return Promise.resolve();
    this.cleanupBusy = this.runCleanupJobs().catch((error) => {
      if (this.running) this.lastError = safeFailure(error);
    }).finally(() => {
      this.cleanupBusy = null;
      this.nextCleanupAt = this.clock() + (this.settings.cleanupIntervalMs ?? 60_000);
      this.onChange(this.status());
    });
    return this.cleanupBusy;
  }

  async runCleanupJobs() {
    this.cleanupLastError = null;
    this.lastCleanupAt = this.clock();
    const available = this.state.jobs.filter((job) => job.state !== 'waiting_result')
      .sort((a, b) => key(a.kind, a.id).localeCompare(key(b.kind, b.id)));
    const pivot = available.findIndex((job) => !this.cleanupCursor || key(job.kind, job.id).localeCompare(this.cleanupCursor) > 0);
    const ordered = pivot < 0 ? available : [...available.slice(pivot), ...available.slice(0, pivot)];
    for (const job of ordered.slice(0, this.settings.cleanup_batch_size ?? 25)) {
      if (!this.running || this.storeError) return;
      this.cleanupCursor = key(job.kind, job.id);
      if (!this.capabilities[job.kind] || job.state === 'waiting_result' || this.lockedJobs.has(this.cleanupCursor)) continue;
      this.lockedJobs.add(this.cleanupCursor);
      let fetchingEvent = true;
      try {
        const item = await this.client.get(job.kind, job.id);
        fetchingEvent = false;
        if (!this.running || !this.state.jobs.includes(job)) return;
        if (hasFrigateDescription(job.kind, item)) {
          this.finish(job, 'completed', job.attempts ? 'description_confirmed' : 'completed_by_frigate');
          continue;
        }
        const end = seconds(item.end_time);
        if (end === null || end * 1000 + (this.settings.liveGraceMs ?? 120_000) > this.clock()) continue;
        const eligibility = frigateEligibility(job.kind, item, this.runtimeConfig);
        // Cached camera configuration can have changed since discovery. Passive
        // cleanup does not make terminal eligibility decisions; dispatch does a
        // fresh effective-config check before acting on those filters.
        if (!eligibility.eligible) continue;
        if (!await this.client.hasMedia(job.kind, item, eligibility.source)) {
          const current = frigateEligibility(job.kind, item, await this.readConfig());
          if (this.running && current.eligible && current.source === eligibility.source) {
            this.finish(job, 'skipped', 'media_expired_or_missing');
          }
        }
      } catch (error) {
        if (!this.running) return;
        if (fetchingEvent && error.statusCode === 404) this.finish(job, 'skipped', 'event_deleted');
        else {
          // A failed cleanup read is not a failed generation, and must not erase
          // work or advance that job's retry counters/backoff. Stop the batch so
          // unavailable servers are not hit once for every remaining entry.
          this.cleanupLastError = safeFailure(error);
          return;
        }
      } finally { this.lockedJobs.delete(key(job.kind, job.id)); }
    }
  }

  async checkJob(job, verifyOnly) {
    const id = key(job.kind, job.id);
    if (this.lockedJobs.has(id) || !this.state.jobs.includes(job)) return true;
    this.lockedJobs.add(id);
    if (!verifyOnly) job.last_attempt_at = this.clock();
    let fetchingEvent = true;
    try {
      const item = await this.client.get(job.kind, job.id);
      fetchingEvent = false;
      if (!this.running) return false;
      if (verifyOnly) { this.confirmationFailures = 0; this.confirmationBackoffUntil = 0; }
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
      // Fast dispatch runs independently of discovery, so its cached camera
      // configuration may be older than a user's latest toggle/source change.
      // Never make a terminal eligibility/media decision from that cache.
      const config = await this.readConfig();
      if (!this.running) return false;
      const eligibility = frigateEligibility(job.kind, item, config);
      if (!eligibility.eligible) { this.finish(job, 'skipped', eligibility.reason); return false; }
      if (!await this.client.hasMedia(job.kind, item, eligibility.source)) {
        const current = frigateEligibility(job.kind, item, await this.readConfig());
        if (!this.running) return false;
        if (!current.eligible) this.finish(job, 'skipped', current.reason);
        else if (current.source === eligibility.source) this.finish(job, 'skipped', 'media_expired_or_missing');
        else {
          // Missing snapshots do not make an event unusable if the camera just
          // switched to retained thumbnails (or vice versa). Recheck next turn.
          job.state = 'pending';
          job.next_attempt_at = this.clock() + (this.settings.confirmationIntervalMs ?? 2_000);
        }
        return false;
      }
      if (!this.readiness()) return false;
      // Metadata/media checks may take seconds. Re-read uncached configuration
      // and description immediately before PUT to avoid replacing a live result
      // or acting on a camera toggle changed while this poll was in progress.
      const latestConfig = await this.readConfig();
      fetchingEvent = true;
      const latestItem = await this.client.get(job.kind, job.id);
      fetchingEvent = false;
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
      job.last_attempt_at = this.clock();
      job.next_attempt_at = this.clock() + (this.settings.generationTimeoutMs ?? 600_000);
      if (!this.persist() || !this.readiness()) {
        if (!this.storeError) { job.state = 'pending'; this.persist(); }
        return false;
      }
      try {
        await this.client.regenerate(job.kind, job.id, eligibility.source);
        this.confirmationFailures = 0;
        this.confirmationBackoffUntil = 0;
      } catch (error) {
        if ([400, 401, 403, 404, 405, 422, 429].includes(error.statusCode)) {
          // A missing regeneration route is not proof the event was deleted.
          // The next preflight GET will confirm deletion if that is the cause.
          this.retry(job, safeFailure(error));
          if ([401, 403, 429].includes(error.statusCode)) this.operationFailed(error);
        } else {
          // Transport/5xx errors can occur after native dispatch; wait and verify.
          job.reason = 'handoff_uncertain';
          this.operationFailed(error);
          this.persist();
        }
      }
      return true;
    } catch (error) {
      if (!this.running) return false;
      if (fetchingEvent && error.statusCode === 404) { this.finish(job, 'skipped', 'event_deleted'); return false; }
      if (verifyOnly) {
        this.operationFailed(error);
        return true; // Cannot confirm status; keep the single native handoff.
      }
      this.retry(job, safeFailure(error));
      this.operationFailed(error);
      return true; // Stop this dispatch batch and back off after an API failure.
    } finally { this.lockedJobs.delete(id); }
  }
}
