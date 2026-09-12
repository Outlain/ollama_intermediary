export const SETTINGS_DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#090e16">
  <title>Settings · Ollama Intermediary</title>
  <link rel="stylesheet" href="/_intermediary/ui/settings.css">
  <script defer src="/_intermediary/ui/settings.js"></script>
</head>
<body>
  <header class="site-header">
    <div class="shell header-inner">
      <a class="brand" href="/debug" aria-label="Return to operations dashboard">
        <span class="brand-mark" aria-hidden="true">OI</span>
        <span>
          <span class="eyebrow">Administration</span>
          <strong>Intermediary settings</strong>
        </span>
      </a>
      <div class="header-actions">
        <span id="document-state" class="status-pill status-neutral" role="status" aria-live="polite">Not loaded</span>
        <a class="quiet-button" href="/debug">Dashboard</a>
        <button id="forget-token" class="quiet-button" type="button" hidden>Forget admin token</button>
      </div>
    </div>
  </header>

  <main class="shell">
    <div id="page-error" class="notice notice-error" role="alert" hidden></div>

    <section id="auth-panel" class="auth-panel" aria-labelledby="auth-heading">
      <div>
        <p class="eyebrow">Protected configuration</p>
        <h1 id="auth-heading">Enter the settings admin token</h1>
        <p id="auth-message" class="muted">This token permits configuration changes. It is kept only in this browser tab.</p>
      </div>
      <form id="auth-form" class="auth-form">
        <label for="admin-token">Admin token</label>
        <div class="input-action-row">
          <input id="admin-token" type="password" autocomplete="off" spellcheck="false" required>
          <button type="submit">Open settings</button>
        </div>
        <p class="field-help">The token is stored in sessionStorage, never localStorage, and is cleared when this tab session ends.</p>
      </form>
    </section>

    <div id="settings-workspace" hidden>
      <section id="configuration-banner" class="configuration-banner state-neutral" aria-labelledby="configuration-title">
        <span class="state-orb" aria-hidden="true"></span>
        <div class="configuration-copy">
          <p class="eyebrow">Configuration health</p>
          <h1 id="configuration-title">Loading current settings…</h1>
          <p id="configuration-detail">Waiting for the intermediary to report its effective configuration.</p>
        </div>
        <dl class="banner-facts">
          <div><dt>Revision</dt><dd id="configuration-revision">—</dd></div>
          <div><dt>Last applied</dt><dd id="configuration-applied-at">—</dd></div>
        </dl>
      </section>

      <div id="restart-banner" class="notice notice-warning" role="status" aria-live="polite" hidden>
        <strong id="restart-title">Restart required</strong>
        <span id="restart-detail">The saved values will become active after the intermediary is restarted.</span>
      </div>

      <div class="notice notice-info" role="note">
        <strong>Application settings only</strong>
        <span>This page stores validated, versioned overrides in the intermediary's state volume. Your config.yml and Docker Compose files remain untouched; raw YAML, the Docker socket, and host files are never exposed. Infrastructure findings below are read-only.</span>
      </div>

      <form id="settings-form" novalidate>
        <div id="validation-summary" class="notice notice-error" role="alert" tabindex="-1" hidden></div>

        <nav class="section-nav" aria-label="Settings sections">
          <a href="#backend">Backend</a>
          <a href="#frigate-source">Frigate source</a>
          <a href="#scheduler">Scheduler</a>
          <a href="#odysseus">Odysseus</a>
          <a href="#frigate">Frigate</a>
          <a href="#gpu-safety">GPU safety</a>
          <a href="#access">Access</a>
          <a href="#infrastructure">Diagnostics</a>
        </nav>

        <section id="backend" class="settings-card" aria-labelledby="backend-heading">
          <div class="card-heading">
            <div><p class="eyebrow">Upstream service</p><h2 id="backend-heading">Ollama backend</h2></div>
            <span id="backend-connectivity" class="status-pill status-neutral">Checked after restart</span>
          </div>
          <div class="field-grid field-grid-2">
            <div class="field field-wide" data-field-wrap="ollama.url">
              <label for="ollama-url">Ollama URL <span aria-hidden="true">*</span></label>
              <input id="ollama-url" data-path="ollama.url" type="url" inputmode="url" spellcheck="false" placeholder="http://192.168.1.10:11434" required>
              <p class="field-help">Use the host's LAN address when Ollama runs under systemd and this intermediary runs in Docker. Never point this URL back at the intermediary.</p>
              <p class="field-error" data-error-for="ollama.url"></p>
            </div>
            <div class="field" data-field-wrap="ollama.health_interval">
              <label for="health-interval">Health interval</label>
              <input id="health-interval" data-path="ollama.health_interval" type="text" inputmode="text" placeholder="5s">
              <p class="field-error" data-error-for="ollama.health_interval"></p>
            </div>
            <div class="field" data-field-wrap="ollama.health_timeout">
              <label for="health-timeout">Health timeout</label>
              <input id="health-timeout" data-path="ollama.health_timeout" type="text" placeholder="3s">
              <p class="field-error" data-error-for="ollama.health_timeout"></p>
            </div>
            <div class="field" data-field-wrap="ollama.request_timeout">
              <label for="request-timeout">Inference request timeout</label>
              <input id="request-timeout" data-path="ollama.request_timeout" type="text" placeholder="30m">
              <p class="field-help">This clock starts after a request leaves the queue.</p>
              <p class="field-error" data-error-for="ollama.request_timeout"></p>
            </div>
            <div class="test-panel">
              <strong>Backend validation</strong>
              <p id="backend-connectivity-detail">Validation checks URL structure and cross-field safety without making a network request. Ollama reachability is checked after a saved configuration restarts.</p>
              <button id="test-backend" class="secondary-button" type="button">Validate backend settings</button>
            </div>
          </div>
        </section>

        <section id="frigate-source" class="settings-card" aria-labelledby="frigate-source-heading">
          <div class="card-heading">
            <div><p class="eyebrow">Client identification</p><h2 id="frigate-source-heading">Frigate source</h2></div>
          </div>
          <div class="field-grid field-grid-2">
            <div class="field field-wide" data-field-wrap="clients.frigate.source_ips.0">
              <label for="frigate-source-cidr">Frigate IP address or CIDR</label>
              <input id="frigate-source-cidr" data-path="clients.frigate.source_ips.0" type="text" inputmode="decimal" spellcheck="false" placeholder="192.168.1.25/32">
              <p class="field-help">Use the address that reaches the intermediary. A single host can be written as an IP or as a /32 CIDR. Leave this empty only if every Frigate request sends <code>X-Ollama-Client: frigate</code>.</p>
              <p class="field-error" data-error-for="clients.frigate.source_ips.0"></p>
            </div>
            <div class="readout">
              <span>Fallback client</span>
              <strong id="fallback-client-readout">Odysseus</strong>
              <small>Requests without a Frigate source match use this client policy.</small>
            </div>
          </div>
        </section>

        <section id="scheduler" class="settings-card" aria-labelledby="scheduler-heading">
          <div class="card-heading">
            <div><p class="eyebrow">General behavior</p><h2 id="scheduler-heading">Server &amp; scheduler</h2></div>
          </div>
          <div class="field-grid field-grid-3">
            <div class="field" data-field-wrap="server.body_limit_bytes">
              <label for="body-limit">Request body limit (bytes)</label>
              <input id="body-limit" data-path="server.body_limit_bytes" type="number" min="1" step="1">
              <p class="field-error" data-error-for="server.body_limit_bytes"></p>
            </div>
            <div class="field" data-field-wrap="server.shutdown_grace">
              <label for="shutdown-grace">Shutdown grace</label>
              <input id="shutdown-grace" data-path="server.shutdown_grace" type="text" placeholder="2m">
              <p class="field-error" data-error-for="server.shutdown_grace"></p>
            </div>
            <div class="field" data-field-wrap="scheduler.default_client">
              <label for="default-client">Fallback client</label>
              <select id="default-client" data-path="scheduler.default_client">
                <option value="odysseus">Odysseus</option>
                <option value="default">Default</option>
                <option value="frigate">Frigate</option>
              </select>
              <p class="field-error" data-error-for="scheduler.default_client"></p>
            </div>
            <label class="check-field" data-field-wrap="scheduler.priority_aging">
              <input data-path="scheduler.priority_aging" type="checkbox">
              <span><strong>Priority aging</strong><small>Gradually raise waiting work so it cannot starve indefinitely.</small></span>
              <span class="field-error" data-error-for="scheduler.priority_aging"></span>
            </label>
            <div class="field" data-field-wrap="scheduler.aging_interval">
              <label for="aging-interval">Aging interval</label>
              <input id="aging-interval" data-path="scheduler.aging_interval" type="text" placeholder="10s">
              <p class="field-error" data-error-for="scheduler.aging_interval"></p>
            </div>
            <div class="field" data-field-wrap="scheduler.aging_bonus">
              <label for="aging-bonus">Aging bonus</label>
              <input id="aging-bonus" data-path="scheduler.aging_bonus" type="number" step="any">
              <p class="field-error" data-error-for="scheduler.aging_bonus"></p>
            </div>
            <div class="field" data-field-wrap="circuit_breaker.failure_threshold">
              <label for="failure-threshold">Circuit failure threshold</label>
              <input id="failure-threshold" data-path="circuit_breaker.failure_threshold" type="number" min="1" step="1">
              <p class="field-error" data-error-for="circuit_breaker.failure_threshold"></p>
            </div>
            <div class="field" data-field-wrap="circuit_breaker.failure_window">
              <label for="failure-window">Failure window</label>
              <input id="failure-window" data-path="circuit_breaker.failure_window" type="text" placeholder="60s">
              <p class="field-error" data-error-for="circuit_breaker.failure_window"></p>
            </div>
            <div class="field" data-field-wrap="circuit_breaker.open_duration">
              <label for="open-duration">Circuit open duration</label>
              <input id="open-duration" data-path="circuit_breaker.open_duration" type="text" placeholder="30s">
              <p class="field-error" data-error-for="circuit_breaker.open_duration"></p>
            </div>
          </div>
        </section>

        <section id="odysseus" class="settings-card client-card client-odysseus" aria-labelledby="odysseus-heading">
          <div class="card-heading">
            <div><p class="eyebrow">Interactive workload</p><h2 id="odysseus-heading">Odysseus</h2></div>
            <span class="client-chip">Higher priority</span>
          </div>
          <div class="field-grid field-grid-4">
            <div class="field" data-field-wrap="clients.odysseus.priority"><label>Priority<input data-path="clients.odysseus.priority" type="number" step="any"></label><p class="field-error" data-error-for="clients.odysseus.priority"></p></div>
            <div class="field" data-field-wrap="clients.odysseus.queue_limit"><label>Queue limit<input data-path="clients.odysseus.queue_limit" type="number" min="1" step="1"></label><p class="field-error" data-error-for="clients.odysseus.queue_limit"></p></div>
            <div class="field" data-field-wrap="clients.odysseus.request_ttl"><label>Request TTL<input data-path="clients.odysseus.request_ttl" type="text" placeholder="30m"></label><p class="field-error" data-error-for="clients.odysseus.request_ttl"></p></div>
            <div class="field" data-field-wrap="clients.odysseus.max_wait"><label>Forced switch wait<input data-path="clients.odysseus.max_wait" type="text" placeholder="0s"></label><p class="field-error" data-error-for="clients.odysseus.max_wait"></p></div>
            <div class="field" data-field-wrap="clients.odysseus.model_policy.idle_hold"><label>Idle hold<input data-path="clients.odysseus.model_policy.idle_hold" type="text" placeholder="1m"></label><p class="field-error" data-error-for="clients.odysseus.model_policy.idle_hold"></p></div>
            <div class="field" data-field-wrap="clients.odysseus.model_policy.max_batch_requests"><label>Maximum batch requests<input data-path="clients.odysseus.model_policy.max_batch_requests" type="number" min="1" step="1"></label><p class="field-error" data-error-for="clients.odysseus.model_policy.max_batch_requests"></p></div>
            <div class="field" data-field-wrap="clients.odysseus.model_policy.max_batch_time"><label>Maximum batch time<input data-path="clients.odysseus.model_policy.max_batch_time" type="text" placeholder="90s"></label><p class="field-error" data-error-for="clients.odysseus.model_policy.max_batch_time"></p></div>
            <div class="field" data-field-wrap="clients.odysseus.model_policy.keep_alive"><label>Ollama keep-alive<input data-path="clients.odysseus.model_policy.keep_alive" data-nullable="true" type="text" placeholder="60s"></label><p class="field-error" data-error-for="clients.odysseus.model_policy.keep_alive"></p></div>
          </div>
        </section>

        <section id="frigate" class="settings-card client-card client-frigate" aria-labelledby="frigate-heading">
          <div class="card-heading">
            <div><p class="eyebrow">Background workload</p><h2 id="frigate-heading">Frigate</h2></div>
            <span class="client-chip">Newest-first capable</span>
          </div>
          <div class="field-grid field-grid-4">
            <div class="field" data-field-wrap="clients.frigate.priority"><label>Priority<input data-path="clients.frigate.priority" type="number" step="any"></label><p class="field-error" data-error-for="clients.frigate.priority"></p></div>
            <div class="field" data-field-wrap="clients.frigate.queue_limit"><label>Queue limit<input data-path="clients.frigate.queue_limit" type="number" min="1" step="1"></label><p class="field-error" data-error-for="clients.frigate.queue_limit"></p></div>
            <div class="field" data-field-wrap="clients.frigate.request_ttl"><label>Request TTL<input data-path="clients.frigate.request_ttl" type="text" placeholder="2m"></label><p class="field-error" data-error-for="clients.frigate.request_ttl"></p></div>
            <div class="field" data-field-wrap="clients.frigate.max_wait"><label>Forced switch wait<input data-path="clients.frigate.max_wait" type="text" placeholder="2m"></label><p class="field-error" data-error-for="clients.frigate.max_wait"></p></div>
            <div class="field" data-field-wrap="clients.frigate.overflow_policy"><label>Queue overflow<select data-path="clients.frigate.overflow_policy"><option value="drop_oldest">Drop oldest</option><option value="drop_newest">Drop newest</option><option value="reject">Reject new</option></select></label><p class="field-error" data-error-for="clients.frigate.overflow_policy"></p></div>
            <div class="field" data-field-wrap="clients.frigate.model_policy.idle_hold"><label>Idle hold<input data-path="clients.frigate.model_policy.idle_hold" type="text" placeholder="3s"></label><p class="field-error" data-error-for="clients.frigate.model_policy.idle_hold"></p></div>
            <div class="field" data-field-wrap="clients.frigate.model_policy.max_batch_requests"><label>Maximum batch requests<input data-path="clients.frigate.model_policy.max_batch_requests" type="number" min="1" step="1"></label><p class="field-error" data-error-for="clients.frigate.model_policy.max_batch_requests"></p></div>
            <div class="field" data-field-wrap="clients.frigate.model_policy.max_batch_time"><label>Maximum batch time<input data-path="clients.frigate.model_policy.max_batch_time" type="text" placeholder="60s"></label><p class="field-error" data-error-for="clients.frigate.model_policy.max_batch_time"></p></div>
            <div class="field" data-field-wrap="clients.frigate.model_policy.keep_alive"><label>Ollama keep-alive<input data-path="clients.frigate.model_policy.keep_alive" data-nullable="true" type="text" placeholder="15s"></label><p class="field-error" data-error-for="clients.frigate.model_policy.keep_alive"></p></div>
            <label class="check-field" data-field-wrap="clients.frigate.deduplication.enabled"><input data-path="clients.frigate.deduplication.enabled" type="checkbox"><span><strong>Deduplicate events</strong><small>Enable only when stable event identifiers are configured.</small></span><span class="field-error" data-error-for="clients.frigate.deduplication.enabled"></span></label>
          </div>
        </section>

        <section id="gpu-safety" class="settings-card" aria-labelledby="gpu-heading">
          <div class="card-heading">
            <div><p class="eyebrow">ROCm protection</p><h2 id="gpu-heading">GPU safety</h2></div>
            <span class="safety-lock">Safety-critical</span>
          </div>
          <div class="notice notice-warning compact-notice" role="note">
            <strong>Change cautiously</strong><span>These controls exist to avoid aborted model loads, stranded VRAM, and overlapping model-state mutations.</span>
          </div>
          <div class="field-grid field-grid-2 checks-grid">
            <label class="check-field" data-field-wrap="gpu_safety.drain_active_disconnects"><input data-path="gpu_safety.drain_active_disconnects" type="checkbox"><span><strong>Drain disconnected requests</strong><small>Finish reading Ollama after a caller disconnects.</small></span><span class="field-error" data-error-for="gpu_safety.drain_active_disconnects"></span></label>
            <label class="check-field" data-field-wrap="gpu_safety.unload_on_model_switch"><input data-path="gpu_safety.unload_on_model_switch" type="checkbox"><span><strong>Unload before model switch</strong><small>Release the prior model before loading another.</small></span><span class="field-error" data-error-for="gpu_safety.unload_on_model_switch"></span></label>
            <label class="check-field" data-field-wrap="gpu_safety.recovery_on_oom"><input data-path="gpu_safety.recovery_on_oom" type="checkbox"><span><strong>Latch recovery after OOM</strong><small>Stop dispatching into a potentially poisoned GPU state.</small></span><span class="field-error" data-error-for="gpu_safety.recovery_on_oom"></span></label>
            <div class="field" data-field-wrap="gpu_safety.unload_timeout"><label>Unload timeout<input data-path="gpu_safety.unload_timeout" type="text" placeholder="30s"></label><p class="field-error" data-error-for="gpu_safety.unload_timeout"></p></div>
            <div class="field" data-field-wrap="gpu_safety.error_body_limit_bytes"><label>Error inspection limit (bytes)<input data-path="gpu_safety.error_body_limit_bytes" type="number" min="1" step="1"></label><p class="field-error" data-error-for="gpu_safety.error_body_limit_bytes"></p></div>
          </div>
        </section>

        <section id="access" class="settings-card" aria-labelledby="access-heading">
          <div class="card-heading">
            <div><p class="eyebrow">Authentication &amp; visibility</p><h2 id="access-heading">Maintenance, observability &amp; secrets</h2></div>
          </div>
          <div class="field-grid field-grid-3">
            <label class="check-field" data-field-wrap="maintenance.enabled"><input data-path="maintenance.enabled" type="checkbox"><span><strong>Maintenance controls</strong><small>Allow authenticated pause and resume actions.</small></span><span class="field-error" data-error-for="maintenance.enabled"></span></label>
            <label class="check-field" data-field-wrap="observability.enabled"><input data-path="observability.enabled" type="checkbox"><span><strong>Observability API</strong><small>Expose protected operational metadata.</small></span><span class="field-error" data-error-for="observability.enabled"></span></label>
            <label class="check-field" data-field-wrap="observability.ui_enabled"><input data-path="observability.ui_enabled" type="checkbox"><span><strong>Operations dashboard</strong><small>Serve the read-only <code>/debug</code> dashboard. The protected settings recovery page remains available.</small></span><span class="field-error" data-error-for="observability.ui_enabled"></span></label>
            <div class="field" data-field-wrap="maintenance.max_pause"><label>Maximum timed pause<input data-path="maintenance.max_pause" type="text" placeholder="168h"></label><p class="field-error" data-error-for="maintenance.max_pause"></p></div>
            <div class="field" data-field-wrap="observability.history_limit"><label>Event history limit<input data-path="observability.history_limit" type="number" min="1" max="1000" step="1"></label><p class="field-error" data-error-for="observability.history_limit"></p></div>
            <div class="field" data-field-wrap="observability.queue_items_limit"><label>Visible queue item limit<input data-path="observability.queue_items_limit" type="number" min="1" max="500" step="1"></label><p class="field-error" data-error-for="observability.queue_items_limit"></p></div>
          </div>

          <div class="secrets-heading">
            <h3>Host-managed tokens</h3>
            <p>Token values are never returned to this page and cannot be changed from the browser. Edit <code>secrets.env</code> on the host, then recreate the intermediary container.</p>
          </div>
          <div class="field-grid field-grid-3 secret-grid">
            <div class="secret-field">
              <div class="secret-label"><strong>Maintenance token</strong><span id="maintenance-secret-state" class="configured-badge">Unknown</span></div>
              <div class="secret-readout"><span>Value hidden</span><code>MAINTENANCE_TOKEN</code></div>
            </div>
            <div class="secret-field">
              <div class="secret-label"><strong>Observability token</strong><span id="observability-secret-state" class="configured-badge">Unknown</span></div>
              <div class="secret-readout"><span>Value hidden</span><code>OBSERVABILITY_TOKEN</code></div>
            </div>
            <div class="secret-field">
              <div class="secret-label"><strong>Settings admin token</strong><span id="admin-secret-state" class="configured-badge">Unknown</span></div>
              <div class="secret-readout"><span>Value hidden</span><code>SETTINGS_TOKEN</code></div>
            </div>
          </div>
        </section>

        <section id="infrastructure" class="settings-card" aria-labelledby="infrastructure-heading">
          <div class="card-heading">
            <div><p class="eyebrow">Read-only host checks</p><h2 id="infrastructure-heading">Infrastructure diagnostics</h2></div>
            <span id="diagnostics-summary" class="status-pill status-neutral">Waiting</span>
          </div>
          <p class="section-intro">This lists configuration and storage checks the intermediary can verify itself. Check host-only ports and volume mounts with <code>docker compose config</code>; this page will never alter Docker Compose or control Docker.</p>
          <ul id="diagnostics-list" class="diagnostics-list"></ul>
          <p id="diagnostics-empty" class="empty-state">No infrastructure diagnostics were reported.</p>
          <div class="saved-settings-controls">
            <div>
              <strong>Saved override recovery</strong>
              <p>Rollback restores the preceding saved revision. Reset removes all browser-saved overrides and returns to the read-only <code>config.yml</code> values. Neither action edits config.yml, Compose, or secrets.</p>
            </div>
            <div class="saved-settings-buttons">
              <button id="rollback-button" class="secondary-button" type="button" disabled>Roll back one revision</button>
              <button id="reset-button" class="danger-button" type="button" disabled>Reset saved overrides</button>
            </div>
          </div>
        </section>

        <div class="action-bar" aria-label="Configuration actions">
          <div>
            <strong id="action-title">No unapplied changes</strong>
            <span id="action-detail">Edit a field to create a draft.</span>
          </div>
          <div class="action-buttons">
            <button id="discard-button" class="quiet-button" type="button" disabled>Discard draft</button>
            <button id="validate-button" class="secondary-button" type="button">Validate changes</button>
            <button id="apply-button" class="primary-button" type="submit" disabled>Apply settings</button>
          </div>
        </div>
      </form>
    </div>
  </main>

  <noscript><div class="noscript-message">JavaScript is required to use the structured settings editor.</div></noscript>
