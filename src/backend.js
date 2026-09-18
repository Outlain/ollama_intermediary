import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const GPU_FAULT_PATTERNS = [
  /ROCm error:\s*out of memory/i,
  /runtime OOM detected/i,
  /SVM mapping failed/i,
  /(?:GPU|CUDA|HIP) (?:error:\s*)?out of memory/i,
];

export const RECOVERY_REASONS = Object.freeze({
  upstream_disconnected: 'The connection to Ollama closed after dispatch; completion is unknown.',
  upstream_completion_uncertain: 'Ollama did not return a complete inference response.',
  model_unload_failed: 'Ollama did not confirm that the previous model was unloaded.',
  gpu_memory_fault: 'Ollama reported a GPU memory or mapping failure.',
  restored_attempt_uncertain: 'An inference was outstanding when the intermediary restarted.',
  catchup_state_error: 'Catch-up completion could not be saved safely; inspect state storage.',
  recovery_state_error: 'The saved recovery state could not be read or written safely.',
  unknown: 'GPU health or upstream completion requires verification.',
});

function recoveryCode(reason, supplied) {
  if (Object.hasOwn(RECOVERY_REASONS, supplied ?? '')) return supplied;
  if (/after dispatch; upstream completion is unknown/.test(reason)) return 'upstream_disconnected';
  if (/without a complete response/.test(reason)) return 'upstream_completion_uncertain';
  if (/restored catch-up inference/.test(reason)) return 'restored_attempt_uncertain';
  if (/completion could not be persisted/.test(reason)) return 'catchup_state_error';
  if (/unload/i.test(reason)) return 'model_unload_failed';
  if (GPU_FAULT_PATTERNS.some((pattern) => pattern.test(reason))) return 'gpu_memory_fault';
  return 'unknown';
}

function gpuFaultMessage(status, body, error = null) {
  const text = `${error?.message ?? ''}\n${Buffer.isBuffer(body) ? body.toString('utf8') : body ?? ''}`;
  if (!GPU_FAULT_PATTERNS.some((pattern) => pattern.test(text))) return null;
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 1_024);
  return summary || `Ollama returned HTTP ${status} with a GPU out-of-memory error`;
}

function safeText(value, limit = 256) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '�').slice(0, limit) : null;
}

function modelSummary(model) {
  const details = model?.details && typeof model.details === 'object' ? model.details : {};
  return {
    name: safeText(model?.name ?? model?.model),
    size_bytes: Number.isFinite(model?.size) ? model.size : null,
    size_vram: Number.isFinite(model?.size_vram) ? model.size_vram : null,
    context_length: Number.isFinite(model?.context_length) ? model.context_length : null,
    expires_at: safeText(model?.expires_at, 128),
    details: {
      family: safeText(details.family, 128),
      parameter_size: safeText(details.parameter_size, 128),
      quantization_level: safeText(details.quantization_level, 128),
    },
  };
}

