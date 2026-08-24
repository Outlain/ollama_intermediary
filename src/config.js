import fs from 'node:fs';
import YAML from 'yaml';

const DURATION_RE = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)$/;

export function parseDuration(value, field = 'duration') {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') throw new Error(`${field} must be a duration such as 500ms, 20s, or 30m`);
  const match = DURATION_RE.exec(value.trim());
  if (!match) throw new Error(`${field} has invalid duration ${JSON.stringify(value)}`);
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Number(match[1]) * factors[match[2]];
}

const DEFAULTS = {
  server: {
    listen: '0.0.0.0:11434',
    body_limit_bytes: 64 * 1024 * 1024,
    shutdown_grace: '2m',
    trusted_proxy: false,
    status_path: '/status',
    metrics_path: '/metrics',
    dedicated_listeners: [],
  },
  ollama: {
    url: 'http://127.0.0.1:11434',
    health_interval: '5s',
    health_timeout: '3s',
    request_timeout: '30m',
  },
  scheduler: {
    max_parallel_generations: 1,
    priority_aging: true,
    aging_interval: '10s',
    aging_bonus: 5,
    unknown_model_policy: 'schedule',
  },
  circuit_breaker: {
    failure_threshold: 3,
    failure_window: '60s',
    open_duration: '30s',
    queue_behavior: 'hold',
  },
  model_management: {
    enabled: true,
    serialize_with_inference: true,
  },
  clients: {
    default: {
      priority: 50,
      queue_limit: 20,
      request_ttl: '10m',
      max_wait: '5m',
      overflow_policy: 'reject',
      models: [],
      source_ips: [],
      model_policy: {
        idle_hold: '0s',
        max_batch_requests: 1,
        max_batch_time: '60s',
        keep_alive: null,
      },
    },
  },
  models: {},
};

function clone(value) {
  return structuredClone(value);
}

function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return overlay ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(base?.[key] ?? {}, value)
      : value;
  }
  return result;
}

function durationFields(config) {
  config.server.shutdownGraceMs = parseDuration(config.server.shutdown_grace, 'server.shutdown_grace');
  config.ollama.healthIntervalMs = parseDuration(config.ollama.health_interval, 'ollama.health_interval');
  config.ollama.healthTimeoutMs = parseDuration(config.ollama.health_timeout, 'ollama.health_timeout');
  config.ollama.requestTimeoutMs = parseDuration(config.ollama.request_timeout, 'ollama.request_timeout');
  config.scheduler.agingIntervalMs = parseDuration(config.scheduler.aging_interval, 'scheduler.aging_interval');
  config.circuit_breaker.failureWindowMs = parseDuration(config.circuit_breaker.failure_window, 'circuit_breaker.failure_window');
  config.circuit_breaker.openDurationMs = parseDuration(config.circuit_breaker.open_duration, 'circuit_breaker.open_duration');

  for (const [name, client] of Object.entries(config.clients)) {
    client.requestTtlMs = parseDuration(client.request_ttl, `clients.${name}.request_ttl`);
    client.maxWaitMs = parseDuration(client.max_wait, `clients.${name}.max_wait`);
    client.models = (client.models ?? []).filter(Boolean);
    client.source_ips = (client.source_ips ?? []).filter(Boolean);
    client.overflow_policy ??= 'reject';
    client.deduplication = deepMerge({ enabled: false, headers: [], json_fields: [] }, client.deduplication ?? {});
    client.model_policy = normalizeModelPolicy(client.model_policy ?? {}, `clients.${name}.model_policy`, name);
  }

  for (const [name, model] of Object.entries(config.models)) {
    config.models[name] = normalizeModelPolicy(model, `models.${name}`, name);
  }
}

function normalizeModelPolicy(policy, field, fallbackGroup) {
  const normalized = { ...policy };
  normalized.idleHoldMs = parseDuration(normalized.idle_hold ?? '0s', `${field}.idle_hold`);
  normalized.maxBatchTimeMs = parseDuration(normalized.max_batch_time ?? '60s', `${field}.max_batch_time`);
  normalized.max_batch_requests ??= 1;
  if (!Number.isInteger(normalized.max_batch_requests) || normalized.max_batch_requests < 1) {
    throw new Error(`${field}.max_batch_requests must be a positive integer`);
  }
  normalized.keep_alive ??= null;
  normalized.group ??= fallbackGroup;
  return normalized;
}

function validate(config) {
  if (config.scheduler.max_parallel_generations !== 1) {
    throw new Error('scheduler.max_parallel_generations must be 1; this release intentionally serializes GPU work');
  }
  if (!config.clients.default) throw new Error('clients.default is required');
  for (const [name, client] of Object.entries(config.clients)) {
    if (!Number.isFinite(client.priority)) throw new Error(`clients.${name}.priority must be a number`);
    if (!Number.isInteger(client.queue_limit) || client.queue_limit < 1) throw new Error(`clients.${name}.queue_limit must be a positive integer`);
    if (!['reject', 'drop_newest', 'drop_oldest'].includes(client.overflow_policy)) {
      throw new Error(`clients.${name}.overflow_policy must be reject, drop_newest, or drop_oldest`);
    }
  }
  if (!['hold', 'reject_new'].includes(config.circuit_breaker.queue_behavior)) {
    throw new Error('circuit_breaker.queue_behavior must be hold or reject_new');
  }
  if (!['schedule', 'reject'].includes(config.scheduler.unknown_model_policy)) {
    throw new Error('scheduler.unknown_model_policy must be schedule or reject');
  }
  if (config.model_management.serialize_with_inference !== true) {
    throw new Error('model_management.serialize_with_inference must be true; model-state mutations may not overlap inference');
  }
  new URL(config.ollama.url);
}

export function normalizeConfig(raw = {}) {
  const config = deepMerge(clone(DEFAULTS), raw);
  // Every named client inherits operational defaults, while retaining its own identity fields.
  for (const [name, client] of Object.entries(config.clients)) {
    if (name !== 'default') config.clients[name] = deepMerge(clone(config.clients.default), client);
  }
  durationFields(config);
  validate(config);
  return config;
}

export function expandEnvironment(text, environment = process.env) {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:\?)([^}]*))?\}/g, (token, name, operator, operand = '') => {
    const value = environment[name];
    const missing = value === undefined || value === '';
    if (operator === ':-') return missing ? operand : value;
    if (operator === ':?' && missing) throw new Error(operand || `environment variable ${name} is required`);
    return value ?? '';
  });
}

export function loadConfig(path, environment = process.env) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read config file ${path}: ${error.message}`, { cause: error });
  }
  let raw;
  try {
    raw = YAML.parse(expandEnvironment(text, environment)) ?? {};
  } catch (error) {
    throw new Error(`cannot parse config file ${path}: ${error.message}`, { cause: error });
  }
  return normalizeConfig(raw);
}

export function parseListen(value) {
  const index = value.lastIndexOf(':');
  if (index < 1) throw new Error(`invalid listen address ${value}`);
  let host = value.slice(0, index);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const port = Number(value.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid listen port in ${value}`);
  return { host, port };
}
