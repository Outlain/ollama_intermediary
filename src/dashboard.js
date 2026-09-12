export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#0a0f18">
  <title>Ollama Intermediary</title>
  <link rel="stylesheet" href="/_intermediary/ui/dashboard.css">
  <script defer src="/_intermediary/ui/dashboard.js"></script>
</head>
<body>
  <header class="site-header">
    <div class="shell header-inner">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">OI</span>
        <div>
          <p class="eyebrow">Operations monitor</p>
          <h1>Ollama Intermediary</h1>
        </div>
      </div>
      <div class="header-actions">
        <a class="quiet-button settings-link" href="/settings">Settings</a>
        <span id="connection-status" class="connection-badge" role="status" aria-live="polite">
          <span class="connection-dot" aria-hidden="true"></span>
          <span id="connection-label">Connecting</span>
        </span>
        <button id="forget-token" class="quiet-button" type="button" hidden>Forget token</button>
      </div>
    </div>
  </header>

  <main class="shell">
    <div id="page-error" class="notice notice-error" role="alert" hidden></div>

    <section id="auth-panel" class="auth-panel" aria-labelledby="auth-title" hidden>
      <div>
        <p class="eyebrow">Protected endpoint</p>
        <h2 id="auth-title">Enter the observability token</h2>
        <p id="auth-message" class="muted">This dashboard needs a token to read operational metadata.</p>
      </div>
      <form id="token-form" class="token-form">
        <label for="token-input">Bearer token</label>
        <div class="token-row">
          <input id="token-input" name="token" type="password" autocomplete="off" spellcheck="false" required>
          <button type="submit">Connect</button>
        </div>
        <p class="form-help">The token is kept only in this browser tab's session storage.</p>
      </form>
    </section>

    <section id="health-banner" class="health-banner health-neutral" aria-labelledby="overall-state">
      <span class="health-orb" aria-hidden="true"></span>
      <div class="health-copy">
        <p class="eyebrow">System status</p>
        <h2 id="overall-state">Connecting…</h2>
        <p id="overall-detail">Waiting for the first intermediary snapshot.</p>
      </div>
      <dl class="health-stats">
        <div>
          <dt>Uptime</dt>
          <dd id="service-uptime">—</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd id="snapshot-age">—</dd>
        </div>
      </dl>
    </section>

    <div class="dashboard-grid">
      <section class="card maintenance-card" aria-labelledby="maintenance-heading">
        <div class="card-header">
          <div>
            <p class="eyebrow">GPU reservation</p>
            <h2 id="maintenance-heading">Pause mode</h2>
          </div>
          <span id="maintenance-state" class="tag tag-neutral" role="status" aria-live="polite">Unknown</span>
        </div>

        <div class="maintenance-layout">
          <div class="maintenance-status-panel">
            <h3 id="maintenance-title">Waiting for status…</h3>
            <p id="maintenance-detail" class="muted">Pause mode can temporarily reserve the GPU for work outside Ollama.</p>
            <dl class="maintenance-details">
              <div><dt>Automatic resume</dt><dd id="maintenance-resume-at">—</dd></div>
              <div><dt>Time remaining</dt><dd id="maintenance-countdown">—</dd></div>
              <div><dt>GPU released</dt><dd id="maintenance-gpu-released">—</dd></div>
              <div><dt>Paused at</dt><dd id="maintenance-paused-at">—</dd></div>
            </dl>
          </div>

          <div class="maintenance-controls-panel">
            <form id="maintenance-token-form" class="maintenance-token-form">
              <label for="maintenance-token-input">Maintenance control token</label>
              <div class="maintenance-token-row">
                <input id="maintenance-token-input" name="maintenance-token" type="password" autocomplete="off" spellcheck="false" aria-describedby="maintenance-token-state" required>
                <button id="maintenance-token-submit" class="control-button control-button-secondary" type="submit">Use token</button>
                <button id="forget-maintenance-token" class="quiet-button" type="button" hidden>Forget</button>
              </div>
              <p id="maintenance-token-state" class="form-help">Enter the separate maintenance token to enable controls.</p>
            </form>

            <div class="maintenance-action-row">
              <div class="duration-control">
                <label for="pause-duration">Pause duration</label>
                <select id="pause-duration" name="pause-duration" aria-describedby="maintenance-warning">
                  <option value="" selected>Until manually resumed</option>
                  <option value="30m">30 minutes</option>
                  <option value="1h">1 hour</option>
                  <option value="2h">2 hours</option>
                  <option value="4h">4 hours</option>
                  <option value="8h">8 hours</option>
                </select>
              </div>
              <div class="maintenance-buttons">
                <button id="pause-button" class="control-button control-button-warning" type="button" aria-describedby="maintenance-warning" disabled>Pause inference</button>
                <button id="resume-button" class="control-button control-button-primary" type="button" disabled>Resume inference</button>
              </div>
            </div>

            <p id="maintenance-control-availability" class="form-help">Checking whether maintenance controls are configured…</p>
            <p id="maintenance-action-status" class="action-status" role="status" aria-live="polite"></p>
          </div>
        </div>

        <div id="maintenance-warning" class="notice notice-warning maintenance-warning" role="note">
          <strong>What happens when pause mode starts</strong>
          <span>The active inference request is allowed to drain. Queued and newly submitted inference requests receive HTTP 503 until inference is resumed.</span>
        </div>
      </section>

      <section class="card current-card" aria-labelledby="current-heading">
        <div class="card-header">
          <div>
            <p class="eyebrow">Scheduler</p>
            <h2 id="current-heading">Current request</h2>
          </div>
          <span id="active-state" class="tag tag-neutral">Idle</span>
        </div>

        <div id="active-empty" class="empty-state">
          <span class="empty-pulse" aria-hidden="true"></span>
          <div>
            <strong>No request is running</strong>
            <p>The intermediary is ready for the next request.</p>
          </div>
        </div>

        <div id="active-content" hidden>
          <div class="request-title-row">
            <div>
              <div class="tag-row">
                <span id="active-client" class="tag">—</span>
                <span id="active-type" class="tag tag-neutral">—</span>
                <span id="active-streaming" class="tag tag-neutral">—</span>
              </div>
              <h3 id="active-model">—</h3>
              <p id="active-endpoint" class="mono muted">—</p>
            </div>
            <div class="duration-block">
              <span>Running</span>
              <strong id="active-running">0s</strong>
            </div>
          </div>

          <dl class="detail-grid">
            <div><dt>Queue wait</dt><dd id="active-queue-wait">—</dd></div>
            <div><dt>Selected because</dt><dd id="active-reason">—</dd></div>
            <div><dt>Request ID</dt><dd id="active-id" class="mono">—</dd></div>
            <div><dt>State</dt><dd id="active-status-text">—</dd></div>
          </dl>

          <div class="metadata-strip" aria-label="Safe request metadata">
            <div><span>Body</span><strong id="meta-body">—</strong></div>
            <div><span>Characters</span><strong id="meta-characters">—</strong></div>
            <div><span>Messages</span><strong id="meta-messages">—</strong></div>
            <div><span>Images</span><strong id="meta-images">—</strong></div>
            <div><span>Tools</span><strong id="meta-tools">—</strong></div>
            <div><span>Context</span><strong id="meta-context">—</strong></div>
            <div><span>Max output</span><strong id="meta-output">—</strong></div>
          </div>
        </div>
      </section>

      <section class="card queue-card" aria-labelledby="queue-heading">
        <div class="card-header">
          <div>
            <p class="eyebrow">Waiting room</p>
            <h2 id="queue-heading">Queue</h2>
          </div>
          <span id="queue-total" class="count-badge" aria-label="Total queued requests">0</span>
        </div>

        <dl class="queue-summary">
          <div class="client-stat client-odysseus">
            <dt>Odysseus</dt>
            <dd id="queue-odysseus">0</dd>
          </div>
          <div class="client-stat client-frigate">
            <dt>Frigate</dt>
            <dd id="queue-frigate">0</dd>
          </div>
          <div>
            <dt>Oldest wait</dt>
            <dd id="queue-oldest">0s</dd>
          </div>
        </dl>

        <p id="queue-empty" class="compact-empty">No requests are waiting.</p>
        <ol id="queue-items" class="queue-list" aria-label="Queued requests"></ol>
      </section>

      <section class="card backend-card" aria-labelledby="backend-heading">
        <div class="card-header">
          <div>
            <p class="eyebrow">Ollama backend</p>
            <h2 id="backend-heading">Model &amp; GPU</h2>
          </div>
          <span id="backend-state" class="tag tag-neutral">Unknown</span>
        </div>

        <div class="model-hero">
          <span>Scheduler model</span>
          <strong id="scheduler-model">None loaded</strong>
          <small id="scheduler-group">No active group</small>
        </div>

        <dl class="detail-grid backend-details">
          <div><dt>Reported VRAM</dt><dd id="backend-vram">—</dd></div>
          <div><dt>Context</dt><dd id="backend-context">—</dd></div>
          <div><dt>Model lease</dt><dd id="backend-lease">—</dd></div>
          <div><dt>Model switches</dt><dd id="backend-switches">0</dd></div>
          <div><dt>Upstream drain</dt><dd id="backend-draining">No</dd></div>
          <div><dt>Last healthy</dt><dd id="backend-last-success">—</dd></div>
        </dl>

        <div id="recovery-warning" class="notice notice-warning" role="alert" hidden>
          <strong>GPU recovery required</strong>
          <span id="recovery-reason">The backend reported an unsafe GPU state.</span>
        </div>

        <div class="subsection-heading">
          <h3>Loaded models</h3>
          <span id="loaded-model-count">0</span>
        </div>
        <ul id="loaded-models" class="model-list"></ul>
        <p id="models-empty" class="compact-empty">Ollama reports no loaded model.</p>
      </section>

      <section class="card events-card" aria-labelledby="events-heading">
        <div class="card-header">
          <div>
            <p class="eyebrow">In-memory history</p>
            <h2 id="events-heading">Recent activity</h2>
          </div>
          <span class="privacy-label">Metadata only</span>
        </div>
        <ol id="event-list" class="timeline"></ol>
        <p id="events-empty" class="compact-empty">No recent events.</p>
      </section>
    </div>
  </main>

  <footer class="site-footer shell">
    <p>Prompts, responses, images, and authorization headers are never displayed.</p>
    <p id="schema-version">Schema —</p>
  </footer>

  <noscript>
    <div class="noscript-message">JavaScript is required to display live intermediary status.</div>
  </noscript>
