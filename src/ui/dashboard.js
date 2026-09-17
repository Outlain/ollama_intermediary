(function () {
  'use strict';

  var STATUS_URL = '/_intermediary/v1/status';
  var MAINTENANCE_PAUSE_URL = '/_intermediary/v1/maintenance/pause';
  var MAINTENANCE_RESUME_URL = '/_intermediary/v1/maintenance/resume';
  var TOKEN_KEY = 'ollama-intermediary-observability-token';
  var MAINTENANCE_TOKEN_KEY = 'ollama-intermediary-maintenance-token';
  var SETTINGS_TOKEN_KEY = 'ollama-intermediary-settings-admin-token';
  var POLL_INTERVAL_MS = 2000;

  var snapshot = null;
  var activeClock = null;
  var maintenanceClock = null;
  var memoryToken = '';
  var memoryMaintenanceToken = '';
  var maintenanceActionPending = false;
  var refreshPromise = null;
  var pollTimer = null;
  var authBlocked = false;
  var catchupOffset = 0;
  var catchupPage = null;
  var catchupPagePromise = null;
  var catchupRenderedPage = null;
  var catchupView = 'waiting';
  var catchupData = {};
  var catchupAdminToken = '';
  var catchupActionPending = false;
  var CATCHUP_PAGE_SIZE = 30;
  var CATCHUP_VIEWS = {
    waiting: ['Waiting · newest event first', 'Jobs not yet handed off. Odysseus and live Frigate work always have priority.'],
    awaiting: ['Awaiting saved result', 'One handoff at a time. Completion is confirmed only when Frigate saves a description.'],
    retrying: ['Retrying · newest event first', 'Retry times are earliest eligible times, not promised start times. Delays increase after unsuccessful attempts.'],
    attention: ['Needs attention · still retrying', 'These jobs have remained unsuccessful past the configured attention threshold. Automatic retries continue; waiting behind live work alone is not a failure.'],
    completed: ['Completed · retained history', 'Descriptions are saved in Frigate. Removing old history rows here never removes descriptions or recordings.'],
    skipped: ['Skipped / media missing · retained history', 'Jobs no longer eligible for generation, including confirmed missing media. Connection errors alone never prove that footage was deleted.']
  };

  function byId(id) { return document.getElementById(id); }
  function setText(id, value) {
    var element = byId(id);
    if (element) element.textContent = value == null || value === '' ? '—' : String(value);
  }
  function setHidden(id, hidden) {
    var element = byId(id);
    if (element) element.hidden = Boolean(hidden);
  }
  function safeNumber(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (fallback == null ? 0 : fallback);
  }
  function positiveNumber(value) { return Math.max(0, safeNumber(value, 0)); }
  function titleCase(value) {
    if (!value) return 'Unknown';
    return String(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }
  function compactId(value) {
    var text = String(value || '');
    if (text.length <= 14) return text || '—';
    return text.slice(0, 8) + '…' + text.slice(-4);
  }
  function formatInteger(value) {
    if (value == null || value === '') return '—';
    return Math.round(safeNumber(value, 0)).toLocaleString();
  }
  function formatBytes(value) {
    if (value == null || value === '') return '—';
    var bytes = positiveNumber(value);
    if (bytes < 1024) return Math.round(bytes) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var index = -1;
    do { bytes /= 1024; index += 1; } while (bytes >= 1024 && index < units.length - 1);
    var precision = bytes >= 10 ? 1 : 2;
    return bytes.toFixed(precision).replace(/\.0+$/, '') + ' ' + units[index];
  }
  function formatDuration(value) {
    if (value == null || value === '') return '—';
    var seconds = Math.max(0, Math.floor(safeNumber(value, 0)));
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    if (minutes < 60) return minutes + 'm ' + remainder + 's';
    var hours = Math.floor(minutes / 60);
    minutes %= 60;
    if (hours < 24) return hours + 'h ' + minutes + 'm';
    var days = Math.floor(hours / 24);
    return days + 'd ' + (hours % 24) + 'h';
  }
  function formatDate(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date);
  }
  function formatRelativeDate(value) {
    if (!value) return '—';
    var timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return '—';
    var seconds = (Date.now() - timestamp) / 1000;
    if (seconds < -1) return 'in ' + formatDuration(-seconds);
    if (seconds < 5) return 'just now';
    return formatDuration(seconds) + ' ago';
  }
  function create(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }
  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || memoryToken; }
    catch (_) { return memoryToken; }
  }
  function setToken(value) {
    memoryToken = value || '';
    try {
      if (memoryToken) sessionStorage.setItem(TOKEN_KEY, memoryToken);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (_) { /* Session storage may be disabled; memory is still tab-scoped. */ }
    setHidden('forget-token', !memoryToken);
  }
  function getMaintenanceToken() {
    try { return sessionStorage.getItem(MAINTENANCE_TOKEN_KEY) || memoryMaintenanceToken; }
    catch (_) { return memoryMaintenanceToken; }
  }
  function setMaintenanceToken(value) {
    memoryMaintenanceToken = value || '';
    try {
      if (memoryMaintenanceToken) sessionStorage.setItem(MAINTENANCE_TOKEN_KEY, memoryMaintenanceToken);
      else sessionStorage.removeItem(MAINTENANCE_TOKEN_KEY);
    } catch (_) { /* Session storage may be disabled; memory is still tab-scoped. */ }
    setHidden('forget-maintenance-token', !memoryMaintenanceToken);
    setText('maintenance-token-state', memoryMaintenanceToken
      ? 'Control token saved for this browser tab.'
      : 'Enter the separate maintenance token to enable controls.');
    syncMaintenanceControls();
  }
  function requestHeaders() {
    var headers = { accept: 'application/json' };
    var token = getToken();
    if (token) headers.authorization = 'Bearer ' + token;
    return headers;
  }
  function maintenanceHeaders() {
    var headers = { accept: 'application/json', 'content-type': 'application/json' };
    var token = getMaintenanceToken();
    if (token) headers.authorization = 'Bearer ' + token;
    return headers;
  }

  function setConnection(kind, label) {
    var badge = byId('connection-status');
    badge.classList.remove('is-live', 'is-offline');
    if (kind === 'live') badge.classList.add('is-live');
    if (kind === 'offline') badge.classList.add('is-offline');
    setText('connection-label', label);
  }
  function showError(message) {
    setText('page-error', message);
    setHidden('page-error', !message);
  }
  function showAuth(message) {
    authBlocked = true;
    setHidden('auth-panel', false);
    setText('auth-message', message || 'A valid observability token is required.');
    setConnection('offline', 'Authentication required');
    stopConnections();
    window.setTimeout(function () { byId('token-input').focus(); }, 0);
  }
  function hideAuth() {
    authBlocked = false;
    setHidden('auth-panel', true);
    setText('auth-message', 'This dashboard needs a token to read operational metadata.');
  }

  function healthState(data) {
    var backend = data.backend || {};
    var service = data.service || {};
    var scheduler = data.scheduler || {};
    var maintenance = data.maintenance || {};
    var maintenanceState = String(maintenance.state || (maintenance.paused ? 'paused' : 'running')).toLowerCase();
    var ready = typeof service.ready === 'boolean' ? service.ready : service.state === 'ready';
    if (backend.recovery_required) {
      return { css: 'health-danger', title: 'GPU recovery required', detail: backend.recovery_reason || 'Inference is paused to protect the GPU.' };
    }
    if (maintenanceState === 'error') {
      return { css: 'health-danger', title: 'Pause mode needs attention', detail: maintenance.unload_error || maintenance.reason || 'The intermediary could not complete the maintenance transition.' };
    }
    if (maintenanceState === 'pausing') {
      return { css: 'health-warning', title: 'Preparing the GPU for maintenance', detail: 'The active request is draining; queued and new inference requests receive HTTP 503.' };
    }
    if (maintenanceState === 'paused' || maintenance.paused) {
      return { css: 'health-warning', title: 'GPU reserved by pause mode', detail: maintenance.resume_at ? 'Inference will resume automatically when the timer expires.' : 'Inference remains paused until it is manually resumed.' };
    }
    if (!backend.reachable || backend.state === 'unhealthy' || backend.state === 'offline') {
      return { css: 'health-danger', title: 'Ollama is unavailable', detail: 'The intermediary cannot currently reach the Ollama backend.' };
    }
    if (!ready || service.accepting === false) {
      return { css: 'health-warning', title: 'Requests are paused', detail: 'The intermediary is online but is not accepting new inference requests.' };
    }
    if (backend.state && backend.state !== 'healthy') {
      return { css: 'health-warning', title: titleCase(backend.state), detail: 'The backend is reachable but is not in its normal healthy state.' };
    }
    if (backend.last_inference_error) {
      return { css: 'health-warning', title: 'Last inference request failed', detail: 'The Ollama API is reachable, but that does not confirm the model ran successfully. Inspect recent activity for the failure.' };
    }
    return {
      css: 'health-good',
      title: 'Everything is operational',
      detail: 'Ollama is reachable · Scheduler is ' + titleCase(scheduler.state || 'idle').toLowerCase() + '.'
    };
  }

  function renderHealth(data) {
    var service = data.service || {};
    var result = healthState(data);
    var banner = byId('health-banner');
    banner.classList.remove('health-neutral', 'health-good', 'health-warning', 'health-danger');
    banner.classList.add(result.css);
    setText('overall-state', result.title);
    setText('overall-detail', result.detail);
    setText('service-uptime', formatDuration(service.uptime_seconds));
    setText('snapshot-age', formatRelativeDate(data.generated_at));
    setText('schema-version', 'Schema ' + (data.schema_version || '—'));
  }

  function setMaintenanceActionStatus(message, kind) {
    var element = byId('maintenance-action-status');
    element.className = 'action-status';
    if (kind === 'error') element.classList.add('is-error');
    if (kind === 'success') element.classList.add('is-success');
    element.textContent = message || '';
  }

  function syncMaintenanceControls() {
    var maintenance = snapshot && snapshot.maintenance ? snapshot.maintenance : {};
    var state = String(maintenance.state || (maintenance.paused ? 'paused' : 'running')).toLowerCase();
    var controlAvailable = maintenance.control_available === true;
    var hasToken = Boolean(getMaintenanceToken());
    var canAct = controlAvailable && hasToken && !maintenanceActionPending;
    var tokenInput = byId('maintenance-token-input');
    var tokenSubmit = byId('maintenance-token-submit');
    var duration = byId('pause-duration');
    var pause = byId('pause-button');
    var resume = byId('resume-button');

    if (tokenInput) tokenInput.disabled = !controlAvailable;
    if (tokenSubmit) tokenSubmit.disabled = !controlAvailable;
    if (duration) duration.disabled = !canAct || state !== 'running';
    if (pause) pause.disabled = !canAct || state !== 'running';
    if (resume) resume.disabled = !canAct || (state !== 'paused' && state !== 'pausing' && state !== 'error');

    if (!snapshot) {
      setText('maintenance-control-availability', 'Waiting for maintenance status…');
    } else if (!controlAvailable) {
      setText('maintenance-control-availability', 'Maintenance controls are unavailable because no server-side maintenance token is configured.');
    } else if (!hasToken) {
      setText('maintenance-control-availability', 'Control API is available. Enter its separate token above to pause or resume inference.');
    } else if (maintenanceActionPending) {
      setText('maintenance-control-availability', 'A maintenance request is in progress…');
    } else {
      setText('maintenance-control-availability', 'Maintenance controls are ready. This token is used only for pause and resume requests.');
    }
  }

  function renderMaintenance(data) {
    var maintenance = data.maintenance || {};
    var state = String(maintenance.state || (maintenance.paused ? 'paused' : 'running')).toLowerCase();
    var stateTag = byId('maintenance-state');
    stateTag.className = 'tag tag-neutral';
    if (state === 'running') stateTag.className = 'tag tag-good';
    if (state === 'pausing' || state === 'paused') stateTag.className = 'tag tag-warning';
    if (state === 'error') stateTag.className = 'tag tag-danger';
    setText('maintenance-state', titleCase(state));

    var reasonPrefix = maintenance.reason ? 'Reason: ' + maintenance.reason + '. ' : '';
    if (state === 'pausing') {
      setText('maintenance-title', 'Finishing the active request');
      setText('maintenance-detail', reasonPrefix + 'No additional inference will start while the active upstream request drains.');
    } else if (state === 'error') {
      setText('maintenance-title', 'Pause mode needs attention');
      setText('maintenance-detail', maintenance.unload_error || maintenance.reason || 'The intermediary could not complete the requested transition.');
    } else if (state === 'paused' || maintenance.paused) {
      setText('maintenance-title', 'Inference is paused');
      setText('maintenance-detail', reasonPrefix + (maintenance.resume_at
        ? 'The intermediary will resume inference automatically when the timer expires.'
        : 'Inference will remain paused until it is manually resumed.'));
    } else {
      setText('maintenance-title', 'Inference is running normally');
      setText('maintenance-detail', 'Ollama requests are being accepted and scheduled. Pause mode is ready when you need the GPU elsewhere.');
    }

    var resumeTimestamp = maintenance.resume_at ? new Date(maintenance.resume_at).getTime() : NaN;
    var hasCountdown = (state === 'paused' || state === 'pausing') && (Number.isFinite(resumeTimestamp) || maintenance.remaining_seconds != null);
    if (hasCountdown) {
      maintenanceClock = {
        seconds: positiveNumber(maintenance.remaining_seconds),
        at: performance.now(),
        resumeAt: Number.isFinite(resumeTimestamp) ? resumeTimestamp : null
      };
      setText('maintenance-resume-at', Number.isFinite(resumeTimestamp) ? formatDate(maintenance.resume_at) : 'Timer active');
    } else {
      maintenanceClock = null;
      setText('maintenance-resume-at', (state === 'paused' || state === 'pausing') ? 'Manual' : '—');
      setText('maintenance-countdown', (state === 'paused' || state === 'pausing') ? 'Manual' : '—');
    }
    if (maintenance.gpu_released === true) setText('maintenance-gpu-released', 'Yes');
    else if (state === 'pausing') setText('maintenance-gpu-released', 'Waiting for drain');
    else if (state === 'paused' || state === 'error') setText('maintenance-gpu-released', 'No');
    else setText('maintenance-gpu-released', 'Available to Ollama');
    setText('maintenance-paused-at', formatDate(maintenance.paused_at));
    updateLiveClocks();
    syncMaintenanceControls();
  }

  function renderActive(data) {
    var active = data.active_request;
    var scheduler = data.scheduler || {};
    var workloadState = String(scheduler.state || (active ? 'busy' : 'idle')).toLowerCase();
    var stateTag = byId('active-state');
    stateTag.className = 'tag tag-neutral';
    if (workloadState === 'busy' || workloadState === 'idle') stateTag.className = 'tag tag-good';
    if (workloadState === 'recovery_required' || workloadState === 'unavailable' || workloadState === 'shutting_down') stateTag.className = 'tag tag-danger';
    setText('active-state', titleCase(workloadState));
    setHidden('active-empty', Boolean(active));
    setHidden('active-content', !active);
    if (!active) {
      activeClock = null;
      return;
    }

    var metadata = active.request || {};
    var clientTag = byId('active-client');
    clientTag.dataset.client = String(active.client || '').toLowerCase();
    setText('active-client', titleCase(active.client));
    setText('active-type', titleCase(active.type));
    setText('active-streaming', active.streaming ? 'Streaming' : 'Buffered');
    setText('active-model', active.model);
    setText('active-endpoint', active.endpoint);
    setText('active-queue-wait', formatDuration(active.queue_wait_seconds));
    setText('active-reason', titleCase(active.schedule_reason));
    setText('active-id', compactId(active.id));
    byId('active-id').title = active.id || '';
    setText('active-status-text', titleCase(active.state));
    setText('meta-body', formatBytes(metadata.body_bytes));
    setText('meta-characters', formatInteger(metadata.input_characters));
    setText('meta-messages', formatInteger(metadata.message_count));
    setText('meta-images', formatInteger(metadata.image_count));
    setText('meta-tools', formatInteger(metadata.tool_count));
    setText('meta-context', formatInteger(metadata.requested_context));
    setText('meta-output', formatInteger(metadata.requested_output_tokens));
    activeClock = { seconds: positiveNumber(active.running_seconds), at: performance.now() };
    updateLiveClocks();
  }

  function queueItem(item) {
    var li = create('li', 'queue-item');
    var header = create('div', 'queue-item-header');
    var title = create('div', 'queue-item-title');
    title.appendChild(create('strong', '', item.model || 'Unknown model'));
    title.appendChild(create('span', '', titleCase(item.client) + ' · ' + titleCase(item.type)));
    header.appendChild(title);
    header.appendChild(create('span', 'wait-time', formatDuration(item.waiting_seconds)));
    li.appendChild(header);

    var metadata = item.request || {};
    var meta = create('div', 'queue-meta');
    var values = [
      'Priority ' + formatInteger(item.effective_priority),
      'TTL ' + formatDuration(item.ttl_remaining_seconds),
      formatBytes(metadata.body_bytes),
      formatInteger(metadata.input_characters) + ' chars',
      formatInteger(metadata.message_count) + ' msgs',
      formatInteger(metadata.image_count) + ' imgs'
    ];
    values.forEach(function (value) { meta.appendChild(create('span', '', value)); });
    li.appendChild(meta);
    return li;
  }

  function renderQueue(data) {
    var queue = data.queue || {};
    var byClient = queue.by_client || {};
    var items = Array.isArray(queue.items) ? queue.items : [];
    setText('queue-total', formatInteger(queue.total));
    setText('queue-odysseus', formatInteger(byClient.odysseus));
    setText('queue-frigate', formatInteger(byClient.frigate));
    setText('queue-oldest', formatDuration(queue.oldest_wait_seconds));
    setHidden('queue-empty', items.length > 0);
    var list = byId('queue-items');
    list.replaceChildren();
    items.forEach(function (item) { list.appendChild(queueItem(item)); });
  }

  function detailSummary(details) {
    if (!details || typeof details !== 'object') return '';
    var values = [details.family, details.parameter_size, details.quantization_level].filter(Boolean);
    return values.join(' · ');
  }

  function modelItem(model) {
    var li = create('li', 'model-item');
    li.appendChild(create('strong', '', model.name || 'Unknown model'));
    li.appendChild(create('span', '', formatBytes(model.size_vram)));
    var parts = [];
    if (model.context_length != null) parts.push(formatInteger(model.context_length) + ' context');
    var details = detailSummary(model.details);
    if (details) parts.push(details);
    if (model.expires_at) parts.push('expires ' + formatRelativeDate(model.expires_at));
    li.appendChild(create('small', '', parts.join(' · ') || 'No additional details'));
    return li;
  }

  function renderBackend(data) {
    var backend = data.backend || {};
    var scheduler = data.scheduler || {};
    var models = Array.isArray(backend.loaded_models) ? backend.loaded_models : [];
    var state = backend.recovery_required ? 'Recovery required' : titleCase(backend.state);
    var stateTag = byId('backend-state');
    stateTag.className = backend.recovery_required || !backend.reachable ? 'tag tag-danger' : 'tag tag-good';
    setText('backend-state', state);
    setText('scheduler-model', scheduler.current_model || 'None loaded');
    setText('scheduler-group', scheduler.current_model_group ? 'Group: ' + scheduler.current_model_group : 'No active group');
    var totalVram = models.reduce(function (total, model) { return total + positiveNumber(model.size_vram); }, 0);
    var contexts = models.map(function (model) { return safeNumber(model.context_length, 0); }).filter(function (value) { return value > 0; });
    setText('backend-vram', totalVram ? formatBytes(totalVram) : '—');
    setText('backend-context', contexts.length ? formatInteger(Math.max.apply(Math, contexts)) : '—');
    setText('backend-lease', formatDuration(scheduler.model_lease_remaining));
    setText('backend-switches', formatInteger(scheduler.model_switches));
    setText('backend-draining', scheduler.upstream_draining ? 'Yes' : 'No');
    setText('backend-last-success', formatRelativeDate(backend.last_success_at));
    setHidden('recovery-warning', !backend.recovery_required);
    setText('recovery-reason', backend.recovery_reason || 'The backend reported an unsafe GPU state.');
    setHidden('inference-warning', !backend.last_inference_error || backend.recovery_required);
    setText('inference-warning', backend.last_inference_error);
    setText('loaded-model-count', formatInteger(models.length));
    setHidden('models-empty', models.length > 0);
    var list = byId('loaded-models');
    list.replaceChildren();
    models.forEach(function (model) { list.appendChild(modelItem(model)); });
  }

  function eventSeverity(event) {
    var type = String(event.type || '').toLowerCase();
    var status = String(event.status || '').toLowerCase();
    if (event.outcome === 'failed' || Number(event.status) >= 400 || status === 'error' || status === 'failed' || type.includes('failed') || type.includes('recovery') || type.includes('circuit_open')) return 'event-danger';
    if (status === 'completed' || status === 'success' || type.includes('completed') || type.includes('healthy') || type.includes('resum')) return 'event-good';
    if (type.includes('drop') || type.includes('cancel') || type.includes('disconnect') || type.includes('unload') || type.includes('paus')) return 'event-warning';
    return '';
  }
  function eventTitle(event) {
    var title = titleCase(event.type || event.status || 'Activity');
    if (event.client) title += ' · ' + titleCase(event.client);
    return title;
  }
  function eventDetail(event) {
    var values = [];
    var response = event.response || {};
    if (event.model) values.push(event.model);
    if (event.status && String(event.status).toLowerCase() !== String(event.type).toLowerCase()) values.push(titleCase(event.status));
    if (event.duration_seconds != null) values.push(formatDuration(event.duration_seconds));
    if (response.prompt_tokens != null) values.push(formatInteger(response.prompt_tokens) + ' input tok');
    if (response.output_tokens != null) values.push(formatInteger(response.output_tokens) + ' output tok');
    if (response.output_tokens_per_second != null) values.push(safeNumber(response.output_tokens_per_second, 0).toFixed(1) + ' tok/s');
    if (event.reason) values.push(titleCase(event.reason));
    return values.join(' · ') || 'Intermediary event';
  }
  function eventItem(event) {
    var li = create('li', 'timeline-item');
    li.appendChild(create('span', 'event-dot ' + eventSeverity(event)));
    var copy = create('div', 'event-copy');
    copy.appendChild(create('strong', '', eventTitle(event)));
    copy.appendChild(create('span', '', eventDetail(event)));
    li.appendChild(copy);
    li.appendChild(create('time', 'event-time', formatDate(event.timestamp)));
    return li;
  }
  function renderEvents(data) {
    var events = Array.isArray(data.recent_events) ? data.recent_events : [];
    setHidden('events-empty', events.length > 0);
    var list = byId('event-list');
    list.replaceChildren();
    events.slice().reverse().forEach(function (event) { list.appendChild(eventItem(event)); });
  }

  function render(data) {
    snapshot = data;
    renderHealth(data);
    renderMaintenance(data);
    renderActive(data);
    renderQueue(data);
    renderBackend(data);
    renderEvents(data);
    renderCatchup(data.frigate || {});
    if (data.build) setText('schema-version', 'Version ' + data.build.version + ' · ' + data.build.revision + ' · Schema ' + data.schema_version);
  }

  function renderCatchup(data) {
    catchupData = data;
    setText('catchup-state', titleCase(data.state || 'disabled'));
    var counts = data.counts || {};
    setText('catchup-pending', formatInteger((counts.pending || 0) + (counts.waiting_live || 0)));
    setText('catchup-retrying', formatInteger(counts.retrying || 0));
    setText('catchup-completed', formatInteger((data.totals || {}).completed || 0));
    var support = data.capabilities || {};
    setText('catchup-capabilities', 'Objects: ' + (support.object ? 'supported' : 'not verified') + ' · Reviews: ' + (support.review ? 'supported' : 'not verified'));
    setText('catchup-detail', data.enabled
      ? (data.blocked_reason ? titleCase(data.blocked_reason) : data.scan && data.scan.blocked_reason ? titleCase(data.scan.blocked_reason) : 'Background recovery runs only when live work and its idle hold are finished.')
      : 'Enable recovery and configure the Frigate connection in Settings.');
    setText('catchup-blocker', catchupBlocker(data));
    renderCatchupConfirmation();
    var views = data.views || {};
    Object.keys(CATCHUP_VIEWS).forEach(function (view) {
      setText('catchup-count-' + view, formatInteger(views[view] || 0));
    });
    byId('catchup-view-attention').classList.remove('has-attention');
    byId('catchup-view-retrying').classList.remove('has-retries');
    if (views.attention) byId('catchup-view-attention').classList.add('has-attention');
    if (views.retrying) byId('catchup-view-retrying').classList.add('has-retries');
    setText('catchup-history-limit', 'Retains the latest ' + formatInteger(data.history_limit || 1000)
      + ' completed / skipped records combined. Completed lifetime: ' + formatInteger((data.totals || {}).completed || 0)
      + ' · Skipped lifetime: ' + formatInteger((data.totals || {}).skipped || 0) + '. Tab counts describe stored rows, not lifetime totals.');
    var cleanup = data.cleanup || {};
    setText('catchup-cleanup', 'Media checks run independently of the GPU. Last cleanup: '
      + (cleanup.last_checked_at ? new Date(cleanup.last_checked_at).toLocaleString() : 'not yet checked')
      + ' · Known missing-media IDs remembered: ' + formatInteger(data.suppression_count || 0)
      + (cleanup.last_error ? ' · Cleanup delayed: ' + titleCase(cleanup.last_error) + '. This does not prove media was deleted.' : ''));
    setHidden('catchup-error', !data.last_error);
    setText('catchup-error', typeof data.last_error === 'string' ? data.last_error : data.last_error && (data.last_error.message || data.last_error.code));
    var warnings = Array.isArray(data.warnings) ? data.warnings : [];
    setHidden('catchup-warning', !warnings.length);
    setText('catchup-warning', warnings.length ? 'Some cameras use early-only object triggers that cannot be reconstructed later: '
      + warnings.map(function (warning) { return warning.camera + ' (' + titleCase(warning.code) + ')'; }).join(', ') : '');
    renderCatchupPage();
    syncCatchupControls();
  }

  function catchupBlocker(data) {
    if (!data.enabled) return 'Catch-up is disabled.';
    var background = snapshot && snapshot.scheduler && snapshot.scheduler.background || {};
    var reason = background.reason;
    var reasons = {
      maintenance_paused: 'Generation is paused for GPU maintenance; saved-result and media checks can still run.',
      recovery_required: 'Waiting for GPU recovery. No new catch-up generation can start.',
      backend_unavailable: 'Waiting for the Ollama backend to become available.',
      live_requests_pending: 'Waiting for incoming live requests to be admitted.',
      backend_operation: 'Waiting for the current backend operation to finish.',
      service_stopping: 'The intermediary is stopping or preparing a safe restart.',
      shutting_down: 'The intermediary is shutting down.'
    };
    if (reasons[reason]) return reasons[reason];
    if (data.active_job) return 'Waiting for Frigate to save the outstanding description. No second catch-up handoff is sent.';
    if (reason === 'active_request') {
      var active = snapshot && snapshot.active_request;
      return 'Waiting for ' + titleCase(active && active.client || 'the active request') + ' to finish. Running inference is not preempted.';
    }
    if (reason === 'live_requests_queued') {
      var queues = snapshot && snapshot.queue && snapshot.queue.by_client || {};
      return 'Waiting behind ' + (queues.odysseus ? 'Odysseus' : queues.frigate ? 'live Frigate requests' : 'live requests') + '.';
    }
    if (reason === 'model_lease') return 'Waiting for the short model idle hold' + (background.wait_seconds == null ? '' : ' (' + formatDuration(background.wait_seconds) + ')') + '. This is separate from model keep-alive.';
    if (data.scan && data.scan.blocked_reason) return 'Catch-up: ' + titleCase(data.scan.blocked_reason) + '.';
    if (!data.total_queued) return 'No unfinished descriptions are queued.';
    return 'The next eligible job may start when its live grace / retry delay and all safety checks permit.';
  }

  function renderCatchupConfirmation() {
    var active = catchupData.active_job;
    setText('catchup-active', active ? titleCase(active.kind) + ' · ' + (active.camera || '') + ' · ' + titleCase(active.state || active.status) : 'No background handoff.');
    setHidden('catchup-confirmation', !active);
    if (active) {
      var remaining = Math.max(0, (Number(active.next_attempt_at) - Date.now()) / 1000);
      setText('catchup-confirmation', (remaining > 0
        ? 'Waiting for Frigate to save the description. Confirmation window: ' + formatDuration(remaining) + ' remaining. '
        : 'Confirmation window elapsed. Checking the saved result before arranging an idle-only retry. ')
        + 'This is not proof that the model is still generating. Confirmation is checked separately from discovery; no second catch-up handoff starts meanwhile.');
    }
  }

  function renderCatchupJobs(id, emptyId, jobs) {
      var list = byId(id);
      var scroll = list.scrollTop;
      list.replaceChildren();
      setHidden(emptyId, jobs.length > 0);
      jobs.forEach(function (job) {
        var item = create('li', 'queue-item' + (job.needs_attention ? ' catchup-attention' : job.state === 'retrying' ? ' catchup-retrying' : ''));
        item.appendChild(create('strong', '', titleCase(job.kind) + ' · ' + (job.camera || '') + ' · ' + titleCase(job.state || job.status)));
        var eventTime = Number(job.event_time);
        var details = compactId(job.id || job.event_id) + (Number.isFinite(eventTime) && eventTime > 0 ? ' · Recorded ' + new Date(eventTime * 1000).toLocaleString() : '');
        if (job.reason) details += ' · ' + titleCase(job.reason);
        if (job.needs_attention) details += ' · Needs attention (automatic retries continue)';
        item.appendChild(create('p', 'muted', details));
        var attempts = [];
        if (job.attempts != null) attempts.push('Attempts: ' + formatInteger(job.attempts));
        if (job.failures) attempts.push('Unsuccessful / unconfirmed: ' + formatInteger(job.failures));
        if (job.last_attempt_at) attempts.push('Last attempt: ' + new Date(job.last_attempt_at).toLocaleString());
        if (job.first_failed_at) attempts.push('First unsuccessful attempt: ' + new Date(job.first_failed_at).toLocaleString());
        if (job.state === 'retrying' && job.next_attempt_at) attempts.push('Earliest retry: ' + new Date(job.next_attempt_at).toLocaleString() + ' (when idle, not a promised start)');
        if (attempts.length) item.appendChild(create('p', 'muted', attempts.join(' · ')));
        var action = job.state === 'retrying' ? 'retry' : (job.state || job.status) === 'skipped' ? 'recheck' : null;
        if (action) {
          var button = create('button', 'quiet-button catchup-job-action', action === 'retry' ? 'Retry when idle' : 'Recheck availability');
          button.type = 'button';
          button.disabled = !catchupAdminToken || catchupActionPending;
          button.title = catchupAdminToken ? 'Never bypasses scheduling or media checks' : 'Unlock with the Settings admin token below';
          button.addEventListener('click', function () { performCatchupAction(action, job); });
          item.appendChild(button);
        }
        list.appendChild(item);
      });
      list.scrollTop = scroll;
  }

  function renderCatchupPage() {
    var page = catchupPage || { items: [], offset: 0, total: 0 };
    Object.keys(CATCHUP_VIEWS).forEach(function (view) {
      byId('catchup-view-' + view).setAttribute('aria-pressed', String(view === catchupView));
    });
    setText('catchup-pending-heading', CATCHUP_VIEWS[catchupView][0]);
    setText('catchup-view-help', CATCHUP_VIEWS[catchupView][1]);
    var renderKey = JSON.stringify([catchupView, page.items, Boolean(catchupAdminToken), catchupActionPending]);
    if (renderKey !== catchupRenderedPage) {
      renderCatchupJobs('catchup-pending-jobs', 'catchup-pending-empty', page.items);
      catchupRenderedPage = renderKey;
    }
    setText('catchup-page-status', page.total ? 'Showing ' + (page.offset + 1) + '–'
      + (page.offset + page.items.length) + ' of ' + formatInteger(page.total) + ' saved jobs in this view' : 'No jobs in this view.');
    byId('catchup-previous').disabled = Boolean(catchupPagePromise) || catchupOffset === 0;
    byId('catchup-next').disabled = Boolean(catchupPagePromise) || catchupOffset + CATCHUP_PAGE_SIZE >= page.total;
  }

  async function refreshCatchupPage() {
    if (catchupPagePromise) return catchupPagePromise;
    var offset = catchupOffset;
    var view = catchupView;
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 10000);
    catchupPagePromise = (async function () {
      try {
        var response = await fetch('/_intermediary/v1/frigate/jobs?view=' + view + '&offset=' + offset + '&limit=' + CATCHUP_PAGE_SIZE,
          { headers: requestHeaders(), cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var page = await response.json();
        if (!Array.isArray(page.items) || !Number.isSafeInteger(page.offset) || !Number.isSafeInteger(page.total)) throw new Error('Invalid page');
        if (offset !== catchupOffset || view !== catchupView) return;
        catchupOffset = page.offset;
        catchupPage = page;
        renderCatchupPage();
      } catch (error) {
        if (view === catchupView) setText('catchup-page-status', 'Could not refresh this view. Retrying automatically; saved jobs are unchanged.');
      } finally {
        window.clearTimeout(timeout);
        catchupPagePromise = null;
        byId('catchup-previous').disabled = catchupOffset === 0;
        byId('catchup-next').disabled = !catchupPage || catchupOffset + CATCHUP_PAGE_SIZE >= catchupPage.total;
      }
    })();
    byId('catchup-previous').disabled = true;
    byId('catchup-next').disabled = true;
    return catchupPagePromise;
  }

  async function changeCatchupPage(direction) {
    if (catchupPagePromise || !catchupPage) return;
    var next = Math.max(0, catchupOffset + direction * CATCHUP_PAGE_SIZE);
    if (next >= catchupPage.total && next !== 0) return;
    catchupOffset = next;
    await refreshCatchupPage();
    byId('catchup-pending-jobs').scrollTop = 0;
  }

  async function changeCatchupView(view) {
    if (!CATCHUP_VIEWS[view] || view === catchupView) return;
    catchupView = view;
    catchupOffset = 0;
    catchupPage = null;
    renderCatchupPage();
    byId('catchup-pending-jobs').scrollTop = 0;
    if (catchupPagePromise) await catchupPagePromise;
    await refreshCatchupPage();
  }

  function savedCatchupToken() {
    try { return sessionStorage.getItem(SETTINGS_TOKEN_KEY) || ''; } catch (_) { return ''; }
  }

  function syncCatchupControls() {
    setHidden('catchup-use-saved-token', !savedCatchupToken() || Boolean(catchupAdminToken));
    setHidden('catchup-lock', !catchupAdminToken);
    setText('catchup-control-state', catchupAdminToken
      ? 'Settings token selected for this tab. The server checks it for every action. Retrying respects live priority, pause mode, and the active handoff.'
      : 'Controls are locked. Enter the separate Settings admin token, or explicitly use its saved token. Dashboard and maintenance tokens are never used for these actions.');
  }

  function unlockCatchup(token) {
    catchupAdminToken = String(token || '').trim();
    syncCatchupControls();
    renderCatchupPage();
  }

  async function performCatchupAction(action, job) {
    if (!catchupAdminToken || catchupActionPending || !['retry', 'recheck'].includes(action)) return;
    if (action === 'retry' && job.state !== 'retrying') return;
    if (action === 'recheck' && (job.state || job.status) !== 'skipped') return;
    if (!window.confirm(action === 'retry' ? 'Make this job eligible to retry when idle? Existing descriptions and media will be checked first. This does not bypass live priority or pause mode.' : 'Recheck this skipped item and queue it only if eligible again? No recording or description will be deleted.')) return;
    catchupActionPending = true;
    renderCatchupPage();
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 10000);
    try {
      var response = await fetch('/_intermediary/v1/frigate/' + action, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + catchupAdminToken },
        body: JSON.stringify({ confirm: true, kind: job.kind, id: job.id }), signal: controller.signal
      });
      var payload = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) unlockCatchup('');
        throw new Error(typeof payload.error === 'string' ? payload.error : payload.error && payload.error.message || payload.message || 'HTTP ' + response.status);
      }
      setText('catchup-action-status', 'Request accepted. Media, saved descriptions, and scheduling rules still apply.');
      await refreshSnapshot();
    } catch (error) {
      setText('catchup-action-status', controller.signal.aborted ? 'The action timed out. Refresh the job status before trying again; it may have been accepted.' : 'Action not completed: ' + error.message);
    } finally {
      window.clearTimeout(timeout);
      catchupActionPending = false;
      renderCatchupPage();
    }
  }

  function updateLiveClocks() {
    renderCatchupConfirmation();
    if (activeClock) {
      var elapsed = activeClock.seconds + ((performance.now() - activeClock.at) / 1000);
      setText('active-running', formatDuration(elapsed));
    }
    if (maintenanceClock) {
      var remaining = maintenanceClock.resumeAt == null
        ? maintenanceClock.seconds - ((performance.now() - maintenanceClock.at) / 1000)
        : (maintenanceClock.resumeAt - Date.now()) / 1000;
      setText('maintenance-countdown', remaining > 0 ? formatDuration(remaining) : 'Resuming…');
    }
    if (snapshot) {
      var generatedAt = new Date(snapshot.generated_at).getTime();
      if (Number.isFinite(generatedAt)) {
        setText('snapshot-age', formatDuration(Math.max(0, (Date.now() - generatedAt) / 1000)) + ' ago');
      }
    }
  }

  async function refreshSnapshot() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async function () {
      var controller = new AbortController();
      var timeout = window.setTimeout(function () { controller.abort(); }, 10000);
      try {
        var response = await fetch(STATUS_URL, {
          method: 'GET',
          headers: requestHeaders(),
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal
        });
        if (response.status === 401) {
          showAuth(getToken() ? 'That token was rejected. Enter a valid observability token.' : 'A token is required to open this dashboard.');
          return false;
        }
        if (!response.ok) throw new Error('Status request failed with HTTP ' + response.status);
        var data = await response.json();
        hideAuth();
        showError('');
        render(data);
        await refreshCatchupPage();
        setConnection('live', 'Polling every 2s');
        return true;
      } catch (error) {
        showError(controller.signal.aborted ? 'Status request timed out. Retrying automatically.'
          : 'Unable to read intermediary status: ' + (error.message || String(error)));
        setConnection('offline', 'Disconnected');
        return false;
      } finally {
        window.clearTimeout(timeout);
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  async function performMaintenanceAction(action) {
    var token = getMaintenanceToken();
    if (!token) {
      setMaintenanceActionStatus('Enter the separate maintenance control token first.', 'error');
      byId('maintenance-token-input').focus();
      return;
    }
    var maintenance = snapshot && snapshot.maintenance ? snapshot.maintenance : {};
    if (maintenance.control_available !== true) {
      setMaintenanceActionStatus('Maintenance controls are not configured on this intermediary.', 'error');
      return;
    }

    maintenanceActionPending = true;
    syncMaintenanceControls();
    setMaintenanceActionStatus(action === 'pause' ? 'Requesting pause mode…' : 'Requesting inference resume…', '');
    try {
      var url = action === 'pause' ? MAINTENANCE_PAUSE_URL : MAINTENANCE_RESUME_URL;
      var options = {
        method: 'POST',
        headers: maintenanceHeaders(),
        cache: 'no-store',
        credentials: 'same-origin'
      };
      if (action === 'pause') {
        var payload = { reason: 'Dashboard pause' };
        var duration = byId('pause-duration').value;
        if (duration) payload.duration = duration;
        options.body = JSON.stringify(payload);
      }
      var response = await fetch(url, options);
      var responseText = await response.text();
      var responseBody = {};
      if (responseText) {
        try { responseBody = JSON.parse(responseText); }
        catch (_) { responseBody = {}; }
      }
      if (response.status === 401 || response.status === 403) {
        setMaintenanceToken('');
        throw new Error('The maintenance control token was rejected. Enter it again.');
      }
      if (!response.ok) {
        throw new Error(responseBody.error || ('Maintenance request failed with HTTP ' + response.status));
      }
      setMaintenanceActionStatus(action === 'pause'
        ? 'Pause mode requested. The dashboard will update as the active request drains.'
        : 'Inference resume requested.', 'success');
      await refreshSnapshot();
    } catch (error) {
      setMaintenanceActionStatus(error.message || String(error), 'error');
    } finally {
      maintenanceActionPending = false;
      syncMaintenanceControls();
    }
  }

  function startPolling() {
    if (pollTimer || authBlocked) return;
    pollTimer = window.setInterval(refreshSnapshot, POLL_INTERVAL_MS);
  }
  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
  }
  function stopConnections() {
    stopPolling();
  }

  async function reconnect() {
    stopConnections();
    authBlocked = false;
    setConnection('', 'Connecting');
    var ready = await refreshSnapshot();
    if (ready) startPolling();
    else if (!authBlocked) startPolling();
  }

  byId('token-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var value = byId('token-input').value.trim();
    if (!value) return;
    setToken(value);
    byId('token-input').value = '';
    reconnect();
  });

  byId('forget-token').addEventListener('click', function () {
    setToken('');
    reconnect();
  });

  byId('maintenance-token-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var value = byId('maintenance-token-input').value.trim();
    if (!value) return;
    setMaintenanceToken(value);
    byId('maintenance-token-input').value = '';
    setMaintenanceActionStatus('Maintenance control token saved for this browser tab.', 'success');
  });

  byId('forget-maintenance-token').addEventListener('click', function () {
    setMaintenanceToken('');
    byId('maintenance-token-input').value = '';
    setMaintenanceActionStatus('Maintenance control token forgotten.', '');
  });

  byId('pause-button').addEventListener('click', function () { performMaintenanceAction('pause'); });
  byId('catchup-previous').addEventListener('click', function () { changeCatchupPage(-1); });
  byId('catchup-next').addEventListener('click', function () { changeCatchupPage(1); });
  Object.keys(CATCHUP_VIEWS).forEach(function (view) {
    byId('catchup-view-' + view).addEventListener('click', function () { changeCatchupView(view); });
  });
  byId('catchup-token-form').addEventListener('submit', function (event) {
    event.preventDefault();
    unlockCatchup(byId('catchup-token-input').value);
    byId('catchup-token-input').value = '';
  });
  byId('catchup-use-saved-token').addEventListener('click', function () { unlockCatchup(savedCatchupToken()); });
  byId('catchup-lock').addEventListener('click', function () { unlockCatchup(''); });
  byId('resume-button').addEventListener('click', function () { performMaintenanceAction('resume'); });

  window.addEventListener('pagehide', stopConnections);
  window.addEventListener('pageshow', function (event) { if (event.persisted) reconnect(); });
  window.setInterval(updateLiveClocks, 1000);
  setToken(getToken());
  setMaintenanceToken(getMaintenanceToken());
  reconnect();
})();
