import http from 'node:http';
import { once } from 'node:events';
import { BackendClient, BackendState, OperationGate } from './backend.js';
import { Classifier, classifyEndpoint, isStreaming } from './classifier.js';
import { copyRequestHeaders, copyResponseHeaders, readBody, sendJson, streamBody } from './http-utils.js';
import { Logger, requestId } from './logger.js';
import { Metrics } from './metrics.js';
import { createJob, Scheduler } from './scheduler.js';
import { parseListen } from './config.js';

function contentHeaders(headers, body) {
  const result = { ...headers };
  result['content-length'] = String(body.length);
  delete result['transfer-encoding'];
  return result;
}

function parseJson(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    const wrapped = new Error(`invalid JSON request body: ${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function applyKeepAlive(pathname, parsed, policy) {
  if (!policy?.keep_alive || pathname.startsWith('/v1/')) return { parsed, changed: false };
  if (parsed.keep_alive === policy.keep_alive) return { parsed, changed: false };
  return { parsed: { ...parsed, keep_alive: policy.keep_alive }, changed: true };
}

async function waitWithTimeout(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ProxyService {
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger ?? new Logger();
    this.metrics = options.metrics ?? new Metrics();
    this.classifier = new Classifier(config);
    this.scheduler = new Scheduler(config, { logger: this.logger, metrics: this.metrics, clock: options.clock });
    this.backendClient = new BackendClient(config);
    this.gate = new OperationGate(() => this.scheduler.wake());
    this.backend = new BackendState(config, {
      logger: this.logger,
      metrics: this.metrics,
      onModel: (model) => this.scheduler.reconcile(model),
      onChange: () => this.scheduler.wake(),
      clock: options.clock,
    });
    this.servers = [];
    this.sequence = 0;
    this.workerController = new AbortController();
    this.running = false;
    this.workerPromise = null;
    this.expiryTimer = null;
  }

  async start({ listen = true } = {}) {
    if (this.running) return this.addresses();
    this.running = true;
    this.backend.start();
    this.workerPromise = this.dispatchLoop();
    this.expiryTimer = setInterval(() => this.scheduler.expire(), Math.min(1_000, this.config.ollama.healthIntervalMs));
    this.expiryTimer.unref?.();
    if (listen) {
      await this.startServer(this.config.server.listen, null);
      for (const listener of this.config.server.dedicated_listeners) {
        if (!this.config.clients[listener.client]) throw new Error(`dedicated listener references unknown client ${listener.client}`);
        await this.startServer(listener.listen, listener.client);
      }
    }
    return this.addresses();
  }

  async startServer(listen, forcedClient) {
    const { host, port } = parseListen(listen);
    const server = http.createServer((request, response) => {
      this.handle(request, response, forcedClient).catch((error) => {
        this.logger.error('unhandled proxy request error', { error: error.stack ?? error.message });
        sendJson(response, error.statusCode ?? 500, { error: error.message, code: 'proxy_error' }, requestId(request.headers));
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = Math.max(60_000, this.config.ollama.requestTimeoutMs + 10_000);
    server.keepAliveTimeout = 65_000;
    server.listen(port, host);
    await once(server, 'listening');
    this.servers.push({ server, forcedClient });
    const address = server.address();
    this.logger.info('proxy listener started', { address, forced_client: forcedClient });
  }

  addresses() {
    return this.servers.map(({ server, forcedClient }) => ({ address: server.address(), forcedClient }));
  }

  async handle(request, response, forcedClient = null) {
    const id = requestId(request.headers);
    response.setHeader('x-request-id', id);
    const url = new URL(request.url, 'http://proxy.local');
    if (request.method === 'GET' && url.pathname === this.config.server.status_path) return this.handleStatus(response, id);
    if (request.method === 'GET' && url.pathname === this.config.server.metrics_path) return this.handleMetrics(response);
    if (request.method === 'GET' && url.pathname === '/healthz') return sendJson(response, 200, { status: 'ok' }, id);
    if (request.method === 'GET' && url.pathname === '/readyz') {
      const ready = this.backend.canDispatch();
      return sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', backend: this.backend.status() }, id);
    }

    const endpointClass = classifyEndpoint(request.method, url.pathname);
    if (endpointClass === 'generation') return this.handleGeneration(request, response, url, id, forcedClient);
    if (endpointClass === 'management') return this.handleManagement(request, response, url, id);
    return this.handlePassthrough(request, response, url, id);
  }

  handleStatus(response, id) {
    const scheduler = this.scheduler.status();
    sendJson(response, 200, { backend: this.backend.status(), ...scheduler }, id);
  }

  handleMetrics(response) {
    const status = this.scheduler.status();
    const body = this.metrics.render({
      queueDepth: status.queues,
      oldestWait: status.oldest_wait_seconds,
      backendHealthy: this.backend.canDispatch(),
      recoveryRequired: this.backend.recoveryRequired,
      upstreamDraining: status.upstream_draining,
      currentModel: status.current_model,
    });
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  }

  async handleGeneration(request, response, url, id, forcedClient) {
    if (!this.scheduler.accepting) return sendJson(response, 503, { error: 'proxy is shutting down', code: 'shutting_down' }, id);
    if (this.backend.recoveryRequired) {
      return sendJson(response, 503, {
        error: 'GPU recovery is required before inference can resume',
        code: 'gpu_recovery_required',
        detail: this.backend.recoveryReason,
      }, id);
    }
    if (this.config.circuit_breaker.queue_behavior === 'reject_new' && !this.backend.canDispatch()) {
      return sendJson(response, 503, { error: 'Ollama backend is unavailable', code: 'backend_unavailable' }, id);
    }
    let body;
    let parsed;
    try {
      body = await readBody(request, this.config.server.body_limit_bytes);
      parsed = parseJson(body);
    } catch (error) {
      return sendJson(response, error.statusCode ?? 400, { error: error.message, code: 'invalid_request' }, id);
    }
    if (!parsed.model || typeof parsed.model !== 'string') {
      return sendJson(response, 400, { error: 'generation request must contain a string model field', code: 'model_required' }, id);
    }
    if (!this.config.models[parsed.model] && this.config.scheduler.unknown_model_policy === 'reject') {
      return sendJson(response, 400, { error: `model ${parsed.model} is not configured`, code: 'unknown_model' }, id);
    }

    const identification = this.classifier.identify(request, parsed, forcedClient);
    const client = identification.client;
    const streaming = isStreaming(url.pathname, parsed);
    const normalized = applyKeepAlive(url.pathname, parsed, this.scheduler.modelPolicy(parsed.model, client));
    if (normalized.changed) body = Buffer.from(JSON.stringify(normalized.parsed));

    const upstreamController = new AbortController();
    const job = createJob({
      id,
      sequence: ++this.sequence,
      client,
      identificationMethod: identification.method,
      model: parsed.model,
      pathname: url.pathname,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      body,
      headers: contentHeaders(copyRequestHeaders(request.headers, this.config.ollama.url, id), body),
      streaming,
      signal: upstreamController.signal,
      abortController: upstreamController,
      downstreamDisconnected: false,
      dedupeKey: this.classifier.dedupeKey(client, request, parsed),
    });
    const disconnect = () => {
      if (response.writableEnded || job.downstreamDisconnected) return;
      job.downstreamDisconnected = true;
      if (job.state === 'queued') {
        this.scheduler.cancel(job);
        return;
      }
      if (job.state !== 'active') return;
      job.disconnectedAt = Date.now();
      this.metrics.increment('proxy_active_disconnects_total', { client: job.client, model: job.model });
      if (this.config.gpu_safety.drain_active_disconnects) {
        this.logger.warn('active client disconnected; draining upstream Ollama request', {
          request_id: job.id,
          detected_client: job.client,
          requested_model: job.model,
        });
      } else {
        this.logger.warn('active client disconnected; aborting upstream Ollama request', {
          request_id: job.id,
          detected_client: job.client,
          requested_model: job.model,
        });
        upstreamController.abort(new Error('client disconnected'));
      }
      this.scheduler.wake();
    };
    request.once('aborted', disconnect);
    response.once('close', disconnect);
    const removeDisconnectListeners = () => {
      request.removeListener('aborted', disconnect);
      response.removeListener('close', disconnect);
    };
    const admission = this.scheduler.enqueue(job);
    if (!admission.accepted) {
      removeDisconnectListeners();
      return sendJson(response, admission.status, { error: admission.message, code: admission.code }, id);
    }
    if (request.aborted || response.destroyed) disconnect();

    const result = await job.result;
    if (result.type === 'local_error') {
      removeDisconnectListeners();
      return sendJson(response, result.status, { error: result.message, code: result.code }, id);
    }

    let streamError = null;
    let status = 499;
    let responseBody = Buffer.alloc(0);
    try {
      const upstream = result.upstream;
      status = upstream.statusCode ?? 502;
      if (!job.downstreamDisconnected && !response.destroyed) {
        copyResponseHeaders(upstream.headers, response);
        response.statusCode = status;
        response.flushHeaders();
      }
      const transfer = await streamBody(upstream, response, {
        flush: streaming,
        drainOnClose: this.config.gpu_safety.drain_active_disconnects,
        captureLimit: status >= 500 ? this.config.gpu_safety.error_body_limit_bytes : 0,
      });
      responseBody = transfer.captured;
      job.downstreamDisconnected ||= transfer.downstreamClosed;
      if (job.downstreamDisconnected && this.config.gpu_safety.drain_active_disconnects) {
        this.metrics.observe('proxy_upstream_drain_duration_seconds', (Date.now() - (job.disconnectedAt ?? job.dispatchedAt)) / 1000, {
          client: job.client,
          model: job.model,
        });
        this.logger.info('upstream Ollama request drained after client disconnect', {
          request_id: job.id,
          detected_client: job.client,
          requested_model: job.model,
        });
      }
    } catch (error) {
      streamError = error;
      if (!upstreamController.signal.aborted) this.logger.warn('response stream failed', { request_id: id, error: error.message });
    } finally {
      removeDisconnectListeners();
      result.cleanup?.();
      job.finish({ status, error: streamError, clientDisconnected: job.downstreamDisconnected, responseBody });
    }
  }

  async handlePassthrough(request, response, url, id, release = null) {
    let body;
    try {
      body = await readBody(request, this.config.server.body_limit_bytes);
    } catch (error) {
      release?.();
      return sendJson(response, error.statusCode ?? 400, { error: error.message, code: 'invalid_request' }, id);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('client disconnected'));
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      const headers = contentHeaders(copyRequestHeaders(request.headers, this.config.ollama.url, id), body);
      const { response: upstream, cleanup } = await this.backendClient.request({
        method: request.method, path: `${url.pathname}${url.search}`, headers, body, signal: controller.signal,
      });
      copyResponseHeaders(upstream.headers, response);
      response.statusCode = upstream.statusCode ?? 502;
      response.flushHeaders();
      await streamBody(upstream, response, { flush: true });
      cleanup();
    } catch (error) {
      if (!controller.signal.aborted) {
        this.logger.warn('passthrough request failed', { request_id: id, path: url.pathname, error: error.message });
        sendJson(response, 502, { error: 'Ollama backend request failed', code: 'backend_error', detail: error.message }, id);
      }
    } finally {
      response.removeListener('close', abort);
      release?.();
    }
  }

  async handleManagement(request, response, url, id) {
    if (!this.config.model_management.enabled) {
      return sendJson(response, 403, { error: 'model-management endpoints are disabled', code: 'management_disabled' }, id);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('client disconnected'));
    response.once('close', abort);
    let release;
    try {
      release = await this.gate.acquire('management', controller.signal);
    } catch {
      return;
    }
    response.removeListener('close', abort);
    return this.handlePassthrough(request, response, url, id, release);
  }

  async dispatchLoop() {
    const signal = this.workerController.signal;
    while (!signal.aborted) {
      if (!this.backend.canDispatch()) {
        await this.scheduler.waitForChange(Math.min(1_000, this.config.ollama.healthIntervalMs), signal);
        continue;
      }
      if (this.gate.managementPending || this.gate.managementActive) {
        await this.scheduler.waitForChange(100, signal);
        continue;
      }
      const selection = this.scheduler.take();
      if (!selection.job) {
        await this.scheduler.waitForChange(selection.delayMs, signal);
        continue;
      }
      const job = selection.job;
      let release;
      const startedAt = Date.now();
      try {
        release = await this.gate.acquire('inference', job.signal);
        while (!this.backend.canDispatch() && !job.signal.aborted) {
          await this.scheduler.waitForChange(Math.min(1_000, this.config.ollama.healthIntervalMs), job.signal);
        }
        if (job.signal.aborted) throw job.signal.reason;
        if (job.switching && job.previousModel && this.config.gpu_safety.unload_on_model_switch) {
          const unloadStartedAt = Date.now();
          this.logger.info('unloading previous Ollama model before switch', {
            request_id: job.id,
            from_model: job.previousModel,
            to_model: job.model,
          });
          try {
            await this.backendClient.unloadModel(job.previousModel, {
              signal: job.signal,
              timeoutMs: this.config.gpu_safety.unloadTimeoutMs,
            });
          } catch (error) {
            if (job.signal.aborted) throw error;
            const wrapped = new Error(`failed to unload ${job.previousModel} before switching to ${job.model}: ${error.message}`, { cause: error });
            wrapped.code = error.code === 'model_unload_timeout' ? error.code : 'model_unload_failed';
            throw wrapped;
          }
          const unloadDuration = (Date.now() - unloadStartedAt) / 1000;
          this.metrics.observe('proxy_model_unload_duration_seconds', unloadDuration, {
            from: job.previousModel,
            to: job.model,
          });
          this.logger.info('previous Ollama model unload confirmed', {
            request_id: job.id,
            from_model: job.previousModel,
            to_model: job.model,
            unload_duration: unloadDuration,
          });
        }
        const { response, cleanup } = await this.backendClient.request({
          method: job.method, path: job.path, headers: job.headers, body: job.body, signal: job.signal,
        });
        if (job.modelLoadExpected) {
          this.metrics.observe('proxy_model_load_duration_seconds', (Date.now() - startedAt) / 1000, { model: job.model });
        }
        job.settle({ type: 'upstream', upstream: response, cleanup });
        const outcome = await job.finished;
        const backendResult = this.backend.recordGenerationResult(
          outcome.status,
          outcome.responseBody,
          outcome.clientDisconnected ? null : outcome.error,
        );
        if (backendResult.recoveryRequired) {
          this.scheduler.failQueued(503, 'gpu_recovery_required', 'GPU recovery is required before inference can resume');
        }
        const duration = (Date.now() - job.dispatchedAt) / 1000;
        this.metrics.observe('proxy_request_duration_seconds', duration, { client: job.client, model: job.model });
        this.logger.info('request completed', {
          request_id: job.id, detected_client: job.client, requested_model: job.model,
          queue_wait: (job.dispatchedAt - job.enqueuedAt) / 1000,
          completion_time: new Date().toISOString(), request_duration: duration,
          http_status: outcome.status, streaming: job.streaming,
        });
      } catch (error) {
        const disconnected = job.signal?.aborted;
        if (disconnected) {
          job.settle({ type: 'local_error', status: 499, code: 'client_closed', message: 'client disconnected' });
        } else {
          if (error.code === 'model_unload_failed' || error.code === 'model_unload_timeout') {
            this.backend.requireRecovery(error, {
              from_model: job.previousModel,
              to_model: job.model,
            });
            this.scheduler.failQueued(503, 'gpu_recovery_required', 'GPU recovery is required before inference can resume');
          } else {
            this.backend.recordFailure(error);
          }
          const timedOut = /timeout/i.test(`${error.message ?? ''} ${error.cause?.message ?? ''}`);
          job.settle({
            type: 'local_error', status: this.backend.recoveryRequired ? 503 : timedOut ? 504 : 502,
            code: this.backend.recoveryRequired ? 'gpu_recovery_required' : timedOut ? 'backend_timeout' : 'backend_error',
            message: this.backend.recoveryRequired
              ? 'GPU recovery is required before inference can resume'
              : timedOut ? 'Ollama request exceeded the configured hard runtime' : 'Ollama backend request failed',
          });
          this.logger.error('generation dispatch failed', {
            request_id: job.id, detected_client: job.client, requested_model: job.model, error: error.message,
          });
        }
      } finally {
        release?.();
        this.scheduler.complete(job);
      }
    }
  }

  async stop(graceMs = this.config.server.shutdownGraceMs) {
    if (!this.running) return;
    this.running = false;
    this.scheduler.stop();
    this.backend.stop();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    const closes = this.servers.map(({ server }) => once(server, 'close').catch(() => {}));
    for (const { server } of this.servers) server.close();
    const activeFinished = this.scheduler.active?.finished ?? Promise.resolve();
    await waitWithTimeout(activeFinished, graceMs);
    this.scheduler.active?.abortController?.abort(new Error('shutdown grace period expired'));
    this.workerController.abort(new Error('proxy shutdown'));
    this.scheduler.wake();
    for (const { server } of this.servers) server.closeAllConnections?.();
    await Promise.allSettled(closes);
    await waitWithTimeout(this.workerPromise, 1_000);
    this.backendClient.close();
    this.logger.info('proxy stopped');
  }
}