</body>
</html>`;

export const DASHBOARD_CSS = String.raw`:root {
  color-scheme: dark;
  --background: #080c13;
  --surface: #101722;
  --surface-raised: #151e2b;
  --surface-soft: #0d141e;
  --border: #253244;
  --border-soft: #1c2838;
  --text: #eef4fb;
  --muted: #91a0b4;
  --faint: #627187;
  --accent: #64dca5;
  --accent-strong: #22c982;
  --accent-soft: rgba(62, 218, 150, 0.12);
  --blue: #68a9ff;
  --blue-soft: rgba(83, 154, 255, 0.13);
  --purple: #b49bff;
  --purple-soft: rgba(171, 145, 255, 0.13);
  --warning: #f3ba62;
  --warning-soft: rgba(243, 186, 98, 0.13);
  --danger: #ff747d;
  --danger-soft: rgba(255, 96, 107, 0.12);
  --radius: 18px;
  --shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }

html { min-width: 320px; background: var(--background); }

body {
  margin: 0;
  min-height: 100vh;
  color: var(--text);
  background:
    radial-gradient(circle at 12% -8%, rgba(46, 174, 125, 0.12), transparent 30rem),
    radial-gradient(circle at 90% 4%, rgba(77, 133, 214, 0.09), transparent 28rem),
    var(--background);
}

