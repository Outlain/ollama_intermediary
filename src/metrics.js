const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 1800];

function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function labelKey(labels) {
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('|');
}

function formatLabels(labels) {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

export class Metrics {
  constructor() {
    this.counters = new Map();
    this.histograms = new Map();
    this.gauges = new Map();
  }

  increment(name, labels = {}, value = 1) {
    const key = `${name}|${labelKey(labels)}`;
    const current = this.counters.get(key) ?? { name, labels, value: 0 };
    current.value += value;
    this.counters.set(key, current);
  }

  observe(name, value, labels = {}, buckets = DEFAULT_BUCKETS) {
    const key = `${name}|${labelKey(labels)}`;
    const current = this.histograms.get(key) ?? {
      name, labels, buckets, counts: buckets.map(() => 0), count: 0, sum: 0,
    };
    current.count += 1;
    current.sum += value;
    buckets.forEach((bucket, index) => { if (value <= bucket) current.counts[index] += 1; });
    this.histograms.set(key, current);
  }

  set(name, value, labels = {}) {
    const key = `${name}|${labelKey(labels)}`;
    this.gauges.set(key, { name, labels, value });
  }

  clearGauge(name) {
    for (const [key, entry] of this.gauges) if (entry.name === name) this.gauges.delete(key);
  }

  render(dynamic = {}) {
    const lines = [
      '# HELP proxy_queue_depth Number of inference requests waiting in the proxy.',
      '# TYPE proxy_queue_depth gauge',
    ];
    for (const [client, depth] of Object.entries(dynamic.queueDepth ?? {})) {
      lines.push(`proxy_queue_depth${formatLabels({ client })} ${depth}`);
    }
    lines.push('# HELP proxy_oldest_queue_wait_seconds Age of the oldest queued request.', '# TYPE proxy_oldest_queue_wait_seconds gauge');
    for (const [client, age] of Object.entries(dynamic.oldestWait ?? {})) {
      lines.push(`proxy_oldest_queue_wait_seconds${formatLabels({ client })} ${age}`);
    }
    lines.push('# HELP proxy_backend_healthy Whether the Ollama backend is accepting inference work.', '# TYPE proxy_backend_healthy gauge');
    lines.push(`proxy_backend_healthy ${dynamic.backendHealthy ? 1 : 0}`);
    lines.push('# HELP proxy_current_model Currently selected model.', '# TYPE proxy_current_model gauge');
    if (dynamic.currentModel) lines.push(`proxy_current_model${formatLabels({ model: dynamic.currentModel })} 1`);

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
