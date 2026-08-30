import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDuration } from './config.js';
import { safeDisplay } from './observability.js';

const STATE_SCHEMA_VERSION = 1;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

function runningState() {
  return {
    state: 'running',
    paused: false,
    reason: null,
    requestedAt: null,
    pausedAt: null,
    resumeAt: null,
    durationMs: null,
    gpuReleased: false,
    unloadError: null,
  };
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePauseDuration(value, maxDurationMs) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    const error = new Error('duration must be a string such as 30m or 4h; omit it for a manual pause');
    error.statusCode = 400;
    throw error;
  }
  let durationMs;
  try {
    durationMs = parseDuration(value, 'duration');
  } catch (cause) {
    const error = new Error(cause.message, { cause });
    error.statusCode = 400;
    throw error;
  }
  if (durationMs <= 0) {
    const error = new Error('duration must be greater than zero; omit it for a manual pause');
    error.statusCode = 400;
    throw error;
  }
  if (durationMs > maxDurationMs) {
    const error = new Error(`duration exceeds the configured maximum of ${maxDurationMs / 1000} seconds`);
    error.statusCode = 400;
    throw error;
  }
  return durationMs;
}

function normalizeReason(value) {
  if (value === undefined || value === null || value === '') return 'Exclusive GPU maintenance';
  if (typeof value !== 'string') {
    const error = new Error('reason must be a string');
    error.statusCode = 400;
    throw error;
  }
  return safeDisplay(value.trim(), 200) || 'Exclusive GPU maintenance';
}

export class MaintenanceState {
  constructor(config, {
    clock = () => Date.now(),
    logger,
    onChange = () => {},
    onAutoResume = () => {},
  } = {}) {
    this.config = config;
    this.settings = config.maintenance;
    this.clock = clock;
    this.logger = logger;
    this.onChange = onChange;
    this.onAutoResume = onAutoResume;
    this.value = runningState();
    this.revision = 0;
    this.controller = null;
    this.timer = null;
    this.mutation = Promise.resolve();
    this.restore();
  }

  restore() {
    if (!this.settings.enabled) return;
    let raw;
    try {
      raw = fs.readFileSync(this.settings.state_path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      this.failClosed(`cannot read persisted maintenance state: ${error.message}`);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed.schema_version !== STATE_SCHEMA_VERSION || parsed.paused !== true) {
        throw new Error('unsupported or inactive maintenance state document');
      }
      const requestedAt = timestamp(parsed.requested_at);
      const pausedAt = timestamp(parsed.paused_at);
      const resumeAt = timestamp(parsed.resume_at);
      const durationMs = parsed.duration_ms === null
        ? null
        : Number.isFinite(parsed.duration_ms) && parsed.duration_ms > 0
          ? parsed.duration_ms
          : null;
      if (resumeAt !== null && resumeAt <= this.clock()) {
        fs.unlinkSync(this.settings.state_path);
        return;
      }
      this.value = {
        state: 'pausing',
        paused: true,
        reason: normalizeReason(parsed.reason),
        requestedAt: requestedAt ?? this.clock(),
        pausedAt,
        resumeAt,
        durationMs,
        // A restart invalidates the old runtime observation. Reconfirm /api/ps before claiming release.
        gpuReleased: false,
        unloadError: null,
      };
      this.revision += 1;
      this.controller = new AbortController();
      this.logger?.warn('restored persisted maintenance pause; GPU release will be reconfirmed', {
        resume_at: resumeAt ? new Date(resumeAt).toISOString() : null,
      });
    } catch (error) {
      this.failClosed(`invalid persisted maintenance state: ${error.message}`);
    }
  }

  failClosed(message) {
    this.cancelTimer();
    this.controller?.abort(new Error('maintenance state failed closed'));
    this.value = {
      ...runningState(),
      state: 'error',
      paused: true,
      reason: 'Maintenance state requires operator attention',
      requestedAt: this.clock(),
      unloadError: safeDisplay(message, 512),
    };
    this.revision += 1;
    this.controller = new AbortController();
    this.logger?.error('maintenance state failed closed', { error: message });
    this.onChange(this.status());
  }

  get paused() {
    return this.value.paused;
  }

  get signal() {
    return this.controller?.signal ?? null;
  }

  get currentRevision() {
    return this.revision;
  }

  status(now = this.clock()) {
    const remaining = this.value.resumeAt === null
      ? null
      : Math.max(0, this.value.resumeAt - now) / 1000;
    return {
      state: this.value.state,
      paused: this.value.paused,
      reason: this.value.reason,
      requested_at: this.value.requestedAt ? new Date(this.value.requestedAt).toISOString() : null,
      paused_at: this.value.pausedAt ? new Date(this.value.pausedAt).toISOString() : null,
      resume_at: this.value.resumeAt ? new Date(this.value.resumeAt).toISOString() : null,
      remaining_seconds: remaining,
      gpu_released: this.value.gpuReleased,
      unload_error: this.value.unloadError,
      control_available: this.settings.enabled && Boolean(this.settings.auth_token),
    };
  }