button, input { font: inherit; }
button { cursor: pointer; }
[hidden] { display: none !important; }

.shell { width: min(1240px, calc(100% - 40px)); margin-inline: auto; }

.site-header {
  position: sticky;
  top: 0;
  z-index: 10;
  border-bottom: 1px solid rgba(37, 50, 68, 0.72);
  background: rgba(8, 12, 19, 0.86);
  backdrop-filter: blur(18px);
}

.header-inner {
  min-height: 76px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.brand { display: flex; align-items: center; gap: 13px; min-width: 0; }
.brand-mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  border: 1px solid rgba(100, 220, 165, 0.38);
  border-radius: 12px;
  color: var(--accent);
  background: linear-gradient(145deg, rgba(100, 220, 165, 0.15), rgba(100, 220, 165, 0.04));
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.08em;
}

h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: clamp(1rem, 2vw, 1.18rem); letter-spacing: -0.02em; }
h2 { margin-bottom: 0; font-size: 1.04rem; letter-spacing: -0.015em; }
h3 { margin-bottom: 0; font-size: 0.96rem; }
.eyebrow {
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 0.66rem;
  font-weight: 750;
  letter-spacing: 0.115em;
  text-transform: uppercase;
}
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

.header-actions { display: flex; align-items: center; gap: 10px; }
.connection-badge, .tag, .count-badge, .privacy-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  white-space: nowrap;
}
.connection-badge { padding: 7px 11px; color: var(--muted); background: var(--surface); font-size: 0.75rem; font-weight: 650; }
.connection-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warning); box-shadow: 0 0 0 3px var(--warning-soft); }
.connection-badge.is-live { color: #c8f8e1; border-color: rgba(100, 220, 165, 0.3); }
.connection-badge.is-live .connection-dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.connection-badge.is-offline .connection-dot { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }

.quiet-button {
  display: inline-flex;
  align-items: center;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--muted);
  background: transparent;
  font-size: 0.74rem;
  text-decoration: none;
}
.quiet-button:hover { color: var(--text); border-color: var(--faint); }