</body>
</html>`;

export const SETTINGS_DASHBOARD_CSS = String.raw`:root {
  color-scheme: dark;
  --bg: #080c13;
  --surface: #101722;
  --raised: #151e2b;
  --soft: #0d141e;
  --border: #263345;
  --border-soft: #1c2838;
  --text: #eef4fb;
  --muted: #94a3b8;
  --faint: #67768c;
  --green: #65dca6;
  --green-strong: #24c984;
  --green-soft: rgba(63, 219, 151, 0.12);
  --blue: #6eaaff;
  --blue-soft: rgba(93, 163, 255, 0.13);
  --purple: #b69cff;
  --purple-soft: rgba(180, 156, 255, 0.13);
  --amber: #f3bd67;
  --amber-soft: rgba(243, 189, 103, 0.13);
  --red: #ff747e;
  --red-soft: rgba(255, 99, 111, 0.12);
  --radius: 18px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }
html { min-width: 320px; scroll-behavior: smooth; background: var(--bg); }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--text);
  background:
    radial-gradient(circle at 8% -5%, rgba(45, 173, 123, 0.12), transparent 30rem),
    radial-gradient(circle at 94% 2%, rgba(79, 133, 213, 0.09), transparent 28rem),
    var(--bg);
}
button, input, select { font: inherit; }
button, select { cursor: pointer; }
button:disabled, input:disabled, select:disabled { cursor: not-allowed; opacity: 0.55; }
[hidden] { display: none !important; }
.shell { width: min(1180px, calc(100% - 40px)); margin-inline: auto; }
.site-header { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid rgba(38, 51, 69, 0.75); background: rgba(8, 12, 19, 0.88); backdrop-filter: blur(18px); }
.header-inner { min-height: 74px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; color: var(--text); text-decoration: none; }
.brand-mark { display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 auto; border: 1px solid rgba(101, 220, 166, 0.38); border-radius: 12px; color: var(--green); background: var(--green-soft); font-size: 0.74rem; font-weight: 800; letter-spacing: 0.08em; }
.brand strong { display: block; font-size: 1.04rem; }
.eyebrow { display: block; margin: 0 0 4px; color: var(--muted); font-size: 0.66rem; font-weight: 750; letter-spacing: 0.115em; text-transform: uppercase; }
.header-actions { display: flex; align-items: center; justify-content: flex-end; gap: 9px; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: clamp(1.12rem, 2.5vw, 1.42rem); letter-spacing: -0.025em; }
h2 { margin-bottom: 0; font-size: 1.08rem; letter-spacing: -0.018em; }
h3 { margin-bottom: 0; font-size: 0.94rem; }
.muted { color: var(--muted); }
main { padding-block: 28px 112px; }