  begin({ duration, reason } = {}, { onPersisted = () => {} } = {}) {
    return this.runMutation(async () => {
      if (!this.settings.enabled) {
        const error = new Error('maintenance controls are disabled');
        error.statusCode = 404;
        throw error;
      }
      const durationMs = parsePauseDuration(duration, this.settings.maxPauseMs);
      const now = this.clock();
      const next = {
        state: 'pausing',
        paused: true,
        reason: normalizeReason(reason),
        requestedAt: now,
        pausedAt: null,
        resumeAt: null,
        durationMs,
        gpuReleased: false,
        unloadError: null,
      };
      await this.persist(next);
      // Close scheduler admission only after validation and durable persistence.
      // The hook is deliberately synchronous so no request can slip between the
      // admission change and publishing the in-memory maintenance state.
      const hookResult = onPersisted();
      if (hookResult && typeof hookResult.then === 'function') {
        throw new Error('maintenance onPersisted hook must be synchronous');
      }
      this.cancelTimer();
      this.controller?.abort(new Error('maintenance pause replaced'));
      this.controller = new AbortController();
      this.value = next;
      this.revision += 1;
      this.onChange(this.status());
      return { revision: this.revision, status: this.status() };
    });
  }

  markReleased(revision) {
    return this.runMutation(async () => {
      if (!this.value.paused || revision !== this.revision) return { changed: false, status: this.status() };
      const now = this.clock();
      const next = {
        ...this.value,
        state: 'paused',
        pausedAt: this.value.pausedAt ?? now,
        resumeAt: this.value.resumeAt
          ?? (this.value.durationMs === null ? null : now + this.value.durationMs),
        gpuReleased: true,
        unloadError: null,
      };
      await this.persist(next);
      this.value = next;
      this.armTimer();
      this.onChange(this.status());
      return { changed: true, status: this.status() };
    });
  }

  markReleasing(revision) {
    return this.runMutation(async () => {
      if (!this.value.paused || revision !== this.revision || this.signal?.aborted) {
        return { changed: false, status: this.status() };
      }
      if (this.value.state === 'pausing' && !this.value.gpuReleased && !this.value.unloadError) {
        return { changed: false, status: this.status() };
      }
      const next = {
        ...this.value,
        state: 'pausing',
        pausedAt: null,
        resumeAt: null,
        gpuReleased: false,
        unloadError: null,
      };
      await this.persist(next);
      this.cancelTimer();
      this.value = next;
      this.onChange(this.status());
      return { changed: true, status: this.status() };
    });
  }

  markError(revision, error) {
    return this.runMutation(async () => {
      if (!this.value.paused || revision !== this.revision || this.signal?.aborted) {
        return { changed: false, status: this.status() };
      }
      const next = {
        ...this.value,
        state: 'error',
        resumeAt: null,
        gpuReleased: false,
        unloadError: safeDisplay(error?.message ?? String(error), 512),
      };
      await this.persist(next);
      this.cancelTimer();
      this.value = next;
      this.onChange(this.status());
      return { changed: true, status: this.status() };
    });
  }

  resume(source = 'manual') {
    return this.runMutation(async () => {
      if (!this.value.paused) return { changed: false, source, status: this.status() };
      await this.clearPersisted();
      this.cancelTimer();
      this.controller?.abort(new Error(`maintenance resumed by ${source}`));
      this.controller = null;
      this.value = runningState();
      this.revision += 1;
      this.onChange(this.status());
      return { changed: true, source, status: this.status() };
    });
  }

  stop() {
    this.cancelTimer();
    this.controller?.abort(new Error('service stopping'));
  }

  runMutation(operation) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.catch(() => {});
    return result;
  }

  async persist(value) {
    const directory = path.dirname(this.settings.state_path);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.maintenance-${process.pid}-${randomUUID()}.tmp`);
    const document = `${JSON.stringify({
      schema_version: STATE_SCHEMA_VERSION,
      paused: true,
      state: value.state,
      reason: value.reason,
      requested_at: value.requestedAt ? new Date(value.requestedAt).toISOString() : null,
      paused_at: value.pausedAt ? new Date(value.pausedAt).toISOString() : null,
      resume_at: value.resumeAt ? new Date(value.resumeAt).toISOString() : null,
      duration_ms: value.durationMs,
      gpu_released: value.gpuReleased,
      unload_error: value.unloadError,
    }, null, 2)}\n`;
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await handle.writeFile(document, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, this.settings.state_path);
    } finally {
      await handle?.close().catch(() => {});
      await fs.promises.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') this.logger?.warn('failed to remove temporary maintenance state', { error: error.message });
      });
    }
  }

  async clearPersisted() {
    try {
      await fs.promises.unlink(this.settings.state_path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  cancelTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  armTimer() {
    this.cancelTimer();
    if (!this.value.paused || this.value.state !== 'paused' || this.value.resumeAt === null) return;
    const remaining = Math.max(0, this.value.resumeAt - this.clock());
    this.timer = setTimeout(() => {
      this.timer = null;
      // Node clamps a single timeout above roughly 24.9 days to 1 ms. Re-arm
      // long pauses in bounded chunks so an operator-raised maximum remains safe.
      if (this.value.resumeAt !== null && this.value.resumeAt > this.clock()) {
        this.armTimer();
        return;
      }
      Promise.resolve(this.onAutoResume()).catch((error) => {
        this.logger?.error('automatic maintenance resume failed', { error: error.message });
        this.failClosed(`automatic maintenance resume failed: ${error.message}`);
      });
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
    this.timer.unref?.();
  }
}
