import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const DEFAULT_RESPONSE_TAIL_LIMIT = 65_536;
const REQUEST_SUMMARY_NODE_LIMIT = 10_000;
const SAFE_DONE_REASONS = new Set([
  'stop', 'length', 'load', 'unload', 'tool_calls', 'content_filter', 'error', 'cancelled',
]);

function finiteInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function safeDisplay(value, limit = 256) {
  if (typeof value !== 'string') return value ?? null;
  return value.replace(/[\u0000-\u001f\u007f]/g, '�').slice(0, limit);
}

function traversalBudget(limit = REQUEST_SUMMARY_NODE_LIMIT) {
  return { remaining: limit, truncated: false };
}

function countText(value, budget) {
  let characters = 0;
  const stack = [value];
  while (stack.length) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;
    const current = stack.pop();
    if (typeof current === 'string') {
      characters += current.length;
      continue;
    }
    if (Array.isArray(current)) {
      const capacity = Math.max(0, budget.remaining - stack.length);
      const count = Math.min(current.length, capacity);
      if (count < current.length) budget.truncated = true;
      for (let index = count - 1; index >= 0; index -= 1) stack.push(current[index]);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (typeof current.text === 'string') characters += current.text.length;
    else if (typeof current.content === 'string') characters += current.content.length;
    else if (Array.isArray(current.content)) stack.push(current.content);
  }
  return characters;
}

function countImages(parsed, budget) {
  let count = Array.isArray(parsed?.images) ? parsed.images.length : 0;
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;
    const message = messages[messageIndex];
    if (Array.isArray(message?.images)) count += message.images.length;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      if (budget.remaining <= 0) {
        budget.truncated = true;
        break;
      }
      budget.remaining -= 1;
      const part = content[partIndex];
      if (['image', 'image_url', 'input_image'].includes(part?.type)) count += 1;
    }
  }
  return count;
}

export function requestType(pathname) {
  if (pathname === '/api/chat') return 'chat';
  if (pathname === '/api/generate') return 'generate';
  if (pathname === '/api/embed' || pathname === '/api/embeddings') return 'embedding';
  if (pathname === '/v1/chat/completions') return 'openai_chat';
  if (pathname === '/v1/embeddings') return 'openai_embedding';
  return 'generation';
}

export function summarizeRequest(pathname, parsed, bodyBytes) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const textBudget = traversalBudget();
  let inputCharacters = countText(parsed?.prompt, textBudget)
    + countText(parsed?.system, textBudget)
    + countText(parsed?.suffix, textBudget)
    + countText(parsed?.input, textBudget);
  for (let index = 0; index < messages.length; index += 1) {
    if (textBudget.remaining <= 0) {
      textBudget.truncated = true;
      break;
    }
    textBudget.remaining -= 1;
    inputCharacters += countText(messages[index]?.content, textBudget);
  }
  const imageBudget = traversalBudget();
  const imageCount = countImages(parsed, imageBudget);
  const requestedContext = finiteInteger(parsed?.options?.num_ctx);
  const requestedOutputTokens = finiteInteger(
    parsed?.options?.num_predict ?? parsed?.max_completion_tokens ?? parsed?.max_tokens,
  );
  return {
    body_bytes: bodyBytes,
    input_characters: inputCharacters,
    message_count: messages.length,
    image_count: imageCount,
    tool_count: Array.isArray(parsed?.tools) ? parsed.tools.length : 0,
    requested_context: requestedContext,
    requested_output_tokens: requestedOutputTokens,
    summary_truncated: textBudget.truncated || imageBudget.truncated,
  };
}

export function minimalRequestSummary(bodyBytes) {
  return {
    body_bytes: finiteInteger(bodyBytes) ?? 0,
    input_characters: 0,
    message_count: 0,
    image_count: 0,
    tool_count: 0,
    requested_context: null,
    requested_output_tokens: null,
    summary_truncated: true,
  };
}

