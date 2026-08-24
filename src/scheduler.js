function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

export function createJob(fields) {
  const result = deferred();
  const finished = deferred();
  return {
    ...fields,
    enqueuedAt: fields.enqueuedAt ?? Date.now(),
    state: 'new',
    result: result.promise,
    settle: result.resolve,
    finished: finished.promise,
    finish: finished.resolve,
  };
}

export class Scheduler {
  constructor(config, { logger, metrics, clock = () => Date.now() }) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.clock = clock;
    this.jobs = [];
    this.active = null;
    this.currentModel = null;
    this.currentModelGroup = null;
    this.lastActivity = null;
    this.leaseUntil = 0;
    this.batchModel = null;
    this.batchPolicy = null;
    this.batchStartedAt = 0;
    this.batchCount = 0;
    this.switches = 0;
    this.accepting = true;
    this.waiters = new Set();
  }

  modelPolicy(model, client = null) {
    return this.config.models[model]
      ?? (client ? this.config.clients[client]?.model_policy : null)
      ?? this.config.clients.default.model_policy;
  }

  enqueue(job) {
    if (!this.accepting) return { accepted: false, status: 503, code: 'shutting_down', message: 'proxy is shutting down' };
    const clientPolicy = this.config.clients[job.client];
    let sameClient = this.jobs.filter((item) => item.client === job.client && item.state === 'queued');

    if (job.dedupeKey) {
      const duplicate = sameClient.find((item) => item.dedupeKey === job.dedupeKey);
      if (duplicate) this.drop(duplicate, 429, 'superseded', 'request was superseded by a newer equivalent request');
      sameClient = this.jobs.filter((item) => item.client === job.client && item.state === 'queued');
    }

    if (sameClient.length >= clientPolicy.queue_limit) {
      if (clientPolicy.overflow_policy === 'drop_oldest') {
        this.drop(sameClient[0], 429, 'queue_overflow_drop_oldest', 'request was dropped to admit newer work');
      } else {
        const code = clientPolicy.overflow_policy === 'drop_newest' ? 'queue_overflow_drop_newest' : 'queue_full';
        this.metrics.increment('proxy_requests_dropped_total', { client: job.client, reason: code });
        return { accepted: false, status: 429, code, message: `queue for ${job.client} is full` };
      }
    }

    job.state = 'queued';
    job.deadline = job.enqueuedAt + clientPolicy.requestTtlMs;
    job.maxWaitAt = job.enqueuedAt + clientPolicy.maxWaitMs;
    this.jobs.push(job);
    this.metrics.increment('proxy_requests_total', { client: job.client, endpoint: job.pathname });
    this.logger.info('request queued', {
      request_id: job.id, detected_client: job.client, identification_method: job.identificationMethod,
      requested_model: job.model, queue_entry_time: new Date(job.enqueuedAt).toISOString(), streaming: job.streaming,
    });
    this.wake();
    return { accepted: true };
  }

  drop(job, status, code, message) {
    if (job.state !== 'queued') return false;
    const index = this.jobs.indexOf(job);
    if (index >= 0) this.jobs.splice(index, 1);
    job.state = 'dropped';
    this.metrics.increment('proxy_requests_dropped_total', { client: job.client, reason: code });
    job.settle({ type: 'local_error', status, code, message });
    this.logger.warn('queued request dropped', {
      request_id: job.id, detected_client: job.client, requested_model: job.model, reason: code,
      queue_wait: (this.clock() - job.enqueuedAt) / 1000,
    });
    return true;
  }

  cancel(job) {
    if (job.state !== 'queued') return false;
    const index = this.jobs.indexOf(job);
    if (index >= 0) this.jobs.splice(index, 1);
    job.state = 'cancelled';
    job.settle({ type: 'local_error', status: 499, code: 'client_closed', message: 'client disconnected while queued' });
    this.metrics.increment('proxy_requests_dropped_total', { client: job.client, reason: 'client_disconnect' });
    this.logger.info('queued request cancelled', {
      request_id: job.id, detected_client: job.client, requested_model: job.model,
      queue_wait: (this.clock() - job.enqueuedAt) / 1000,
    });
    this.wake();
    return true;
  }

  expire(now = this.clock()) {
    for (const job of [...this.jobs]) {
      if (job.state === 'queued' && job.deadline <= now) {
        this.drop(job, 408, 'queue_ttl_expired', 'request expired while waiting in the scheduling queue');
      }
    }
  }

  effectivePriority(job, now) {
    const client = this.config.clients[job.client];
    if (!this.config.scheduler.priority_aging) return client.priority;
    const intervals = Math.floor((now - job.enqueuedAt) / this.config.scheduler.agingIntervalMs);
    return client.priority + intervals * this.config.scheduler.aging_bonus;
  }

  candidates() {
    const seen = new Set();
    const result = [];
    for (const job of this.jobs) {
      if (job.state !== 'queued' || job.signal?.aborted) continue;
      const key = `${job.client}\u0000${job.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(job);
    }
    return result;
  }

  best(candidates, now) {
    return [...candidates].sort((left, right) => {
      const priority = this.effectivePriority(right, now) - this.effectivePriority(left, now);
      return priority || left.enqueuedAt - right.enqueuedAt || left.sequence - right.sequence;
    })[0];
  }

  take(now = this.clock()) {
    if (this.active || !this.accepting) return { job: null, delayMs: null };
    this.expire(now);
    const candidates = this.candidates();
    if (!candidates.length) return { job: null, delayMs: null };

    const forced = candidates.filter((job) => job.maxWaitAt <= now);
    const forcedOther = forced.filter((job) => job.model !== this.currentModel);
    let chosen;
    let reason;

    if (forcedOther.length) {
      chosen = forcedOther.sort((a, b) => a.maxWaitAt - b.maxWaitAt || a.sequence - b.sequence)[0];
      reason = 'max_wait_exceeded';
    } else {
      const current = candidates.filter((job) => job.model === this.currentModel);
      const other = candidates.filter((job) => job.model !== this.currentModel);
      const policy = this.batchPolicy ?? this.modelPolicy(this.currentModel, current[0]?.client);
      const batchAvailable = this.batchModel === this.currentModel
        && this.batchCount < policy.max_batch_requests
        && now - this.batchStartedAt < policy.maxBatchTimeMs;

      if (current.length && (batchAvailable || !other.length)) {
        chosen = this.best(current, now);
        reason = other.length ? 'model_affinity' : 'only_model_waiting';
      } else if (!current.length && this.currentModel && now < this.leaseUntil && !forced.length) {
        return { job: null, delayMs: Math.max(1, this.leaseUntil - now), reason: 'model_lease' };
      } else {
        const pool = current.length && other.length && !batchAvailable ? other : candidates;
        chosen = this.best(pool, now);
        reason = current.length && other.length && !batchAvailable ? 'batch_limit' : 'effective_priority';
      }
    }

    const previousModel = this.currentModel;
    const switching = Boolean(previousModel && previousModel !== chosen.model);
    const modelLoadExpected = previousModel !== chosen.model;
    if (chosen.model !== this.batchModel) {
      this.batchModel = chosen.model;
      this.batchStartedAt = now;
      this.batchCount = 0;
      this.batchPolicy = this.modelPolicy(chosen.model, chosen.client);
    } else if (!this.batchPolicy) {
      this.batchPolicy = this.modelPolicy(chosen.model, chosen.client);
    }
    if (switching) {
      this.switches += 1;
      this.metrics.increment('proxy_model_switches_total', { from: previousModel, to: chosen.model, reason });
      this.logger.info('model switch selected', {
        request_id: chosen.id, from_model: previousModel, to_model: chosen.model, reason,
      });
    }
    this.currentModel = chosen.model;
    this.currentModelGroup = this.modelPolicy(chosen.model, chosen.client).group;
    this.leaseUntil = 0;
    this.batchCount += 1;
    this.jobs.splice(this.jobs.indexOf(chosen), 1);
    chosen.state = 'active';
    chosen.dispatchedAt = now;
    chosen.switching = switching;
    chosen.modelLoadExpected = modelLoadExpected;
    chosen.scheduleReason = reason;
    this.active = chosen;
    const queueWait = (now - chosen.enqueuedAt) / 1000;
    this.metrics.observe('proxy_queue_wait_seconds', queueWait, { client: chosen.client, model: chosen.model });
    this.logger.info('request dispatched', {
      request_id: chosen.id, detected_client: chosen.client, requested_model: chosen.model,
      queue_wait: queueWait, dispatch_time: new Date(now).toISOString(), streaming: chosen.streaming,
      model_switch_decision: reason,
    });
    return { job: chosen, delayMs: 0, reason };
  }

  complete(job) {
    if (this.active !== job) return;
    const now = this.clock();
    this.active = null;
    this.lastActivity = now;
    this.leaseUntil = now + this.modelPolicy(job.model, job.client).idleHoldMs;
    this.wake();
  }

  reconcile(model) {
    if (this.active) return;
    const normalized = model || null;
    if (normalized === this.currentModel) return;
    this.logger.info('scheduler model state reconciled', { previous_model: this.currentModel, backend_model: normalized });
    this.currentModel = normalized;
    this.currentModelGroup = normalized ? this.modelPolicy(normalized).group : null;
    this.batchModel = normalized;
    this.batchPolicy = null;
    this.batchStartedAt = this.clock();
    this.batchCount = 0;
    this.leaseUntil = 0;
    this.wake();
  }

  status(now = this.clock()) {
    const queues = {};
    const oldestWait = {};
    const modelQueues = {};
    const oldestModelWait = {};
    for (const client of Object.keys(this.config.clients)) {
      const jobs = this.jobs.filter((job) => job.client === client && job.state === 'queued');
      queues[client] = jobs.length;
      oldestWait[client] = jobs.length ? (now - Math.min(...jobs.map((job) => job.enqueuedAt))) / 1000 : 0;
    }
    for (const job of this.jobs) {
      if (job.state !== 'queued') continue;
      modelQueues[job.model] = (modelQueues[job.model] ?? 0) + 1;
      const age = (now - job.enqueuedAt) / 1000;
      oldestModelWait[job.model] = Math.max(oldestModelWait[job.model] ?? 0, age);
    }
    return {
      current_model: this.currentModel,
      current_model_group: this.currentModelGroup,
      active_client: this.active?.client ?? null,
      active_request_id: this.active?.id ?? null,
      active_request_duration: this.active ? (now - this.active.dispatchedAt) / 1000 : 0,
      queues,
      oldest_wait_seconds: oldestWait,
      model_queues: modelQueues,
      oldest_model_wait_seconds: oldestModelWait,
      last_activity: this.lastActivity ? new Date(this.lastActivity).toISOString() : null,
      model_lease_remaining: Math.max(0, this.leaseUntil - now) / 1000,
      model_switches: this.switches,
      accepting: this.accepting,
    };
  }

  stop() {
    this.accepting = false;
    for (const job of [...this.jobs]) this.drop(job, 503, 'shutting_down', 'proxy is shutting down');
    this.wake();
  }

  wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  waitForChange(timeoutMs = null, signal = null) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
      if (timeoutMs !== null) timer = setTimeout(done, Math.max(1, timeoutMs));
    });
  }
}