main { padding-block: 28px 16px; }

.health-banner {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 17px;
  min-height: 112px;
  margin-bottom: 18px;
  padding: 22px 24px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: linear-gradient(115deg, var(--surface-raised), var(--surface));
  box-shadow: var(--shadow);
}
.health-orb { width: 17px; height: 17px; border: 4px solid rgba(255,255,255,0.08); border-radius: 50%; background: var(--muted); box-shadow: 0 0 24px rgba(145, 160, 180, 0.3); }
.health-copy h2 { margin-bottom: 4px; font-size: clamp(1.15rem, 3vw, 1.45rem); }
.health-copy p:last-child { margin-bottom: 0; color: var(--muted); font-size: 0.86rem; }
.health-good { border-color: rgba(100, 220, 165, 0.25); background: linear-gradient(115deg, rgba(34, 201, 130, 0.13), var(--surface) 48%); }
.health-good .health-orb { background: var(--accent); box-shadow: 0 0 24px rgba(100, 220, 165, 0.55); }
.health-warning { border-color: rgba(243, 186, 98, 0.32); background: linear-gradient(115deg, var(--warning-soft), var(--surface) 50%); }
.health-warning .health-orb { background: var(--warning); box-shadow: 0 0 24px rgba(243, 186, 98, 0.5); }
.health-danger { border-color: rgba(255, 116, 125, 0.34); background: linear-gradient(115deg, var(--danger-soft), var(--surface) 50%); }
.health-danger .health-orb { background: var(--danger); box-shadow: 0 0 24px rgba(255, 116, 125, 0.48); }
.health-stats { display: flex; margin: 0; gap: 30px; }
.health-stats div { min-width: 84px; }
.health-stats dt, .detail-grid dt, .queue-summary dt { margin-bottom: 4px; color: var(--muted); font-size: 0.68rem; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; }
.health-stats dd, .detail-grid dd, .queue-summary dd { margin: 0; font-weight: 700; }

.dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.7fr); gap: 18px; align-items: start; }
.card {
  min-width: 0;
  padding: 22px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: linear-gradient(150deg, rgba(21, 30, 43, 0.98), rgba(14, 21, 31, 0.98));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
}
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 20px; }
.maintenance-card { grid-column: 1 / -1; grid-row: 1; }
.current-card { grid-column: 1; grid-row: 2; }
.queue-card { grid-column: 2; grid-row: 2; }
.backend-card { grid-column: 1; grid-row: 3; }
.events-card { grid-column: 2; grid-row: 3; }

.tag { padding: 5px 9px; color: var(--accent); border-color: rgba(100, 220, 165, 0.26); background: var(--accent-soft); font-size: 0.69rem; font-weight: 750; text-transform: uppercase; letter-spacing: 0.055em; }
.tag-neutral { color: var(--muted); border-color: var(--border); background: rgba(145, 160, 180, 0.06); }
.tag[data-client="frigate"] { color: var(--blue); border-color: rgba(104, 169, 255, 0.28); background: var(--blue-soft); }
.tag[data-client="odysseus"] { color: var(--purple); border-color: rgba(180, 155, 255, 0.28); background: var(--purple-soft); }
.tag.tag-danger { color: var(--danger); border-color: rgba(255, 116, 125, 0.28); background: var(--danger-soft); }
.tag.tag-good { color: var(--accent); border-color: rgba(100, 220, 165, 0.28); background: var(--accent-soft); }
.tag.tag-warning { color: var(--warning); border-color: rgba(243, 186, 98, 0.3); background: var(--warning-soft); }
.tag-row { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 13px; }

