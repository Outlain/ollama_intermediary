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
      currentModel: status.current_model,
    });
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  }

  async handleGeneration(request, response, url, id, forcedClient) {
    if (!this.scheduler.accepting) return sendJson(response, 503, { error: 'proxy is shutting down', code: 'shutting_down' }, id);
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

    const controller = new AbortController();
    const abort = () => {
      if (!response.writableEnded) controller.abort(new Error('client disconnected'));
    };
    request.once('aborted', abort);
    response.once('close', abort);
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
      signal: controller.signal,
      abortController: controller,
      dedupeKey: this.classifier.dedupeKey(client, request, parsed),
    });
    const admission = this.scheduler.enqueue(job);
    if (!admission.accepted) {
      response.removeListener('close', abort);
      return sendJson(response, admission.status, { error: admission.message, code: admission.code }, id);
    }

    controller.signal.addEventListener('abort', () => this.scheduler.cancel(job), { once: true });
    const result = await job.result;
    if (result.type === 'local_error') {
      response.removeListener('close', abort);
      return sendJson(response, result.status, { error: result.message, code: result.code }, id);
    }

    let streamError = null;
    let status = 499;
    try {
      const upstream = result.upstream;
      status = upstream.statusCode ?? 502;
      copyResponseHeaders(upstream.headers, response);
      response.statusCode = status;
      response.flushHeaders();
      await streamBody(upstream, response, { flush: streaming });
    } catch (error) {
      streamError = error;
      if (!controller.signal.aborted) this.logger.warn('response stream failed', { request_id: id, error: error.message });
    } finally {
      response.removeListener('close', abort);
      result.cleanup?.();
      job.finish({ status, error: streamError, clientDisconnected: controller.signal.aborted });
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
        const { response, cleanup } = await this.backendClient.request({
          method: job.method, path: job.path, headers: job.headers, body: job.body, signal: job.signal,
        });
        if (job.modelLoadExpected) {
          this.metrics.observe('proxy_model_load_duration_seconds', (Date.now() - startedAt) / 1000, { model: job.model });
        }
        this.backend.recordHttpStatus(response.statusCode ?? 502);
        job.settle({ type: 'upstream', upstream: response, cleanup });
        const outcome = await job.finished;
        if (outcome.error && !outcome.clientDisconnected) this.backend.recordFailure(outcome.error, 'response_stream');
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
          this.backend.recordFailure(error);
          const timedOut = /timeout/i.test(`${error.message ?? ''} ${error.cause?.message ?? ''}`);
          job.settle({
            type: 'local_error', status: timedOut ? 504 : 502,
            code: timedOut ? 'backend_timeout' : 'backend_error',
            message: timedOut ? 'Ollama request exceeded the configured hard runtime' : 'Ollama backend request failed',
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