export class BackendState {
  constructor(config, { logger, metrics, onModel, onChange = () => {}, clock = () => Date.now() }) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.onModel = onModel;
    this.onChange = onChange;
    this.clock = clock;
    this.reachable = false;
    this.lastProbeAt = null;
    this.lastSuccessAt = null;
    this.lastError = 'not probed yet';
    this.lastInferenceError = null;
    this.lastInferenceFailureAt = null;
    this.lastInferenceSuccessAt = null;
    this.failures = [];
    this.openUntil = 0;
    this.timer = null;
    this.stopped = false;
    this.probing = false;
    this.recoveryRequired = false;
    this.recoveryReason = null;
    this.recoveryCode = null;
    this.recoverySince = null;
    this.loadedModels = [];
    this.recoveryStorageError = null;
    this.restoreRecovery();
  }

  restoreRecovery() {
    const statePath = this.config.gpu_safety.state_path;
    if (!statePath) return;
    try {
      if (fs.statSync(statePath).size > 16_384) throw new Error('recovery state exceeds size limit');
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (saved.schema_version !== 1 || typeof saved.recovery_required !== 'boolean') throw new Error('invalid recovery state');
      if (saved.recovery_required) {
        this.recoveryRequired = true;
        this.recoveryReason = typeof saved.reason === 'string' ? saved.reason : 'Persisted GPU recovery required';
        this.recoveryCode = recoveryCode(this.recoveryReason, saved.code);
        this.recoverySince = Number.isFinite(saved.since) ? saved.since : this.clock();
        this.lastError = this.recoveryReason;
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      this.recoveryRequired = true;
      this.recoveryReason = 'GPU recovery state could not be read; manual verification required';
      this.recoveryCode = 'recovery_state_error';
      this.recoverySince = this.clock();
      this.recoveryStorageError = error.message;
      this.lastError = this.recoveryReason;
    }
  }

  persistRecovery(required, reason = null, since = null) {
    const statePath = this.config.gpu_safety.state_path;
    if (!statePath) return;
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify({ schema_version: 1, recovery_required: required, reason, since,
          code: required ? this.recoveryCode : null }));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, statePath);
      this.recoveryStorageError = null;
    } catch (error) {
      this.recoveryStorageError = error.message;
      try { fs.unlinkSync(temporary); } catch { /* No temporary file may exist. */ }
      throw error;
    }
  }

  // Caller must hold the operation gate and explicitly verify host recovery.
  // API reachability alone cannot prove that GPU/driver memory is healthy.
  clearRecovery() {
    this.persistRecovery(false);
    this.recoveryRequired = false;
    this.recoveryReason = null;
    this.recoveryCode = null;
    this.recoverySince = null;
    this.lastError = null;
    this.lastInferenceError = null;
    this.openUntil = 0;
    this.failures = [];
    this.onChange();
  }

  canDispatch(now = this.clock()) {
    return this.reachable && !this.recoveryRequired && this.openUntil <= now;
  }

  circuitOpen(now = this.clock()) {
    return this.openUntil > now;
  }

  recordFailure(error, source = 'generation') {
    const now = this.clock();
    const windowStart = now - this.config.circuit_breaker.failureWindowMs;
    this.failures = this.failures.filter((timestamp) => timestamp >= windowStart);
    this.failures.push(now);
    this.lastError = error?.message ?? String(error);
    if (source !== 'health_probe') {
      this.lastInferenceError = this.lastError;
      this.lastInferenceFailureAt = now;
    }
    this.metrics.increment('proxy_requests_failed_total', { source, reason: error?.code ?? error?.name ?? 'backend_error' });
    if (this.failures.length >= this.config.circuit_breaker.failure_threshold) {
      const wasOpen = this.circuitOpen(now);
      this.openUntil = Math.max(this.openUntil, now + this.config.circuit_breaker.openDurationMs);
      if (!wasOpen) {
        this.metrics.increment('proxy_circuit_breaker_opens_total');
        this.logger.error('backend circuit breaker opened', {
          failures: this.failures.length,
          failure_window_seconds: this.config.circuit_breaker.failureWindowMs / 1000,
          open_seconds: this.config.circuit_breaker.openDurationMs / 1000,
          error: this.lastError,
        });
      }
    }
    this.onChange();
  }

  recordHttpStatus(status) {
    if (status >= 500) {
      const error = new Error(`Ollama returned HTTP ${status}`);
      error.code = `http_${status}`;
      this.recordFailure(error);
    }
  }

  recordGenerationResult(status, body, error = null) {
    const message = this.config.gpu_safety.recovery_on_oom ? gpuFaultMessage(status, body, error) : null;
    if (message) {
      this.requireRecovery(message, { http_status: status, code: 'gpu_memory_fault' });
      return { recoveryRequired: true, reason: message };
    }
    if (error) this.recordFailure(error, 'response_stream');
    else this.recordHttpStatus(status);
    if (!error && status < 400) {
      this.lastInferenceSuccessAt = this.clock();
      this.lastInferenceError = null;
      if (!this.recoveryRequired) this.lastError = null;
    }
    return { recoveryRequired: false, reason: null };
  }

  requireRecovery(reason, details = {}) {
    const message = (reason?.message ?? String(reason)).slice(0, 1_024);
    this.lastError = message;
    this.lastInferenceError = message;
    this.lastInferenceFailureAt = this.clock();
    if (!this.recoveryRequired) {
      this.recoveryRequired = true;
      this.recoveryReason = message;
      this.recoveryCode = recoveryCode(message, details.code);
      this.recoverySince = this.clock();
      this.metrics.increment('proxy_gpu_recovery_required_total');
      this.logger.error('GPU recovery required; inference dispatch suspended', {
        reason: message,
        ...details,
      });
      try {
        this.persistRecovery(true, message, this.recoverySince);
      } catch (error) {
        this.logger.error('GPU recovery state could not be persisted; admission remains blocked', { error: error.message });
      }
    }
    this.onChange();
  }

  async probe() {
    if (this.probing || this.stopped) return;
    this.probing = true;
    const now = this.clock();
    this.lastProbeAt = now;
    try {
      const timeout = AbortSignal.timeout(this.config.ollama.healthTimeoutMs);
      const tagsUrl = new URL('/api/tags', this.config.ollama.url);
      const tags = await fetch(tagsUrl, { signal: timeout });
      if (!tags.ok) throw new Error(`health /api/tags returned HTTP ${tags.status}`);
      await tags.body?.cancel();
      const ps = await fetch(new URL('/api/ps', this.config.ollama.url), { signal: timeout });
      if (!ps.ok) throw new Error(`health /api/ps returned HTTP ${ps.status}`);
      const body = await ps.json();
      const models = Array.isArray(body.models) ? body.models : [];
      this.loadedModels = models.slice(0, 32).map(modelSummary).filter((item) => item.name);
      const model = models[0]?.name ?? models[0]?.model ?? null;
      const wasHealthy = this.canDispatch(now);
      this.reachable = true;
      this.lastSuccessAt = now;
      if (!this.recoveryRequired) this.lastError = this.lastInferenceError;
      if (this.openUntil && this.openUntil <= now) {
        this.openUntil = 0;
        this.failures = [];
        this.logger.info('backend circuit breaker closed after successful probe');
      }
      this.onModel(model);
      if (!wasHealthy && this.canDispatch(now)) this.logger.info('Ollama API is reachable', { loaded_model: model });
    } catch (error) {
      const wasReachable = this.reachable;
      this.reachable = false;
      this.loadedModels = [];
      this.lastError = error.message;
      if (wasReachable || this.lastSuccessAt === null) this.logger.error('Ollama health probe failed', { error: error.message });
      this.recordFailure(error, 'health_probe');
    } finally {
      this.probing = false;
      this.onChange();
    }
  }

  start() {
    this.probe();
    this.timer = setInterval(() => this.probe(), this.config.ollama.healthIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  status(now = this.clock()) {
    return {
      state: this.recoveryRequired ? 'recovery_required' : this.canDispatch(now) ? 'healthy' : this.circuitOpen(now) ? 'circuit_open' : 'unreachable',
      reachable: this.reachable,
      inference_state: this.recoveryRequired ? 'recovery_required'
        : this.lastInferenceError ? 'last_request_failed'
          : this.lastInferenceSuccessAt ? 'last_request_succeeded' : 'not_observed',
      recovery_required: this.recoveryRequired,
      recovery_reason: this.recoveryReason,
      recovery_code: this.recoveryCode,
      recovery_since: this.recoverySince ? new Date(this.recoverySince).toISOString() : null,
      circuit_open: this.circuitOpen(now),
      circuit_open_remaining: Math.max(0, this.openUntil - now) / 1000,
      last_probe_at: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
      last_success_at: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      last_error: this.lastError,
      last_inference_error: this.lastInferenceError,
      last_inference_failure_at: this.lastInferenceFailureAt ? new Date(this.lastInferenceFailureAt).toISOString() : null,
      last_inference_success_at: this.lastInferenceSuccessAt ? new Date(this.lastInferenceSuccessAt).toISOString() : null,
      recovery_storage_error: this.recoveryStorageError,
      loaded_models: this.loadedModels,
    };
  }
}

export class BackendClient {
  constructor(config) {
    this.config = config;
    this.base = new URL(config.ollama.url);
    this.transport = this.base.protocol === 'https:' ? https : http;
    this.agent = this.base.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, maxSockets: 32 })
      : new http.Agent({ keepAlive: true, maxSockets: 32 });
  }

  request({ method, path, headers, body, signal, timeoutMs = this.config.ollama.requestTimeoutMs }) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason ?? new Error('client disconnected'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      let timeout;
      const cleanupRequest = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      };
      const request = this.transport.request(new URL(path, this.base), {
        method,
        headers,
        agent: this.agent,
        signal: controller.signal,
      });
      timeout = setTimeout(() => controller.abort(new Error('backend request hard timeout exceeded')), timeoutMs);
      request.once('response', (response) => {
        const cleanup = () => cleanupRequest();
        response.once('end', cleanup);
        response.once('close', cleanup);
        resolve({ response, cancel: abort, cleanup });
      });
      request.once('error', (error) => {
        cleanupRequest();
        reject(error);
      });
      if (body?.length) request.write(body);
      request.end();
    });
  }

  async readResponse(response, limit = 1_048_576) {
    const chunks = [];
    let length = 0;
    for await (const chunk of response) {
      length += chunk.length;
      if (length > limit) throw new Error(`Ollama response exceeded ${limit} bytes during model cleanup`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async loadedModels(signal, timeoutMs) {
    const { response, cleanup } = await this.request({
      method: 'GET',
      path: '/api/ps',
      headers: { accept: 'application/json' },
      body: null,
      signal,
      timeoutMs,
    });
    try {
      const raw = await this.readResponse(response);
      if ((response.statusCode ?? 500) >= 400) throw new Error(`/api/ps returned HTTP ${response.statusCode}`);
      const parsed = JSON.parse(raw.toString('utf8') || '{}');
      if (!Array.isArray(parsed.models)) throw new Error('/api/ps did not return a models array');
      if (parsed.models.some((model) => !model || typeof (model.name ?? model.model) !== 'string')) throw new Error('/api/ps returned invalid model entries');
      return parsed.models.map((model) => model.name ?? model.model);
    } finally {
      cleanup();
    }
  }

  async modelContextLength(model, signal) {
    const body = Buffer.from(JSON.stringify({ model }));
    const { response, cleanup } = await this.request({ method: 'POST', path: '/api/show',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      body, signal, timeoutMs: this.config.ollama.healthTimeoutMs });
    try {
      const raw = await this.readResponse(response);
      if (response.statusCode !== 200) return null;
      const info = JSON.parse(raw.toString('utf8')).model_info;
      const architecture = info?.['general.architecture'];
      const value = typeof architecture === 'string' ? info[`${architecture}.context_length`] : null;
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    } finally { cleanup(); }
  }

  async unloadModel(model, { signal, timeoutMs }) {
    const body = Buffer.from(JSON.stringify({ model, keep_alive: 0 }));
    const { response, cleanup } = await this.request({
      method: 'POST',
      path: '/api/generate',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
      body,
      signal,
      timeoutMs,
    });
    try {
      const raw = await this.readResponse(response);
      if ((response.statusCode ?? 500) >= 400) {
        throw new Error(`Ollama model unload returned HTTP ${response.statusCode}: ${raw.toString('utf8').slice(0, 512)}`);
      }
    } finally {
      cleanup();
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const models = await this.loadedModels(signal, Math.min(remaining, this.config.ollama.healthTimeoutMs));
      if (!models.includes(model)) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
    const error = new Error(`Ollama did not confirm unload of ${model} within ${timeoutMs}ms`);
    error.code = 'model_unload_timeout';
    throw error;
  }

  close() {
    this.agent.destroy();
  }
}

export class OperationGate {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.active = false;
    this.activeKind = null;
    this.waiters = [];
  }

  acquire(kind, signal) {
    return new Promise((resolve, reject) => {
      const waiter = { kind, resolve, reject, signal, abort: null };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason ?? new Error('operation cancelled'));
      };
      if (signal?.aborted) return waiter.abort();
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  dispatch() {
    if (this.active || !this.waiters.length) return;
    const exclusiveIndex = this.waiters.findIndex((waiter) => waiter.kind === 'maintenance' || waiter.kind === 'management');
    const index = exclusiveIndex >= 0 ? exclusiveIndex : 0;
    const [waiter] = this.waiters.splice(index, 1);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    this.active = true;
    this.activeKind = waiter.kind;
    this.onChange();
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.active = false;
      this.activeKind = null;
      this.onChange();
      this.dispatch();
    });
  }

  get managementPending() {
    return this.waiters.some((waiter) => waiter.kind === 'management');
  }

  get managementActive() {
    return this.activeKind === 'management';
  }

  get maintenancePending() {
    return this.waiters.some((waiter) => waiter.kind === 'maintenance');
  }

  get maintenanceActive() {
    return this.activeKind === 'maintenance';
  }
}