.maintenance-layout { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(380px, 1.1fr); gap: 18px; }
.maintenance-status-panel, .maintenance-controls-panel {
  min-width: 0;
  padding: 17px;
  border: 1px solid var(--border-soft);
  border-radius: 13px;
  background: var(--surface-soft);
}
.maintenance-status-panel h3 { margin-bottom: 6px; font-size: 1.02rem; }
.maintenance-status-panel > p { min-height: 2.5em; margin-bottom: 14px; font-size: 0.8rem; }
.maintenance-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0; }
.maintenance-details div { min-width: 0; padding: 10px; border: 1px solid var(--border-soft); border-radius: 9px; background: rgba(8, 12, 19, 0.5); }
.maintenance-details dt, .duration-control label, .maintenance-token-form label {
  display: block;
  margin-bottom: 5px;
  color: var(--muted);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.maintenance-details dd { margin: 0; overflow-wrap: anywhere; font-size: 0.8rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.maintenance-token-form { padding-bottom: 14px; border-bottom: 1px solid var(--border-soft); }
.maintenance-token-row { display: grid; grid-template-columns: minmax(120px, 1fr) auto auto; gap: 8px; }
.maintenance-token-row input, .duration-control select {
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--text);
  background: var(--background);
  outline: none;
}
.maintenance-token-row input:focus, .duration-control select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.maintenance-action-row { display: grid; grid-template-columns: minmax(190px, 1fr) auto; align-items: end; gap: 12px; padding-top: 14px; }
.duration-control select { width: 100%; }
.maintenance-buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.control-button {
  padding: 9px 13px;
  border: 1px solid var(--border);
  border-radius: 9px;
  font-size: 0.75rem;
  font-weight: 750;
}
.control-button-primary { color: #04120c; border-color: var(--accent-strong); background: var(--accent); }
.control-button-warning { color: #211404; border-color: #d89a3e; background: var(--warning); }
.control-button-secondary { color: var(--text); background: var(--surface-raised); }
.control-button:disabled, .maintenance-token-row input:disabled, .duration-control select:disabled { cursor: not-allowed; opacity: 0.5; }
.action-status { min-height: 1.3em; margin: 8px 0 0; color: var(--muted); font-size: 0.72rem; }
.action-status.is-error { color: var(--danger); }
.action-status.is-success { color: var(--accent); }
.maintenance-warning { margin: 16px 0 0; }

.empty-state { display: flex; align-items: center; gap: 14px; min-height: 140px; padding: 24px; border: 1px dashed var(--border); border-radius: 14px; background: var(--surface-soft); }
.empty-state p { margin: 4px 0 0; color: var(--muted); font-size: 0.84rem; }
.empty-pulse { width: 12px; height: 12px; flex: 0 0 auto; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 7px var(--accent-soft); }
.compact-empty { margin: 0; padding: 18px 4px; color: var(--muted); font-size: 0.82rem; text-align: center; }

.request-title-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding-bottom: 20px; }
.request-title-row h3 { max-width: 680px; overflow-wrap: anywhere; font-size: clamp(1.05rem, 2.5vw, 1.35rem); }
.request-title-row .mono { margin: 6px 0 0; font-size: 0.73rem; overflow-wrap: anywhere; }
.duration-block { min-width: 100px; text-align: right; }
.duration-block span, .metadata-strip span, .model-hero span { display: block; margin-bottom: 3px; color: var(--muted); font-size: 0.67rem; font-weight: 650; text-transform: uppercase; letter-spacing: 0.055em; }
.duration-block strong { color: var(--accent); font-size: 1.5rem; font-variant-numeric: tabular-nums; }

.detail-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; border-block: 1px solid var(--border-soft); }
.detail-grid div { min-width: 0; padding: 15px 14px; border-right: 1px solid var(--border-soft); }
.detail-grid div:first-child { padding-left: 0; }
.detail-grid div:last-child { border-right: 0; }
.detail-grid dd { overflow-wrap: anywhere; font-size: 0.83rem; }

.metadata-strip { display: grid; grid-template-columns: repeat(7, minmax(62px, 1fr)); gap: 8px; padding-top: 18px; }
.metadata-strip div { min-width: 0; padding: 10px; border: 1px solid var(--border-soft); border-radius: 10px; background: var(--surface-soft); }
.metadata-strip strong { overflow-wrap: anywhere; font-size: 0.8rem; font-variant-numeric: tabular-nums; }

.count-badge { justify-content: center; min-width: 34px; height: 30px; padding-inline: 9px; color: var(--accent); border-color: rgba(100, 220, 165, 0.26); background: var(--accent-soft); font-weight: 800; font-variant-numeric: tabular-nums; }
.queue-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 0 14px; }
.queue-summary div { min-width: 0; padding: 12px; border: 1px solid var(--border-soft); border-radius: 11px; background: var(--surface-soft); }
.queue-summary dd { font-size: 1.05rem; font-variant-numeric: tabular-nums; }
.client-odysseus dd { color: var(--purple); }
.client-frigate dd { color: var(--blue); }
.queue-list, .model-list, .timeline { margin: 0; padding: 0; list-style: none; }
.queue-list { display: grid; gap: 8px; max-height: 480px; overflow-y: auto; scrollbar-color: var(--border) transparent; }
.queue-item { padding: 12px; border: 1px solid var(--border-soft); border-radius: 11px; background: var(--surface-soft); }
.queue-item-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.queue-item-title { min-width: 0; }
.queue-item-title strong { display: block; overflow: hidden; color: var(--text); font-size: 0.8rem; text-overflow: ellipsis; white-space: nowrap; }
.queue-item-title span { color: var(--muted); font-size: 0.69rem; }
.wait-time { flex: 0 0 auto; color: var(--warning); font-size: 0.78rem; font-weight: 750; font-variant-numeric: tabular-nums; }
.queue-meta { display: flex; flex-wrap: wrap; gap: 5px 12px; color: var(--muted); font-size: 0.68rem; }