.quiet-button, .secondary-button, .primary-button, .danger-button, .auth-form button {
  min-height: 39px;
  padding: 8px 13px;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  background: transparent;
  font-weight: 700;
  text-decoration: none;
}
.quiet-button { color: var(--muted); font-size: 0.76rem; }
.quiet-button:hover, .secondary-button:hover { border-color: var(--faint); color: var(--text); background: rgba(255,255,255,0.025); }
.secondary-button { color: #dbe8f8; background: var(--soft); }
.primary-button, .auth-form button { border-color: rgba(101, 220, 166, 0.5); color: #062116; background: var(--green); }
.primary-button:hover, .auth-form button:hover { background: #7be8b7; }
.danger-button { color: var(--red); border-color: rgba(255, 116, 126, 0.45); background: var(--red-soft); }
.danger-button:hover { border-color: var(--red); background: rgba(255, 99, 111, 0.2); }

.status-pill, .client-chip, .safety-lock, .configured-badge { display: inline-flex; align-items: center; width: fit-content; border: 1px solid var(--border); border-radius: 999px; white-space: nowrap; }
.status-pill { padding: 6px 10px; color: var(--muted); background: var(--surface); font-size: 0.72rem; font-weight: 750; }
.status-good { color: var(--green); border-color: rgba(101,220,166,0.3); background: var(--green-soft); }
.status-warning { color: var(--amber); border-color: rgba(243,189,103,0.32); background: var(--amber-soft); }
.status-error { color: var(--red); border-color: rgba(255,116,126,0.35); background: var(--red-soft); }
.status-neutral { color: var(--muted); }

.auth-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(330px, 0.85fr); gap: 32px; align-items: center; padding: 28px; border: 1px solid var(--border); border-radius: var(--radius); background: linear-gradient(135deg, var(--raised), var(--surface)); box-shadow: 0 20px 60px rgba(0,0,0,0.25); }
.auth-panel p:last-child { margin: 8px 0 0; font-size: 0.87rem; }
.auth-form label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 0.75rem; font-weight: 700; }
.input-action-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }

