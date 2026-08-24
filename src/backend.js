import http from 'node:http';
import https from 'node:https';

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
    this.failures = [];
    this.openUntil = 0;
    this.timer = null;
    this.stopped = false;
    this.probing = false;
  }

  canDispatch(now = this.clock()) {
    return this.reachable && this.openUntil <= now;
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
      const model = models[0]?.name ?? models[0]?.model ?? null;
      const wasHealthy = this.canDispatch(now);
      this.reachable = true;
      this.lastSuccessAt = now;
      this.lastError = null;
      if (this.openUntil && this.openUntil <= now) {
        this.openUntil = 0;
        this.failures = [];
        this.logger.info('backend circuit breaker closed after successful probe');
      }
      this.onModel(model);
      if (!wasHealthy && this.canDispatch(now)) this.logger.info('Ollama backend is healthy', { loaded_model: model });
    } catch (error) {
      const wasReachable = this.reachable;
      this.reachable = false;
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
      state: this.canDispatch(now) ? 'healthy' : this.circuitOpen(now) ? 'circuit_open' : 'unreachable',
      reachable: this.reachable,
      circuit_open: this.circuitOpen(now),
      circuit_open_remaining: Math.max(0, this.openUntil - now) / 1000,
      last_probe_at: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
      last_success_at: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      last_error: this.lastError,
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

  request({ method, path, headers, body, signal }) {
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
      timeout = setTimeout(() => controller.abort(new Error('backend request hard timeout exceeded')), this.config.ollama.requestTimeoutMs);
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
    const managementIndex = this.waiters.findIndex((waiter) => waiter.kind === 'management');
    const index = managementIndex >= 0 ? managementIndex : 0;
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
}