.model-hero { margin-bottom: 16px; padding: 18px; border: 1px solid rgba(100, 220, 165, 0.16); border-radius: 13px; background: linear-gradient(120deg, var(--accent-soft), var(--surface-soft)); }
.model-hero strong { display: block; overflow-wrap: anywhere; font-size: 1.08rem; }
.model-hero small { display: block; margin-top: 5px; color: var(--muted); }
.backend-details { grid-template-columns: repeat(3, 1fr); }
.backend-details div:nth-child(3n) { border-right: 0; }
.backend-details div:nth-child(n+4) { border-top: 1px solid var(--border-soft); }
.backend-details div:nth-child(4) { padding-left: 0; }
.subsection-heading { display: flex; align-items: center; justify-content: space-between; margin-top: 20px; padding-bottom: 10px; border-bottom: 1px solid var(--border-soft); }
.subsection-heading span { color: var(--muted); font-size: 0.75rem; }
.model-list { display: grid; gap: 8px; padding-top: 10px; }
.model-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; padding: 11px 12px; border: 1px solid var(--border-soft); border-radius: 10px; background: var(--surface-soft); }
.model-item strong { min-width: 0; overflow-wrap: anywhere; font-size: 0.8rem; }
.model-item > span { color: var(--accent); font-size: 0.76rem; font-weight: 700; }
.model-item small { grid-column: 1 / -1; color: var(--muted); font-size: 0.68rem; }

.privacy-label { padding: 5px 9px; color: var(--muted); background: var(--surface-soft); font-size: 0.66rem; }
.timeline { position: relative; display: grid; gap: 0; max-height: 506px; overflow-y: auto; scrollbar-color: var(--border) transparent; }
.timeline-item { position: relative; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 11px; padding: 10px 0; border-bottom: 1px solid var(--border-soft); }
.timeline-item:last-child { border-bottom: 0; }
.event-dot { width: 8px; height: 8px; margin-top: 5px; border: 2px solid var(--surface); border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 2px var(--border); }
.event-dot.event-good { background: var(--accent); box-shadow: 0 0 0 2px rgba(100, 220, 165, 0.18); }
.event-dot.event-warning { background: var(--warning); box-shadow: 0 0 0 2px var(--warning-soft); }
.event-dot.event-danger { background: var(--danger); box-shadow: 0 0 0 2px var(--danger-soft); }
.event-copy { min-width: 0; }
.event-copy strong { display: block; overflow: hidden; font-size: 0.78rem; text-overflow: ellipsis; white-space: nowrap; }
.event-copy span { display: block; margin-top: 3px; color: var(--muted); font-size: 0.68rem; overflow-wrap: anywhere; }
.event-time { color: var(--faint); font-size: 0.67rem; white-space: nowrap; }