.configuration-banner { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 17px; min-height: 112px; margin-bottom: 16px; padding: 22px 24px; border: 1px solid var(--border); border-radius: var(--radius); background: linear-gradient(115deg, var(--raised), var(--surface)); box-shadow: 0 16px 45px rgba(0,0,0,0.18); }
.state-orb { width: 17px; height: 17px; border: 4px solid rgba(255,255,255,0.08); border-radius: 50%; background: var(--muted); }
.configuration-copy h1 { margin-bottom: 5px; }
.configuration-copy p:last-child { margin-bottom: 0; color: var(--muted); font-size: 0.84rem; }
.banner-facts { display: flex; gap: 28px; margin: 0; }
.banner-facts div { min-width: 86px; }
.banner-facts dt { margin-bottom: 4px; color: var(--muted); font-size: 0.66rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.banner-facts dd { margin: 0; font-size: 0.84rem; font-weight: 750; }
.state-good { border-color: rgba(101,220,166,0.28); background: linear-gradient(115deg, var(--green-soft), var(--surface) 50%); }
.state-good .state-orb { background: var(--green); box-shadow: 0 0 22px rgba(101,220,166,0.46); }
.state-warning { border-color: rgba(243,189,103,0.3); background: linear-gradient(115deg, var(--amber-soft), var(--surface) 50%); }
.state-warning .state-orb { background: var(--amber); box-shadow: 0 0 22px rgba(243,189,103,0.42); }
.state-error { border-color: rgba(255,116,126,0.34); background: linear-gradient(115deg, var(--red-soft), var(--surface) 50%); }
.state-error .state-orb { background: var(--red); box-shadow: 0 0 22px rgba(255,116,126,0.42); }

.notice { display: flex; gap: 10px; margin-bottom: 16px; padding: 13px 15px; border: 1px solid var(--border); border-radius: 12px; color: var(--muted); background: var(--soft); font-size: 0.82rem; line-height: 1.45; }
.notice strong { flex: 0 0 auto; color: var(--text); }
.notice-error { color: #ffd1d5; border-color: rgba(255,116,126,0.38); background: var(--red-soft); }
.notice-error strong { color: var(--red); }
.notice-warning { color: #f6ddb5; border-color: rgba(243,189,103,0.34); background: var(--amber-soft); }
.notice-warning strong { color: var(--amber); }
.notice-info { color: #c9dcf8; border-color: rgba(110,170,255,0.28); background: var(--blue-soft); }
.notice-info strong { color: var(--blue); }
.compact-notice { margin: 16px 0; }

.section-nav { position: sticky; top: 84px; z-index: 10; display: flex; gap: 7px; margin: 18px 0; padding: 9px; overflow-x: auto; border: 1px solid var(--border-soft); border-radius: 13px; background: rgba(13,20,30,0.92); backdrop-filter: blur(16px); scrollbar-width: thin; }
.section-nav a { flex: 0 0 auto; padding: 7px 10px; border-radius: 8px; color: var(--muted); font-size: 0.73rem; font-weight: 700; text-decoration: none; }
.section-nav a:hover, .section-nav a:focus-visible { color: var(--text); background: var(--raised); }

.settings-card { scroll-margin-top: 145px; margin-bottom: 17px; padding: 22px; border: 1px solid var(--border-soft); border-radius: var(--radius); background: linear-gradient(150deg, rgba(21,30,43,0.98), rgba(14,21,31,0.98)); box-shadow: 0 12px 32px rgba(0,0,0,0.15); }
.card-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 20px; }
.client-chip, .safety-lock { padding: 5px 9px; font-size: 0.68rem; font-weight: 750; text-transform: uppercase; letter-spacing: 0.05em; }
.client-odysseus { border-top-color: rgba(182,156,255,0.38); }
.client-odysseus .client-chip { color: var(--purple); border-color: rgba(182,156,255,0.3); background: var(--purple-soft); }
.client-frigate { border-top-color: rgba(110,170,255,0.38); }
.client-frigate .client-chip { color: var(--blue); border-color: rgba(110,170,255,0.3); background: var(--blue-soft); }
.safety-lock { color: var(--amber); border-color: rgba(243,189,103,0.3); background: var(--amber-soft); }
.field-grid { display: grid; gap: 16px; }
.field-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.field-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.field-wide { grid-column: 1 / -1; }
.field { min-width: 0; }
.field > label, .field label:not(.check-field), .secret-label strong { display: grid; gap: 7px; color: #dce6f3; font-size: 0.75rem; font-weight: 700; }
input, select { width: 100%; min-height: 42px; padding: 9px 11px; border: 1px solid var(--border); border-radius: 9px; outline: none; color: var(--text); background: #0a111b; }
input::placeholder { color: #59687d; }
input:focus, select:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(110,170,255,0.12); }
.field-help { margin: 7px 0 0; color: var(--faint); font-size: 0.7rem; line-height: 1.4; }
.field-error { min-height: 0; margin: 6px 0 0; color: var(--red); font-size: 0.7rem; font-weight: 650; line-height: 1.35; }
.field-error:empty { display: none; }
[data-field-wrap].has-error input, [data-field-wrap].has-error select { border-color: var(--red); box-shadow: 0 0 0 3px var(--red-soft); }
.check-field.has-error { border-color: var(--red); }
.check-field { display: flex; gap: 11px; align-items: flex-start; min-width: 0; min-height: 86px; padding: 13px; border: 1px solid var(--border-soft); border-radius: 11px; background: var(--soft); cursor: pointer; }
.check-field input { width: 17px; min-height: 17px; height: 17px; margin: 2px 0 0; accent-color: var(--green-strong); }
.check-field span { display: grid; gap: 4px; }
.check-field strong { font-size: 0.76rem; }
.check-field small { color: var(--muted); font-size: 0.68rem; line-height: 1.4; }
.check-field .field-error { display: none; }
.check-field.has-error .field-error { display: block; }
.checks-grid { align-items: start; }
.test-panel, .readout { min-height: 112px; padding: 14px; border: 1px dashed var(--border); border-radius: 11px; background: rgba(13,20,30,0.68); }
.test-panel strong, .readout > span { display: block; color: var(--muted); font-size: 0.69rem; font-weight: 700; letter-spacing: 0.055em; text-transform: uppercase; }
.test-panel p { margin: 7px 0 12px; color: var(--muted); font-size: 0.74rem; line-height: 1.4; }
.readout strong { display: block; margin-top: 8px; font-size: 1.05rem; }
.readout small { display: block; margin-top: 6px; color: var(--muted); line-height: 1.4; }

.secrets-heading { margin: 24px 0 14px; padding-top: 20px; border-top: 1px solid var(--border-soft); }
.secrets-heading p { margin: 6px 0 0; color: var(--muted); font-size: 0.76rem; }
.secrets-heading code { color: #c9dcf8; }
.secret-field { min-width: 0; padding: 13px; border: 1px solid var(--border-soft); border-radius: 11px; background: var(--soft); }
.secret-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
.configured-badge { padding: 3px 7px; color: var(--muted); font-size: 0.62rem; font-weight: 750; }
.configured-badge.is-configured { color: var(--green); border-color: rgba(101,220,166,0.28); background: var(--green-soft); }
.configured-badge.is-missing { color: var(--red); border-color: rgba(255,116,126,0.3); background: var(--red-soft); }
.secret-readout { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 42px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 9px; color: var(--faint); background: #0a111b; font-size: 0.68rem; }
.secret-readout code { overflow: hidden; color: var(--muted); font-size: 0.66rem; text-overflow: ellipsis; }

.section-intro { margin: -8px 0 17px; color: var(--muted); font-size: 0.78rem; line-height: 1.5; }
.diagnostics-list { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
.saved-settings-controls { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border-soft); }
.saved-settings-controls p { margin: 5px 0 0; max-width: 52rem; color: var(--muted); font-size: 0.82rem; line-height: 1.55; }
.saved-settings-buttons { display: flex; flex: 0 0 auto; gap: 8px; }
.diagnostic { display: grid; grid-template-columns: auto minmax(0,1fr); gap: 11px; padding: 13px; border: 1px solid var(--border-soft); border-radius: 11px; background: var(--soft); }
.diagnostic-icon { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: var(--muted); background: rgba(148,163,184,0.1); font-size: 0.7rem; font-weight: 850; }
.diagnostic strong { display: block; margin-bottom: 3px; font-size: 0.78rem; }
.diagnostic p { margin: 0; color: var(--muted); font-size: 0.72rem; line-height: 1.42; }
.diagnostic small { display: block; margin-top: 5px; color: var(--faint); font-size: 0.67rem; }
.diagnostic-good .diagnostic-icon { color: var(--green); background: var(--green-soft); }
.diagnostic-warning { border-color: rgba(243,189,103,0.24); }
.diagnostic-warning .diagnostic-icon { color: var(--amber); background: var(--amber-soft); }
.diagnostic-error { border-color: rgba(255,116,126,0.3); }
.diagnostic-error .diagnostic-icon { color: var(--red); background: var(--red-soft); }
.empty-state { margin: 0; padding: 18px; border: 1px dashed var(--border); border-radius: 11px; color: var(--muted); text-align: center; font-size: 0.76rem; }

.action-bar { position: sticky; bottom: 14px; z-index: 15; display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 20px; padding: 14px 16px; border: 1px solid rgba(38,51,69,0.9); border-radius: 14px; background: rgba(16,23,34,0.94); box-shadow: 0 16px 50px rgba(0,0,0,0.4); backdrop-filter: blur(18px); }
.action-bar > div:first-child { display: grid; gap: 3px; min-width: 0; }
.action-bar strong { font-size: 0.78rem; }
.action-bar span { color: var(--muted); font-size: 0.7rem; }
.action-buttons { display: flex; gap: 8px; flex: 0 0 auto; }
.noscript-message { margin: 20px; padding: 18px; color: white; background: #8a2330; }

@media (max-width: 900px) {
  .field-grid-4 { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .field-grid-3 { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .secret-grid .secret-field:last-child { grid-column: 1 / -1; }
}
@media (max-width: 680px) {
  .shell { width: min(100% - 24px, 1180px); }
  .site-header { position: static; }
  .header-inner { min-height: 68px; }
  .header-actions .status-pill { display: none; }
  .header-actions .quiet-button { padding-inline: 9px; }
  main { padding-top: 16px; padding-bottom: 145px; }
  .auth-panel { grid-template-columns: 1fr; gap: 20px; padding: 20px; }
  .input-action-row { grid-template-columns: 1fr; }
  .configuration-banner { grid-template-columns: auto minmax(0,1fr); padding: 18px; }
  .banner-facts { grid-column: 1 / -1; width: 100%; padding-top: 12px; border-top: 1px solid var(--border-soft); }
  .section-nav { top: 8px; }
  .settings-card { scroll-margin-top: 70px; padding: 18px; }
  .field-grid-2, .field-grid-3, .field-grid-4 { grid-template-columns: 1fr; }
  .secret-grid .secret-field:last-child { grid-column: auto; }
  .notice { display: grid; }
  .saved-settings-controls { align-items: stretch; flex-direction: column; }
  .saved-settings-buttons { display: grid; grid-template-columns: 1fr; }
  .action-bar { bottom: 8px; display: grid; gap: 11px; }
  .action-buttons { display: grid; grid-template-columns: auto 1fr 1fr; width: 100%; }
}
@media (max-width: 440px) {
  .brand .eyebrow { display: none; }
  .brand strong { font-size: 0.9rem; }
  .header-actions > a { display: none; }
  .card-heading { align-items: flex-start; }
  .client-chip, .safety-lock { white-space: normal; text-align: center; }
  .action-buttons { grid-template-columns: 1fr 1fr; }
  .action-buttons .quiet-button { grid-column: 1 / -1; }
}
@media (prefers-reduced-motion: no-preference) {
  .state-good .state-orb { animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 50% { transform: scale(1.08); opacity: 0.76; } }
}
@media (forced-colors: active) {
  .state-orb, .diagnostic-icon { forced-color-adjust: none; }
}`;

export const SETTINGS_DASHBOARD_JS = String.raw`(function () {
  'use strict';

  var SETTINGS_URL = '/_intermediary/v1/settings';
  var VALIDATE_URL = '/_intermediary/v1/settings/validate';
  var APPLY_URL = '/_intermediary/v1/settings/apply';
  var ROLLBACK_URL = '/_intermediary/v1/settings/rollback';
  var RESET_URL = '/_intermediary/v1/settings/reset';
  var TOKEN_KEY = 'ollama-intermediary-settings-admin-token';
  var memoryToken = '';
  var loadedSettings = null;
  var loadedEnvelope = null;
  var loadedRevision = null;
  var busy = false;
  var dirty = false;
  var lastValidatedSignature = '';
  var lastApplyFeedback = null;
  var touchedPaths = new Set();

  function byId(id) { return document.getElementById(id); }
  function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
  function setText(id, value) {
    var element = byId(id);
    if (element) element.textContent = value == null || value === '' ? '—' : String(value);
  }
  function setHidden(id, hidden) {
    var element = byId(id);
    if (element) element.hidden = Boolean(hidden);
  }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || memoryToken; }
    catch (_) { return memoryToken; }
  }
  function setToken(value) {
    memoryToken = String(value || '');
    try {
      if (memoryToken) sessionStorage.setItem(TOKEN_KEY, memoryToken);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (_) { /* Memory remains scoped to this tab if sessionStorage is unavailable. */ }
    setHidden('forget-token', !memoryToken);
  }
  function headers(withBody) {
    var result = { accept: 'application/json' };
    if (withBody) result['content-type'] = 'application/json';
    if (withBody && loadedRevision != null) result['if-match'] = String(loadedRevision);
    var token = getToken();
    if (token) result.authorization = 'Bearer ' + token;
    return result;
  }
  function formatDate(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
  async function parseResponse(response) {
    var text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (_) { return { error: text }; }
  }
  function errorMessage(payload, fallback) {
    if (!payload) return fallback;
    if (typeof payload.error === 'string') return payload.error;
    if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
    if (typeof payload.message === 'string') return payload.message;
    return fallback;
  }
  function showPageError(message) {
    setText('page-error', message);
    setHidden('page-error', !message);
  }
  function showAuth(message) {
    setHidden('settings-workspace', true);
    setHidden('auth-panel', false);
    setText('auth-message', message || 'A valid settings admin token is required.');
    window.setTimeout(function () { byId('admin-token').focus(); }, 0);
  }
  function showWorkspace() {
    setHidden('auth-panel', true);
    setHidden('settings-workspace', false);
  }

  function pathParts(path) { return String(path || '').split('.').filter(Boolean); }
  function getPath(source, path) {
    return pathParts(path).reduce(function (current, key) {
      return current == null ? undefined : current[key];
    }, source);
  }
  function hasPath(source, path) {
    var current = source;
    var parts = pathParts(path);
    for (var index = 0; index < parts.length; index += 1) {
      if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), parts[index])) return false;
      current = current[parts[index]];
    }
    return true;
  }
  function setPath(target, path, value) {
    var parts = pathParts(path);
    var current = target;
    parts.forEach(function (key, index) {
      if (index === parts.length - 1) {
        current[key] = value;
        return;
      }
      var nextIsIndex = /^[0-9]+$/.test(parts[index + 1]);
      if (!current[key] || typeof current[key] !== 'object') current[key] = nextIsIndex ? [] : {};
      current = current[key];
    });
  }
  function inputValue(input) {
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number') return input.value === '' ? null : Number(input.value);
    if (input.dataset.nullable === 'true' && input.value.trim() === '') return null;
    return input.value.trim();
  }
  function setInputValue(input, value) {
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value == null ? '' : String(value);
  }
  function settingsFromEnvelope(payload) {
    if (payload && payload.settings && typeof payload.settings === 'object') return payload.settings;
    if (payload && payload.config && typeof payload.config === 'object') return payload.config;
    return {};
  }
  function populateForm(settings) {
    var defaultClient = byId('default-client');
    all('#default-client option[data-dynamic-client]').forEach(function (option) { option.remove(); });
    var availableClients = Object.keys(asObject(settings.clients));
    var selectedClient = getPath(settings, 'scheduler.default_client');
    if (selectedClient && !availableClients.includes(selectedClient)) availableClients.push(selectedClient);
    availableClients.forEach(function (name) {
      if (all('#default-client option').some(function (option) { return option.value === name; })) return;
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      option.dataset.dynamicClient = 'true';
      defaultClient.appendChild(option);
    });
    all('[data-path]').forEach(function (input) {
      setInputValue(input, getPath(settings, input.dataset.path));
    });
    setText('fallback-client-readout', getPath(settings, 'scheduler.default_client') || 'Odysseus');
  }
  function collectSettings() {
    var result = clone(loadedSettings || {});
    all('[data-path]').forEach(function (input) {
      var path = input.dataset.path;
      if (!touchedPaths.has(path)) return;
      var value = inputValue(input);
      if (path === 'clients.frigate.source_ips.0' && value === '') {
        var existingSources = getPath(result, 'clients.frigate.source_ips');
        if (Array.isArray(existingSources) && existingSources.length) {
          setPath(result, 'clients.frigate.source_ips', existingSources.slice(1));
        }
        return;
      }
      setPath(result, path, value);
    });
    return result;
  }
  function collectPatch() {
    var result = {};
    all('[data-path]').forEach(function (input) {
      var path = input.dataset.path;
      if (!touchedPaths.has(path)) return;
      var value = inputValue(input);
      if (path === 'clients.frigate.source_ips.0') {
        var existingSources = getPath(loadedSettings, 'clients.frigate.source_ips');
        var nextSources = Array.isArray(existingSources) ? existingSources.slice() : [];
        if (value === '') nextSources = nextSources.slice(1);
        else if (nextSources.length) nextSources[0] = value;
        else nextSources.push(value);
        setPath(result, 'clients.frigate.source_ips', nextSources);
        return;
      }
      setPath(result, path, value);
    });
    return result;
  }
  function requestPayload() {
    // The API accepts patches. Sending only touched fields prevents a repair of
    // one invalid base setting from accidentally pinning every displayed base
    // value into the persistent override document.
    return { settings: collectPatch() };
  }
  function signature() {
    return JSON.stringify({ settings: collectSettings() });
  }
  function calculateDirty() {
    if (!loadedSettings) return false;
    return signature() !== JSON.stringify({ settings: loadedSettings });
  }

  function secretConfigured(payload, name) {
    var statuses = asObject(payload.secret_status || payload.secrets);
    if (name === 'admin_token' && payload.infrastructure && typeof payload.infrastructure.settings_token_configured === 'boolean') {
      return payload.infrastructure.settings_token_configured;
    }
    var aliases = [name, name + '_configured', name.replace('_token', ''), name.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); })];
    for (var i = 0; i < aliases.length; i += 1) {
      var value = statuses[aliases[i]];
      if (typeof value === 'boolean') return value;
      if (value && typeof value.configured === 'boolean') return value.configured;
      if (value && typeof value.present === 'boolean') return value.present;
      if (typeof value === 'string') return value.length > 0;
    }
    return null;
  }
  function renderSecretStatus(payload) {
    [
      ['maintenance_token', 'maintenance-secret-state'],
      ['observability_token', 'observability-secret-state'],
      ['admin_token', 'admin-secret-state']
    ].forEach(function (entry) {
      var configured = secretConfigured(payload, entry[0]);
      var badge = byId(entry[1]);
      badge.className = 'configured-badge';
      if (configured === true) { badge.classList.add('is-configured'); badge.textContent = 'Configured'; }
      else if (configured === false) { badge.classList.add('is-missing'); badge.textContent = 'Missing'; }
      else badge.textContent = 'Not reported';
    });
  }

  function normalizeDiagnostics(payload) {
    var infrastructure = payload.infrastructure;
    var source = infrastructure && (infrastructure.diagnostics || infrastructure.checks || (Array.isArray(infrastructure) ? infrastructure : null));
    if (!source && infrastructure && typeof infrastructure === 'object') {
      source = Object.keys(infrastructure).filter(function (key) {
        return key !== 'diagnostics' && key !== 'checks' && key !== 'ollama';
      }).map(function (key) {
        var value = infrastructure[key];
        var title = key.replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
        var message;
        if (typeof value === 'boolean') message = value ? 'Yes' : 'No';
        else if (value == null) message = 'Not reported';
        else if (typeof value === 'object') message = JSON.stringify(value);
        else message = String(value);
        var expectedFalse = key === 'compose_editable' || key === 'secrets_editable';
        return {
          id: key,
          title: title,
          message: message,
          ok: expectedFalse ? value === false : (key === 'ui_can_apply' ? undefined : (typeof value === 'boolean' ? value : undefined)),
          severity: key === 'ui_can_apply' && value === false ? 'warning' : 'info'
        };
      });
    }
    if (!source) source = payload.infrastructure_diagnostics || [];
    if (!Array.isArray(source) && source && typeof source === 'object') {
      source = Object.keys(source).map(function (key) {
        var value = source[key];
        return typeof value === 'object' ? Object.assign({ id: key }, value) : { id: key, message: String(value) };
      });
    }
    var combined = Array.isArray(source) ? source.slice() : [];
    var configurationDiagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
    configurationDiagnostics.forEach(function (item) {
      if (!item) return;
      var normalized = typeof item === 'string' ? { message: item } : Object.assign({}, item);
      normalized.title = normalized.title
        || (normalized.path && normalized.path !== '$' ? normalized.path : null)
        || normalized.code
        || 'Configuration check';
      combined.push(normalized);
    });
    return combined;
  }
  function diagnosticSeverity(item) {
    var severity = String(item.severity || item.level || item.status || '').toLowerCase();
    if (item.ok === true || severity === 'ok' || severity === 'pass' || severity === 'healthy') return 'good';
    if (item.ok === false || severity === 'error' || severity === 'critical' || severity === 'failed') return 'error';
    if (severity === 'warning' || severity === 'warn' || severity === 'restart_required') return 'warning';
    return 'neutral';
  }
  function renderDiagnostics(payload) {
    var diagnostics = normalizeDiagnostics(payload);
    var list = byId('diagnostics-list');
    list.replaceChildren();
    var errors = 0;
    var warnings = 0;
    diagnostics.forEach(function (item) {
      item = typeof item === 'string' ? { message: item } : asObject(item);
      var severity = diagnosticSeverity(item);
      if (severity === 'error') errors += 1;
      if (severity === 'warning') warnings += 1;
      var li = document.createElement('li');
      li.className = 'diagnostic diagnostic-' + severity;
      var icon = document.createElement('span');
      icon.className = 'diagnostic-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = severity === 'good' ? '\u2713' : severity === 'error' ? '!' : severity === 'warning' ? '\u2022' : 'i';
      var copy = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = item.title || item.name || item.id || 'Infrastructure check';
      var message = document.createElement('p');
      message.textContent = item.message || item.detail || 'No details reported.';
      copy.appendChild(title);
      copy.appendChild(message);
      if (item.remediation || item.action) {
        var remediation = document.createElement('small');
        remediation.textContent = item.remediation || item.action;
        copy.appendChild(remediation);
      }
      li.appendChild(icon);
      li.appendChild(copy);
      list.appendChild(li);
    });
    setHidden('diagnostics-empty', diagnostics.length > 0);
    var badge = byId('diagnostics-summary');
    badge.className = 'status-pill';
    if (errors) { badge.classList.add('status-error'); badge.textContent = errors + ' error' + (errors === 1 ? '' : 's'); }
    else if (warnings) { badge.classList.add('status-warning'); badge.textContent = warnings + ' warning' + (warnings === 1 ? '' : 's'); }
    else if (diagnostics.length) { badge.classList.add('status-good'); badge.textContent = 'All checks passed'; }
    else { badge.classList.add('status-neutral'); badge.textContent = 'Not reported'; }
  }

  function clearErrors() {
    all('[data-field-wrap]').forEach(function (element) { element.classList.remove('has-error'); });
    all('[data-error-for]').forEach(function (element) { element.textContent = ''; });
    setHidden('validation-summary', true);
  }
  function normalizeErrors(payload) {
    var source = payload.field_errors || payload.errors || (payload.validation && (payload.validation.errors || payload.validation.diagnostics)) || payload.diagnostics || [];
    var result = [];
    if (Array.isArray(source)) {
      source.forEach(function (error) {
        if (typeof error === 'string') result.push({ path: '', message: error });
        else if (error && typeof error === 'object' && String(error.severity || 'error').toLowerCase() === 'error') result.push({ path: error.path || error.field || error.pointer || '', message: error.message || error.error || 'Invalid value' });
      });
    } else if (source && typeof source === 'object') {
      Object.keys(source).forEach(function (path) {
        var value = source[path];
        if (Array.isArray(value)) value.forEach(function (message) { result.push({ path: path, message: String(message) }); });
        else result.push({ path: path, message: typeof value === 'string' ? value : (value.message || 'Invalid value') });
      });
    }
    return result;
  }
  function normalizeErrorPath(path) {
    return String(path || '').replace(/^settings\./, '').replace(/^\//, '').replace(/\//g, '.').replace(/\[(\d+)\]/g, '.$1');
  }
  function browserFieldErrors() {
    var errors = [];
    all('[data-path]').forEach(function (input) {
      var value = input.type === 'checkbox' ? '' : input.value.trim();
      if (input.required && !value) {
        errors.push({ path: input.dataset.path, message: 'A value is required.' });
      } else if (input.validity && input.validity.typeMismatch) {
        errors.push({ path: input.dataset.path, message: 'Enter a valid value in the requested format.' });
      } else if (input.validity && (input.validity.badInput || input.validity.rangeOverflow || input.validity.rangeUnderflow || input.validity.stepMismatch)) {
        errors.push({ path: input.dataset.path, message: input.validationMessage || 'Enter a value within the allowed range.' });
      }
    });
    return errors;
  }
  function renderErrors(payload) {
    clearErrors();
    var errors = normalizeErrors(payload);
    browserFieldErrors().forEach(function (error) {
      if (!errors.some(function (existing) { return normalizeErrorPath(existing.path) === error.path; })) errors.push(error);
    });
    errors.forEach(function (error) {
      var path = normalizeErrorPath(error.path);
      var wrap = all('[data-field-wrap]').find(function (element) { return element.dataset.fieldWrap === path; });
      var output = all('[data-error-for]').find(function (element) { return element.dataset.errorFor === path; });
      if (wrap) wrap.classList.add('has-error');
      if (output) output.textContent = error.message;
    });
    if (errors.length) {
      var summary = byId('validation-summary');
      var located = errors.filter(function (error) { return Boolean(error.path); }).length;
      summary.textContent = errors.length + ' configuration ' + (errors.length === 1 ? 'error needs' : 'errors need') + ' attention.' + (located < errors.length ? ' ' + (errors.length - located) + ' general error(s) are listed by the server.' : '');
      summary.hidden = false;
      summary.focus();
    }
    return errors;
  }

  function restartInfo(payload) {
    var apply = asObject(payload.apply_status || payload.application || payload.status);
    var required = payload.restart_required === true || apply.restart_required === true || apply.state === 'restart_required';
    var pending = payload.pending_restart === true || apply.pending_restart === true;
    return {
      required: required || pending,
      title: apply.title || (payload.restarting ? 'Intermediary restarting' : pending ? 'Restart still pending' : 'Restart required'),
      detail: apply.message || payload.message || payload.restart_reason || 'The settings were saved, but one or more values become active only after the intermediary restarts.'
    };
  }
  function renderRestart(payload) {
    var info = restartInfo(payload);
    setHidden('restart-banner', !info.required);
    if (info.required) {
      setText('restart-title', info.title);
      setText('restart-detail', info.detail);
    }
  }
  function configValidity(payload) {
    if (payload.valid === false || payload.configuration_valid === false) return false;
    if (browserFieldErrors().length) return false;
    if (payload.valid === true || payload.configuration_valid === true) return true;
    return normalizeErrors(payload).length === 0;
  }
  function renderConfiguration(payload) {
    var valid = configValidity(payload);
    var restart = restartInfo(payload);
    var mode = String(payload.mode || '').toLowerCase();
    var recovery = mode === 'recovery' || mode === 'configuration_error';
    var banner = byId('configuration-banner');
    banner.className = 'configuration-banner ' + (!valid || recovery ? 'state-error' : restart.required ? 'state-warning' : 'state-good');
    if (!valid || recovery) {
      setText('configuration-title', 'Configuration needs attention');
      setText('configuration-detail', recovery
        ? 'The intermediary is in restricted recovery mode. Correct the red fields, validate the draft, and apply it before inference can resume.'
        : 'Correct the red fields, validate the draft, and apply it before inference continues.');
    } else if (restart.required) {
      setText('configuration-title', 'Saved settings are waiting for restart');
      setText('configuration-detail', restart.detail);
    } else {
      setText('configuration-title', 'Configuration is valid');
      setText('configuration-detail', 'The structured settings passed the intermediary\'s current validation checks.');
    }
    setText('configuration-revision', payload.revision != null ? payload.revision : (payload.etag != null ? payload.etag : (payload.version != null ? payload.version : '—')));
    setText('configuration-applied-at', formatDate(payload.applied_at || payload.updated_at));
    renderRestart(payload);
  }

  function setBusy(next, label) {
    busy = next;
    all('#settings-form button').forEach(function (button) { button.disabled = next; });
    if (!next) all('#settings-form button').forEach(function (button) { button.disabled = false; });
    if (!next) updateDirtyState();
    if (next) {
      setText('action-title', label || 'Working…');
      setText('action-detail', 'Keep this page open while the intermediary processes the request.');
    }
  }
  function updateDirtyState() {
    dirty = calculateDirty();
    var validForCurrentDraft = dirty && lastValidatedSignature === signature();
    var canMutateSaved = Boolean(loadedEnvelope && loadedEnvelope.infrastructure && loadedEnvelope.infrastructure.ui_can_apply !== false);
    byId('discard-button').disabled = busy || !dirty;
    byId('validate-button').disabled = busy;
    byId('apply-button').disabled = busy || !dirty || !validForCurrentDraft || !canMutateSaved;
    byId('rollback-button').disabled = busy || dirty || !canMutateSaved || !Boolean(loadedEnvelope && loadedEnvelope.has_previous);
    byId('reset-button').disabled = busy || dirty || !canMutateSaved;
    var state = byId('document-state');
    state.className = 'status-pill ' + (dirty ? 'status-warning' : 'status-good');
    state.textContent = dirty ? 'Unapplied changes' : 'Settings current';
    if (dirty) {
      setText('action-title', !canMutateSaved ? 'Host fix required' : (validForCurrentDraft ? 'Draft validated' : 'Unapplied changes'));
      setText('action-detail', !canMutateSaved
        ? 'Validation remains available, but applying is disabled until the host-side diagnostic is corrected.'
        : (validForCurrentDraft ? 'This exact draft passed validation and is ready to apply.' : 'Validate the draft before applying it.'));
    } else if (lastApplyFeedback) {
      setText('action-title', lastApplyFeedback.title);
      setText('action-detail', lastApplyFeedback.detail);
    } else {
      setText('action-title', 'No unapplied changes');
      setText('action-detail', 'Edit a field to create a draft.');
    }
    setText('fallback-client-readout', getPath(collectSettings(), 'scheduler.default_client') || 'Odysseus');
  }

  function applyEnvelope(payload) {
    loadedEnvelope = payload;
    loadedSettings = clone(settingsFromEnvelope(payload));
    loadedRevision = payload.revision != null ? payload.revision : (payload.etag != null ? payload.etag : (payload.version != null ? payload.version : null));
    touchedPaths.clear();
    populateForm(loadedSettings);
    renderConfiguration(payload);
    renderSecretStatus(payload);
    renderDiagnostics(payload);
    renderErrors(payload);
    if (payload.connectivity || payload.backend || payload.backend_connectivity || (payload.infrastructure && payload.infrastructure.ollama)) {
      renderConnectivity(payload, true);
    }
    lastValidatedSignature = '';
    showWorkspace();
    updateDirtyState();
  }

  async function loadSettings() {
    showPageError('');
    var response;
    try {
      response = await fetch(SETTINGS_URL, { method: 'GET', headers: headers(false), cache: 'no-store' });
    } catch (_) {
      showPageError('The intermediary could not be reached. Check the address and try again.');
      showAuth('The settings API could not be reached.');
      return;
    }
    var payload = await parseResponse(response);
    if (response.status === 401 || response.status === 403) {
      showAuth(errorMessage(payload, 'A valid settings admin token is required.'));
      return;
    }
    if (!response.ok) {
      showPageError(errorMessage(payload, 'Settings could not be loaded.'));
      showAuth('The settings API is unavailable.');
      return;
    }
    lastApplyFeedback = null;
    applyEnvelope(payload);
  }

  function renderConnectivity(payload, responseOk) {
    var source = payload.connectivity || payload.backend_connectivity || payload.backend || (payload.validation && payload.validation.connectivity) || (payload.infrastructure && payload.infrastructure.ollama) || {};
    var reachable = source.reachable === true || source.ok === true || source.status === 'healthy';
    var tested = source.tested !== false && Object.keys(asObject(source)).length > 0;
    var badge = byId('backend-connectivity');
    badge.className = 'status-pill';
    if (reachable) {
      badge.classList.add('status-good');
      badge.textContent = 'Reachable';
      setText('backend-connectivity-detail', source.message || 'The draft Ollama address responded successfully.');
      return true;
    } else if (tested || !responseOk) {
      badge.classList.add('status-error');
      badge.textContent = 'Unreachable';
      setText('backend-connectivity-detail', source.message || source.error || 'Ollama did not pass the connectivity check.');
      return false;
    } else {
      badge.classList.add('status-neutral');
      badge.textContent = 'Not tested';
      setText('backend-connectivity-detail', 'The server validated the draft without reporting a connectivity result.');
      return null;
    }
  }

  async function validateDraft() {
    if (busy || !loadedSettings) return false;
    setBusy(true, 'Validating draft…');
    clearErrors();
    showPageError('');
    var draftSignature = signature();
    try {
      var response = await fetch(VALIDATE_URL, { method: 'POST', headers: headers(true), body: JSON.stringify(requestPayload()) });
      var payload = await parseResponse(response);
      if (response.status === 401 || response.status === 403) { showAuth(errorMessage(payload, 'The admin token was rejected.')); return false; }
      renderDiagnostics(Object.assign({}, loadedEnvelope || {}, payload, {
        diagnostics: Array.isArray(payload.diagnostics) ? payload.diagnostics : []
      }));
      var errors = renderErrors(payload);
      if (!response.ok || payload.valid === false || errors.length) {
        showPageError(errorMessage(payload, 'The draft contains errors. No settings were changed.'));
        return false;
      }
      lastValidatedSignature = draftSignature;
      setText('action-title', 'Draft validated');
      setText('action-detail', 'No settings were saved. This draft is ready to apply.');
      return true;
    } catch (_) {
      showPageError('The validation request failed. No settings were changed.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function applyDraft() {
    if (busy || !dirty || !loadedSettings || lastValidatedSignature !== signature()) return;
    setBusy(true, 'Applying settings…');
    clearErrors();
    showPageError('');
    var payloadToSend = requestPayload();
    try {
      var response = await fetch(APPLY_URL, { method: 'POST', headers: headers(true), body: JSON.stringify(payloadToSend) });
      var payload = await parseResponse(response);
      if (response.status === 401 || response.status === 403) { showAuth(errorMessage(payload, 'The admin token was rejected.')); return; }
      var errors = renderErrors(payload);
      if (!response.ok || payload.valid === false || errors.length) {
        showPageError(errorMessage(payload, response.status === 409 ? 'The configuration changed elsewhere. Reload the current settings and try again.' : 'The draft was not applied.'));
        return;
      }
      var envelope = payload.settings || payload.config ? payload : Object.assign({}, loadedEnvelope || {}, payload, {
        settings: collectSettings(),
        updated_at: payload.updated_at || new Date().toISOString()
      });
      applyEnvelope(envelope);
      showPageError('');
      lastApplyFeedback = {
        title: restartInfo(payload).required ? 'Settings saved · restart required' : 'Settings applied',
        detail: restartInfo(payload).required ? 'Review the restart notice above before expecting every value to be active.' : 'The intermediary accepted the new configuration.'
      };
    } catch (_) {
      showPageError('The apply request failed. The intermediary may not have changed anything; reload before trying again.');
    } finally {
      setBusy(false);
    }
  }

  function discardDraft() {
    if (!loadedSettings) return;
    touchedPaths.clear();
    populateForm(loadedSettings);
    clearErrors();
    showPageError('');
    lastApplyFeedback = null;
    lastValidatedSignature = '';
    updateDirtyState();
  }

  async function mutateSavedOverrides(action) {
    if (busy || dirty || !loadedEnvelope) return;
    var rollback = action === 'rollback';
    var question = rollback
      ? 'Roll back to the preceding saved settings revision? The intermediary will restart.'
      : 'Remove every browser-saved override and return to config.yml values? The intermediary will restart.';
    if (!window.confirm(question)) return;
    setBusy(true, rollback ? 'Rolling back saved settings…' : 'Resetting saved overrides…');
    clearErrors();
    showPageError('');
    try {
      var response = await fetch(rollback ? ROLLBACK_URL : RESET_URL, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ revision: loadedRevision, settings: {} })
      });
      var payload = await parseResponse(response);
      if (response.status === 401 || response.status === 403) {
        setBusy(false);
        showAuth(errorMessage(payload, 'The admin token was rejected.'));
        return;
      }
      if (!response.ok) {
        renderErrors(payload);
        showPageError(errorMessage(payload, response.status === 409
          ? 'The saved settings changed elsewhere or require a host-side repair. Reload and try again.'
          : 'The saved overrides could not be changed.'));
        setBusy(false);
        return;
      }
      loadedRevision = payload.revision != null ? payload.revision : loadedRevision;
      renderRestart(payload);
      setText('configuration-revision', loadedRevision);
      setText('configuration-title', 'Saved settings updated');
      setText('configuration-detail', payload.message || 'The intermediary is restarting with the selected settings revision.');
      var state = byId('document-state');
      state.className = 'status-pill status-warning';
      state.textContent = 'Restarting';
      setText('action-title', rollback ? 'Rollback saved' : 'Overrides reset');
      setText('action-detail', payload.message || 'Wait for the intermediary to restart, then reload this page.');
      // Keep controls disabled while the process exits and its supervisor
      // restarts it. Reloading after restart obtains the authoritative state.
    } catch (_) {
      showPageError('The request was interrupted. Reload after the intermediary restarts to verify the saved state.');
      setBusy(false);
    }
  }

  function bindEvents() {
    byId('auth-form').addEventListener('submit', function (event) {
      event.preventDefault();
      setToken(byId('admin-token').value.trim());
      byId('admin-token').value = '';
      loadSettings();
    });
    byId('forget-token').addEventListener('click', function () {
      setToken('');
      loadedSettings = null;
      showAuth('The settings admin token was cleared from this browser tab.');
    });
    byId('settings-form').addEventListener('input', function (event) {
      var path = event.target.dataset.path || '';
      if (path) {
        touchedPaths.add(path);
        var wrap = event.target.closest('[data-field-wrap]');
        var output = all('[data-error-for]').find(function (element) { return element.dataset.errorFor === path; });
        if (wrap) wrap.classList.remove('has-error');
        if (output) output.textContent = '';
      }
      lastApplyFeedback = null;
      lastValidatedSignature = '';
      updateDirtyState();
    });
    byId('settings-form').addEventListener('change', function (event) {
      if (event.target.dataset.path) touchedPaths.add(event.target.dataset.path);
      lastValidatedSignature = '';
      updateDirtyState();
    });
    byId('settings-form').addEventListener('submit', function (event) { event.preventDefault(); applyDraft(); });
    byId('validate-button').addEventListener('click', function () { validateDraft(); });
    byId('test-backend').addEventListener('click', function () { validateDraft(); });
    byId('discard-button').addEventListener('click', discardDraft);
    byId('rollback-button').addEventListener('click', function () { mutateSavedOverrides('rollback'); });
    byId('reset-button').addEventListener('click', function () { mutateSavedOverrides('reset'); });
    window.addEventListener('beforeunload', function (event) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  bindEvents();
  if (getToken()) loadSettings();
  else showAuth('Enter the separate settings admin token to view or change configuration.');
})();`;
