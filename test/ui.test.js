import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_JS } from '../src/dashboard.js';
import { SETTINGS_DASHBOARD_HTML, SETTINGS_DASHBOARD_CSS, SETTINGS_DASHBOARD_JS } from '../src/settings-dashboard.js';
import { maskSettings } from '../src/settings.js';
import { testConfig } from './helpers.js';

// Lightweight DOM contract tests keep the normal suite dependency-free. Layout
// still needs a real browser; these exercise the shipped rendering functions.
class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.type = 'text';
    this.className = '';
    this.validity = {};
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  addEventListener() {}
  setAttribute() {}
  focus() {}
  remove() {}
  querySelectorAll() { return this.children; }
}

function harness(kind) {
  const html = kind === 'dashboard' ? DASHBOARD_HTML : SETTINGS_DASHBOARD_HTML;
  const source = kind === 'dashboard' ? DASHBOARD_JS : SETTINGS_DASHBOARD_JS;
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const fields = [...html.matchAll(/data-field-wrap="([^"]+)"/g)].map((match) => {
    const element = new Element(); element.dataset.fieldWrap = match[1]; return element;
  });
  const inputs = [...html.matchAll(/<(?:input|select)\b[^>]*data-path="([^"]+)"[^>]*>/g)].map((match) => {
    const element = new Element();
    element.dataset.path = match[1];
    element.type = match[0].match(/\btype="([^"]+)"/)?.[1] || 'text';
    element.dataset.nullable = /data-nullable="true"/.test(match[0]) ? 'true' : 'false';
    fields.find((field) => field.dataset.fieldWrap === match[1])?.appendChild(element);
    return element;
  });
  const intervals = new Map();
  const timeouts = new Map();
  let nextTimer = 1;
  const context = vm.createContext({
    document: {
      getElementById: (id) => nodes.get(id),
      createElement: () => new Element(),
      querySelectorAll: (selector) => selector === '[data-path]' ? inputs : selector === '[data-field-wrap]' ? fields : [],
    },
    window: {
      setInterval: (fn, milliseconds) => { const id = nextTimer++; intervals.set(id, { fn, milliseconds }); return id; },
      clearInterval: (id) => intervals.delete(id),
      setTimeout: (fn, milliseconds) => { const id = nextTimer++; timeouts.set(id, { fn, milliseconds }); return id; },
      clearTimeout: (id) => timeouts.delete(id),
      addEventListener() {},
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance, AbortController,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  const marker = kind === 'dashboard' ? "  byId('token-form').addEventListener" : '  bindEvents();';
  const names = kind === 'dashboard'
    ? 'eventSeverity, formatRelativeDate, renderCatchup, healthState, refreshSnapshot, startPolling'
    : 'restartInfo, applyEnvelope, updateDirtyState';
  const boundary = source.indexOf(marker);
  assert.ok(boundary > 0, 'UI bootstrap marker must remain identifiable');
  vm.runInContext(`${source.slice(0, boundary)}\n globalThis.ui = { ${names} };\n})();`, context);
  return { context, ui: context.ui, nodes, fields, inputs, intervals, timeouts };
}

test('UI wrappers load their independent assets and all literal element references exist', () => {
  for (const [kind, html, css, js] of [['dashboard', DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_JS], ['settings', SETTINGS_DASHBOARD_HTML, SETTINGS_DASHBOARD_CSS, SETTINGS_DASHBOARD_JS]]) {
    assert.equal(js, fs.readFileSync(new URL(`../src/ui/${kind}.js`, import.meta.url), 'utf8'));
    assert.ok(css.includes('@media'));
    assert.doesNotThrow(() => new vm.Script(js));
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${kind}: duplicate element IDs`);
    for (const match of js.matchAll(/(?:byId|setText|setHidden)\('([^']+)'/g)) assert.ok(ids.includes(match[1]), `${kind}: missing ${match[1]}`);
  }
});

test('failed request outcomes never render as successful activity', () => {
  const { ui } = harness('dashboard');
  assert.equal(ui.eventSeverity({ type: 'request_failed', status: 502 }), 'event-danger');
  assert.equal(ui.eventSeverity({ type: 'request_completed', status: 500 }), 'event-danger');
  assert.equal(ui.eventSeverity({ type: 'request_completed', status: 200, outcome: 'failed' }), 'event-danger');
  assert.equal(ui.eventSeverity({ type: 'request_completed', status: 200 }), 'event-good');
});

test('future model expiration is displayed in the future rather than just now', () => {
  const { ui } = harness('dashboard');
  assert.match(ui.formatRelativeDate(new Date(Date.now() + 60_000).toISOString()), /^in /);
  assert.match(ui.formatRelativeDate(new Date(Date.now() - 60_000).toISOString()), /ago$/);
});

test('metadata health is not mistaken for successful model inference', () => {
  const { ui } = harness('dashboard');
  const status = ui.healthState({ backend: { reachable: true, state: 'healthy', last_inference_error: 'Model runner failed' }, service: { ready: true } });
  assert.equal(status.css, 'health-warning');
  assert.match(status.title, /inference request failed/);
});

test('catch-up rendering uses durable totals, pending jobs, timestamps, and expiry reasons', () => {
  const { ui, nodes } = harness('dashboard');
  ui.renderCatchup({ enabled: true, state: 'running', counts: { pending: 2, waiting_live: 3, retrying: 1 }, totals: { completed: 47 }, scan: { blocked_reason: 'capacity_reached' }, capabilities: { object: true, review: true }, pending_jobs: [{ kind: 'review', id: 'review-1', camera: 'Driveway', state: 'pending', event_time: 1_789_000_000 }], recent_jobs: [{ kind: 'object', id: 'object-2', camera: 'Driveway', state: 'skipped', reason: 'media_expired' }] });
  assert.equal(nodes.get('catchup-pending').textContent, '5');
  assert.equal(nodes.get('catchup-completed').textContent, '47');
  assert.match(nodes.get('catchup-detail').textContent, /Capacity Reached/);
  assert.match(nodes.get('catchup-pending-jobs').textContent, /Recorded/);
  assert.match(nodes.get('catchup-jobs').textContent, /Media Expired/);
  assert.equal(nodes.get('catchup-pending-empty').hidden, true);
});

test('dashboard restores the connected badge after a temporary polling failure', async () => {
  const { context, ui, nodes, intervals, timeouts } = harness('dashboard');
  ui.startPolling();
  assert.ok([...intervals.values()].some((timer) => timer.milliseconds === 2000));
  context.fetch = async () => { throw new Error('mock offline'); };
  assert.equal(await ui.refreshSnapshot(), false);
  assert.equal(nodes.get('connection-label').textContent, 'Disconnected');
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ backend: { reachable: true, state: 'healthy' }, service: { ready: true } }) });
  assert.equal(await ui.refreshSnapshot(), true);
  assert.equal(nodes.get('connection-label').textContent, 'Polling every 2s');
  assert.equal(timeouts.size, 0);
  assert.doesNotMatch(DASHBOARD_JS, /connectEvents|EVENTS_URL|STREAM_RETRY_MS|TextDecoder/);
});

test('hung polling is bounded and visibly reports a timeout', async () => {
  const { context, ui, nodes, timeouts } = harness('dashboard');
  context.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  const result = ui.refreshSnapshot();
  const timeout = [...timeouts.values()].find((timer) => timer.milliseconds === 10000);
  assert.ok(timeout);
  timeout.fn();
  assert.equal(await result, false);
  assert.match(nodes.get('page-error').textContent, /timed out/);
  assert.equal(nodes.get('connection-label').textContent, 'Disconnected');
});

test('strict settings hide and disable irrelevant fair-sharing fields', () => {
  const { ui, fields, nodes } = harness('settings');
  ui.applyEnvelope({ settings: maskSettings(testConfig({ scheduler: { mode: 'strict_priority' }, frigate: { enabled: true, url: 'http://frigate.example' } })), valid: true, revision: 'test', infrastructure: { ui_can_apply: true } });
  for (const path of ['scheduler.priority_aging', 'scheduler.aging_interval', 'clients.frigate.max_wait', 'clients.odysseus.model_policy.max_batch_time']) {
    const field = fields.find((item) => item.dataset.fieldWrap === path);
    assert.equal(field.hidden, true, path);
    assert.ok(field.children.every((input) => input.disabled), path);
  }
  assert.equal(nodes.get('catchup-scan').disabled, false);
});

test('restart_pending contract shows safe restart and blocks saved mutations and historical scan', () => {
  const { ui, nodes } = harness('settings');
  assert.equal(ui.restartInfo({ restart_pending: true }).title, 'Waiting for safe restart');
  ui.applyEnvelope({ settings: maskSettings(testConfig({ frigate: { enabled: true, url: 'http://frigate.example' } })), valid: true, restart_pending: true, revision: 'test', infrastructure: { ui_can_apply: true } });
  assert.equal(nodes.get('restart-banner').hidden, false);
  assert.equal(nodes.get('catchup-scan').disabled, true);
  assert.equal(nodes.get('apply-button').disabled, true);
  assert.equal(nodes.get('rollback-button').disabled, true);
  assert.equal(nodes.get('reset-button').disabled, true);
  assert.equal(nodes.get('document-state').textContent, 'Waiting for safe restart');
});
