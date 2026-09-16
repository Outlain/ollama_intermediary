const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 1800];
const SIZE_BUCKETS = [256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864, 134_217_728];
const MODEL_LABELS = new Set(['model', 'from', 'to']);

function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function labelKey(labels) {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}

function formatLabels(labels) {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

export class Metrics {
  constructor({ maxSeriesPerMetric = 128, maxModelNames = 32, maxLabelLength = 160 } = {}) {
    this.counters = new Map();
    this.histograms = new Map();
    this.gauges = new Map();
    this.maxSeriesPerMetric = maxSeriesPerMetric;
    this.maxModelNames = maxModelNames;
    this.maxLabelLength = maxLabelLength;
    this.modelNames = new Set();
    this.series = new Map();
  }

  // Model names originate in client requests. Keep useful names for normal
  // deployments, but aggregate excess values instead of retaining them forever.
  boundedLabels(labels) {
    return Object.fromEntries(Object.entries(labels).map(([key, value]) => {
      let text = String(value).slice(0, this.maxLabelLength);
      if (MODEL_LABELS.has(key)) {
        if (this.modelNames.has(text) || this.modelNames.size < this.maxModelNames) this.modelNames.add(text);
        else text = '__other__';
      }
      return [key, text];
    }));
  }

  metricLabels(name, labels) {
    const bounded = this.boundedLabels(labels);
    const key = labelKey(bounded);
    const known = this.series.get(name) ?? new Set();
    if (known.has(key)) return bounded;
    if (known.size >= this.maxSeriesPerMetric) return { overflow: 'true' };
    known.add(key);
    this.series.set(name, known);
    return bounded;
  }

  increment(name, labels = {}, value = 1) {
    if (!Number.isFinite(value)) return;
    labels = this.metricLabels(name, labels);
    const key = `${name}|${labelKey(labels)}`;
    const current = this.counters.get(key) ?? { name, labels, value: 0 };
    current.value += value;
    this.counters.set(key, current);
  }

  observe(name, value, labels = {}, buckets = /_(bytes|characters)$/.test(name) ? SIZE_BUCKETS : DEFAULT_BUCKETS) {
    if (!Number.isFinite(value)) return;
    labels = this.metricLabels(name, labels);
    const key = `${name}|${labelKey(labels)}`;
    const current = this.histograms.get(key) ?? {
      name, labels, buckets, counts: buckets.map(() => 0), count: 0, sum: 0,
    };
    current.count += 1;
    current.sum += value;
    current.buckets.forEach((bucket, index) => { if (value <= bucket) current.counts[index] += 1; });
    this.histograms.set(key, current);
  }

  set(name, value, labels = {}) {
    if (!Number.isFinite(value)) return;
    labels = this.metricLabels(name, labels);
    const key = `${name}|${labelKey(labels)}`;
    this.gauges.set(key, { name, labels, value });
  }

  clearGauge(name) {
    for (const [key, entry] of this.gauges) if (entry.name === name) this.gauges.delete(key);
    this.series.delete(name);
  }

  render(dynamic = {}) {
    const lines = [
      '# HELP proxy_queue_depth Number of inference requests waiting in the proxy.',
      '# TYPE proxy_queue_depth gauge',
    ];
    for (const [client, depth] of Object.entries(dynamic.queueDepth ?? {})) {
      lines.push(`proxy_queue_depth${formatLabels({ client })} ${depth}`);
    }
    lines.push('# HELP proxy_queue_depth_total Total number of inference requests waiting.', '# TYPE proxy_queue_depth_total gauge');
    lines.push(`proxy_queue_depth_total ${Object.values(dynamic.queueDepth ?? {}).reduce((total, value) => total + value, 0)}`);
    lines.push('# HELP proxy_oldest_queue_wait_seconds Age of the oldest queued request.', '# TYPE proxy_oldest_queue_wait_seconds gauge');
    for (const [client, age] of Object.entries(dynamic.oldestWait ?? {})) {
      lines.push(`proxy_oldest_queue_wait_seconds${formatLabels({ client })} ${age}`);
    }
    lines.push('# HELP proxy_backend_healthy Whether the Ollama backend is accepting inference work.', '# TYPE proxy_backend_healthy gauge');
    lines.push(`proxy_backend_healthy ${dynamic.backendHealthy ? 1 : 0}`);
    lines.push('# HELP proxy_gpu_recovery_required Whether inference is latched off after a hard GPU fault.', '# TYPE proxy_gpu_recovery_required gauge');
    lines.push(`proxy_gpu_recovery_required ${dynamic.recoveryRequired ? 1 : 0}`);
    lines.push('# HELP proxy_maintenance_paused Whether inference admission is disabled for GPU maintenance.', '# TYPE proxy_maintenance_paused gauge');
    lines.push(`proxy_maintenance_paused ${dynamic.maintenance?.paused ? 1 : 0}`);
    lines.push('# HELP proxy_maintenance_gpu_released Whether maintenance has confirmed that Ollama reports no loaded models.', '# TYPE proxy_maintenance_gpu_released gauge');
    lines.push(`proxy_maintenance_gpu_released ${dynamic.maintenance?.gpu_released ? 1 : 0}`);
    lines.push('# HELP proxy_maintenance_remaining_seconds Seconds until automatic maintenance resume, or zero for manual/pausing states.', '# TYPE proxy_maintenance_remaining_seconds gauge');
    lines.push(`proxy_maintenance_remaining_seconds ${dynamic.maintenance?.remaining_seconds ?? 0}`);
    lines.push('# HELP proxy_upstream_draining Whether an abandoned active request is being drained from Ollama.', '# TYPE proxy_upstream_draining gauge');
    lines.push(`proxy_upstream_draining ${dynamic.upstreamDraining ? 1 : 0}`);
    lines.push('# HELP proxy_current_model Currently selected model.', '# TYPE proxy_current_model gauge');
    if (dynamic.currentModel) lines.push(`proxy_current_model${formatLabels(this.boundedLabels({ model: dynamic.currentModel }))} 1`);
    lines.push('# HELP proxy_active_request Whether an inference request is currently active.', '# TYPE proxy_active_request gauge');
    if (dynamic.activeRequest) {
      lines.push(`proxy_active_request${formatLabels(this.boundedLabels({
        client: dynamic.activeRequest.client,
        endpoint: dynamic.activeRequest.endpoint,
        model: dynamic.activeRequest.model,
        streaming: dynamic.activeRequest.streaming ? 'true' : 'false',
      }))} 1`);
    } else {
      lines.push('proxy_active_request 0');
    }
    lines.push('# HELP proxy_active_request_duration_seconds Runtime of the active inference request.', '# TYPE proxy_active_request_duration_seconds gauge');
    lines.push(`proxy_active_request_duration_seconds ${dynamic.activeRequest?.running_seconds ?? 0}`);
    lines.push('# HELP proxy_ollama_loaded_model_vram_bytes VRAM reported by Ollama for each loaded model.', '# TYPE proxy_ollama_loaded_model_vram_bytes gauge');
    const loadedVram = new Map();
    for (const model of dynamic.loadedModels ?? []) {
      if (Number.isFinite(model.size_vram)) {
        const name = this.boundedLabels({ model: model.name }).model;
        loadedVram.set(name, (loadedVram.get(name) ?? 0) + model.size_vram);
      }
    }
    for (const [model, bytes] of loadedVram) lines.push(`proxy_ollama_loaded_model_vram_bytes${formatLabels({ model })} ${bytes}`);

    const typeSeen = new Set();
    for (const entry of this.counters.values()) {
      if (!typeSeen.has(entry.name)) {
        lines.push(`# TYPE ${entry.name} counter`);
        typeSeen.add(entry.name);
      }
      lines.push(`${entry.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    for (const entry of this.gauges.values()) {
      if (!typeSeen.has(entry.name)) {
        lines.push(`# TYPE ${entry.name} gauge`);
        typeSeen.add(entry.name);
      }
      lines.push(`${entry.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    for (const entry of this.histograms.values()) {
      if (!typeSeen.has(entry.name)) {
        lines.push(`# TYPE ${entry.name} histogram`);
        typeSeen.add(entry.name);
      }
      entry.buckets.forEach((bucket, index) => {
        lines.push(`${entry.name}_bucket${formatLabels({ ...entry.labels, le: bucket })} ${entry.counts[index]}`);
      });
      lines.push(`${entry.name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
      lines.push(`${entry.name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${entry.name}_count${formatLabels(entry.labels)} ${entry.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