.notice { margin-bottom: 18px; padding: 13px 15px; border: 1px solid var(--border); border-radius: 11px; font-size: 0.8rem; }
.notice strong { display: block; margin-bottom: 3px; }
.notice span { color: var(--muted); }
.notice-error { color: #ffb1b6; border-color: rgba(255, 116, 125, 0.3); background: var(--danger-soft); }
.notice-warning { margin-top: 16px; color: #ffd99d; border-color: rgba(243, 186, 98, 0.3); background: var(--warning-soft); }

.auth-panel { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(320px, 1.2fr); align-items: center; gap: 30px; margin-bottom: 18px; padding: 22px; border: 1px solid rgba(243, 186, 98, 0.3); border-radius: var(--radius); background: linear-gradient(120deg, var(--warning-soft), var(--surface)); }
.auth-panel p:last-child { margin: 6px 0 0; font-size: 0.82rem; }
.token-form label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 0.72rem; font-weight: 700; }
.token-row { display: flex; gap: 8px; }
.token-row input { min-width: 0; flex: 1; padding: 10px 12px; border: 1px solid var(--border); border-radius: 9px; color: var(--text); background: var(--background); outline: none; }
.token-row input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.token-row button { padding: 10px 15px; border: 1px solid var(--accent-strong); border-radius: 9px; color: #04120c; background: var(--accent); font-weight: 750; }
.form-help { margin: 7px 0 0; color: var(--muted); font-size: 0.68rem; }

.site-footer { display: flex; justify-content: space-between; gap: 20px; padding-block: 18px 30px; color: var(--faint); font-size: 0.68rem; }
.site-footer p { margin: 0; }
.noscript-message { position: fixed; inset: auto 20px 20px; padding: 14px; border: 1px solid var(--danger); border-radius: 10px; color: var(--text); background: var(--surface); }

@media (max-width: 900px) {
  .dashboard-grid { grid-template-columns: 1fr; }
  .maintenance-card, .current-card, .queue-card, .backend-card, .events-card { grid-column: 1; grid-row: auto; }
  .maintenance-card { order: 1; }
  .current-card { order: 2; }
  .queue-card { order: 3; }
  .backend-card { order: 4; }
  .events-card { order: 5; }
  .maintenance-layout { grid-template-columns: 1fr; }
  .metadata-strip { grid-template-columns: repeat(4, minmax(70px, 1fr)); }
}

@media (max-width: 640px) {
  .shell { width: min(100% - 24px, 1240px); }
  .site-header { position: static; }
  .header-inner { min-height: 68px; }
  .brand .eyebrow { display: none; }
  .brand-mark { width: 36px; height: 36px; border-radius: 10px; }
  .connection-badge { padding: 7px 9px; }
  .header-actions .quiet-button:not(.settings-link) { display: none; }
  main { padding-top: 16px; }
  .health-banner { grid-template-columns: auto 1fr; padding: 18px; }
  .health-stats { grid-column: 1 / -1; width: 100%; padding-top: 14px; border-top: 1px solid var(--border-soft); justify-content: space-between; }
  .health-stats div { min-width: 0; }
  .card { padding: 17px; border-radius: 15px; }
  .card-header { margin-bottom: 16px; }
  .request-title-row { display: block; }
  .duration-block { margin-top: 16px; text-align: left; }
  .detail-grid { grid-template-columns: repeat(2, 1fr); }
  .detail-grid div:nth-child(2n) { border-right: 0; }
  .detail-grid div:nth-child(n+3) { border-top: 1px solid var(--border-soft); }
  .detail-grid div:nth-child(3) { padding-left: 0; }
  .metadata-strip { grid-template-columns: repeat(2, minmax(80px, 1fr)); }
  .queue-summary { grid-template-columns: repeat(2, 1fr); }
  .queue-summary div:last-child { grid-column: 1 / -1; }
  .backend-details { grid-template-columns: repeat(2, 1fr); }
  .backend-details div:nth-child(3n) { border-right: 1px solid var(--border-soft); }
  .backend-details div:nth-child(2n) { border-right: 0; }
  .backend-details div:nth-child(n+3) { border-top: 1px solid var(--border-soft); }
  .backend-details div:nth-child(3), .backend-details div:nth-child(5) { padding-left: 0; }
  .auth-panel { grid-template-columns: 1fr; gap: 18px; }
  .token-row { display: grid; }
  .maintenance-token-row { grid-template-columns: 1fr auto; }
  .maintenance-token-row input { grid-column: 1 / -1; }
  .maintenance-action-row { grid-template-columns: 1fr; }
  .maintenance-buttons { justify-content: stretch; }
  .maintenance-buttons .control-button { flex: 1; }
  .site-footer { display: grid; gap: 7px; }
}

@media (prefers-reduced-motion: no-preference) {
  .health-good .health-orb, .empty-pulse { animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 50% { transform: scale(1.08); opacity: 0.78; } }
}

@media (forced-colors: active) {
  .health-orb, .connection-dot, .event-dot, .empty-pulse { forced-color-adjust: none; }
}
`;

export const DASHBOARD_JS = String.raw`(function () {
  'use strict';

  var STATUS_URL = '/_intermediary/v1/status';
  var EVENTS_URL = '/_intermediary/v1/events';
  var MAINTENANCE_PAUSE_URL = '/_intermediary/v1/maintenance/pause';
  var MAINTENANCE_RESUME_URL = '/_intermediary/v1/maintenance/resume';
  var TOKEN_KEY = 'ollama-intermediary-observability-token';
  var MAINTENANCE_TOKEN_KEY = 'ollama-intermediary-maintenance-token';
  var POLL_INTERVAL_MS = 2000;
  var STREAM_RETRY_MS = 10000;

  var snapshot = null;
  var snapshotReceivedAt = 0;
  var activeClock = null;
  var maintenanceClock = null;
  var memoryToken = '';
  var memoryMaintenanceToken = '';
  var maintenanceActionPending = false;
  var refreshPromise = null;
  var pollTimer = null;
  var retryTimer = null;
  var eventController = null;
  var connectionGeneration = 0;
  var authBlocked = false;
  var refreshDebounce = null;

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
    var seconds = Math.max(0, (Date.now() - timestamp) / 1000);
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
    setText('loaded-model-count', formatInteger(models.length));
    setHidden('models-empty', models.length > 0);
    var list = byId('loaded-models');
    list.replaceChildren();
    models.forEach(function (model) { list.appendChild(modelItem(model)); });
  }

  function eventSeverity(event) {
    var type = String(event.type || '').toLowerCase();
    var status = String(event.status || '').toLowerCase();
    if (status === 'error' || status === 'failed' || type.includes('recovery') || type.includes('circuit_open')) return 'event-danger';
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
    snapshotReceivedAt = performance.now();
    renderHealth(data);
    renderMaintenance(data);
    renderActive(data);
    renderQueue(data);
    renderBackend(data);
    renderEvents(data);
  }

  function updateLiveClocks() {
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
      try {
        var response = await fetch(STATUS_URL, {
          method: 'GET',
          headers: requestHeaders(),
          cache: 'no-store',
          credentials: 'same-origin'
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
        return true;
      } catch (error) {
        if (error && error.name === 'AbortError') return false;
        showError('Unable to read intermediary status: ' + (error.message || String(error)));
        setConnection('offline', 'Disconnected');
        return false;
      } finally {
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

  function scheduleRefresh() {
    if (refreshDebounce || authBlocked) return;
    refreshDebounce = window.setTimeout(function () {
      refreshDebounce = null;
      refreshSnapshot();
    }, 120);
  }

  function startPolling() {
    if (pollTimer || authBlocked) return;
    setConnection('', 'Polling every 2s');
    pollTimer = window.setInterval(refreshSnapshot, POLL_INTERVAL_MS);
  }
  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
  }
  function stopConnections() {
    connectionGeneration += 1;
    if (eventController) eventController.abort();
    eventController = null;
    if (retryTimer) window.clearTimeout(retryTimer);
    retryTimer = null;
    stopPolling();
  }

  function parseEventBlock(block) {
    var dataLines = [];
    block.split('\n').forEach(function (line) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    });
    if (!dataLines.length) return;
    var payload = dataLines.join('\n');
    if (payload === '[DONE]') return;
    scheduleRefresh();
  }

  async function connectEvents() {
    if (authBlocked) return;
    var generation = ++connectionGeneration;
    eventController = new AbortController();
    try {
      var headers = requestHeaders();
      headers.accept = 'text/event-stream';
      var response = await fetch(EVENTS_URL, {
        method: 'GET',
        headers: headers,
        cache: 'no-store',
        credentials: 'same-origin',
        signal: eventController.signal
      });
      if (response.status === 401) {
        showAuth(getToken() ? 'That token was rejected. Enter a valid observability token.' : 'A token is required to open this dashboard.');
        return;
      }
      if (!response.ok || !response.body) throw new Error('Event stream returned HTTP ' + response.status);
      stopPolling();
      setConnection('live', 'Live updates');
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      while (generation === connectionGeneration) {
        var result = await reader.read();
        if (result.done) throw new Error('Event stream closed');
        buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
        var boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          var block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          parseEventBlock(block);
        }
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (generation !== connectionGeneration || authBlocked) return;
      startPolling();
    } finally {
      if (generation === connectionGeneration && !authBlocked) {
        eventController = null;
        retryTimer = window.setTimeout(function () {
          retryTimer = null;
          connectEvents();
        }, STREAM_RETRY_MS);
      }
    }
  }

  async function reconnect() {
    stopConnections();
    authBlocked = false;
    setConnection('', 'Connecting');
    var ready = await refreshSnapshot();
    if (ready) connectEvents();
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
  byId('resume-button').addEventListener('click', function () { performMaintenanceAction('resume'); });

  window.addEventListener('pagehide', stopConnections);
  window.setInterval(updateLiveClocks, 1000);
  setToken(getToken());
  setMaintenanceToken(getMaintenanceToken());
  reconnect();
})();
`;