function usageFromObject(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = value.usage && typeof value.usage === 'object' ? value.usage : value;
  const promptTokens = finiteInteger(usage.prompt_tokens ?? usage.prompt_eval_count);
  const outputTokens = finiteInteger(usage.completion_tokens ?? usage.eval_count);
  const totalTokens = finiteInteger(usage.total_tokens)
    ?? (promptTokens !== null && outputTokens !== null ? promptTokens + outputTokens : null);
  const totalDurationNs = finiteInteger(value.total_duration);
  const loadDurationNs = finiteInteger(value.load_duration);
  const promptDurationNs = finiteInteger(value.prompt_eval_duration);
  const outputDurationNs = finiteInteger(value.eval_duration);
  if ([promptTokens, outputTokens, totalTokens, totalDurationNs, loadDurationNs, promptDurationNs, outputDurationNs]
    .every((item) => item === null)) return null;
  const outputDurationSeconds = outputDurationNs === null ? null : outputDurationNs / 1_000_000_000;
  return {
    prompt_tokens: promptTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    total_duration_seconds: totalDurationNs === null ? null : totalDurationNs / 1_000_000_000,
    load_duration_seconds: loadDurationNs === null ? null : loadDurationNs / 1_000_000_000,
    prompt_duration_seconds: promptDurationNs === null ? null : promptDurationNs / 1_000_000_000,
    output_duration_seconds: outputDurationSeconds,
    output_tokens_per_second: outputTokens !== null && outputDurationSeconds > 0
      ? outputTokens / outputDurationSeconds
      : null,
    done_reason: SAFE_DONE_REASONS.has(value.done_reason) ? value.done_reason : null,
  };
}

export class ResponseStatsCollector {
  constructor(limit = DEFAULT_RESPONSE_TAIL_LIMIT) {
    this.limit = limit;
    this.bytes = 0;
    this.tailChunks = [];
    this.tailBytes = 0;
  }

  push(chunk) {
    const buffer = Buffer.from(chunk);
    this.bytes += buffer.length;
    if (buffer.length >= this.limit) {
      this.tailChunks = [Buffer.from(buffer.subarray(buffer.length - this.limit))];
      this.tailBytes = this.limit;
      return;
    }
    this.tailChunks.push(buffer);
    this.tailBytes += buffer.length;
    while (this.tailBytes > this.limit && this.tailChunks.length) {
      const overflow = this.tailBytes - this.limit;
      const first = this.tailChunks[0];
      if (first.length <= overflow) {
        this.tailChunks.shift();
        this.tailBytes -= first.length;
      } else {
        this.tailChunks[0] = first.subarray(overflow);
        this.tailBytes -= overflow;
      }
    }
  }

  finish() {
    const text = Buffer.concat(this.tailChunks, this.tailBytes).toString('utf8');
    const lines = text.split(/\r?\n/).reverse();
    let usage = null;
    for (let line of lines) {
      line = line.trim();
      if (!line || line === 'data: [DONE]') continue;
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        usage = usageFromObject(JSON.parse(line));
      } catch {
        // A truncated or non-JSON response is expected for some compatible APIs.
      }
      if (usage) break;
    }
    return { response_bytes: this.bytes, ...usage };
  }
}

export class Observability {
  constructor(config, { clock = () => Date.now() } = {}) {
    this.config = config;
    this.clock = clock;
    this.startedAt = clock();
    this.instanceId = randomUUID();
    this.sequence = 0;
    this.events = [];
    this.listeners = new Set();
  }

  record(type, fields = {}) {
    const event = {
      id: ++this.sequence,
      instance_id: this.instanceId,
      timestamp: new Date(this.clock()).toISOString(),
      type,
      ...fields,
    };
    this.events.push(event);
    if (this.events.length > this.config.observability.history_limit) {
      this.events.splice(0, this.events.length - this.config.observability.history_limit);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return event;
  }

  recent(limit = this.config.observability.recent_events) {
    const normalized = Math.max(0, Math.min(Number(limit) || 0, this.config.observability.history_limit));
    return this.events.slice(-normalized);
  }

  after(id) {
    const normalized = Number(id);
    if (!Number.isInteger(normalized) || normalized < 0) return [];
    return this.events.filter((event) => event.id > normalized);
  }

  subscribe(listener) {
    if (this.listeners.size >= this.config.observability.max_event_clients) return null;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  uptimeSeconds(now = this.clock()) {
    return Math.max(0, now - this.startedAt) / 1000;
  }
}

export function authorized(request, configuredToken) {
  if (!configuredToken) return true;
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(configuredToken).digest();
  return timingSafeEqual(supplied, expected);
}
