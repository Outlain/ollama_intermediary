# Ollama Scheduling Proxy

A streaming reverse proxy for multiple applications sharing one Ollama server and one GPU. It runs at most one inference at a time, prioritizes Odysseus, and can recover missing Frigate object and review descriptions later using a persistent backlog.

The supplied defaults target these workloads without tying them to particular model names:

- Odysseus: interactive priority, protected queue, and a one-minute model lease.
- Frigate: a bounded live queue plus optional durable description catch-up when the GPU is idle.
- Ollama: a configurable backend URL, `OLLAMA_NUM_PARALLEL=1`, and `OLLAMA_MAX_LOADED_MODELS=1`.

## Install from a GitHub Release

Tagged releases publish two artifacts:

- A versioned Linux `amd64` container image in GitHub Container Registry.
- A small deployment bundle containing Compose, configuration templates, documentation, and a SHA-256 checksum.

Once a version has actually been published on [GitHub Releases](https://github.com/Outlain/ollama_intermediary/releases), use its tag below. The version in source code alone does not mean that an image or release exists yet.

```sh
gh release download v1.0.0 \
  --repo Outlain/ollama_intermediary \
  --pattern 'ollama-scheduling-proxy-v1.0.0-linux-amd64.tar.gz*'
sha256sum -c ollama-scheduling-proxy-v1.0.0-linux-amd64.tar.gz.sha256
tar -xzf ollama-scheduling-proxy-v1.0.0-linux-amd64.tar.gz
cd ollama-scheduling-proxy-v1.0.0-linux-amd64
cp config.example.yml config.yml
cp secrets.example.env secrets.env
chmod 600 secrets.env
# Edit secrets.env, then:
docker compose pull
docker compose up -d
```

This release installation does not require Node.js, npm, Git, or a local image build. It only requires Docker Engine with the Compose plugin. See [docs/INSTALL.md](docs/INSTALL.md) for download, upgrade, rollback, and source-install instructions.

## Build from source

```sh
cp config.example.yml config.yml
cp secrets.example.env secrets.env
# Edit secrets.env with the real backend and optional Frigate source CIDR.
docker compose up -d --build
curl http://127.0.0.1:11435/readyz
curl http://127.0.0.1:11435/status
```

Open `http://<docker-host>:11435/debug` for the live read-only dashboard. It uses the same listener and does not require another port.

Open `http://<docker-host>:11435/settings` for protected, structured configuration. Enter the separate `SETTINGS_TOKEN` from `secrets.env`; the browser keeps it only in that tab's session storage.

Then change each application's Ollama base URL to `http://<docker-host>:11435`. If possible, configure one of these headers:

```text
X-Ollama-Client: odysseus
X-Ollama-Client: frigate
```

The explicit header wins. Without it, the proxy tries optional model mappings, then configured source IP/subnet mappings, then `scheduler.default_client`. The supplied configuration sets that fallback to `odysseus`, so Odysseus needs no stable Docker IP. Configure only Frigate's stable host IP/CIDR; every address that does not match Frigate uses the Odysseus policy. The example intentionally contains no model mappings, so every model sent in a request works automatically.

`clients` are workload-policy identities, not model registrations. They let the proxy give interactive Odysseus work higher priority while applying short TTL and overflow rules to Frigate. Each client's `model_policy` applies to every model that client requests. The `models` section is empty by default and exists only for rare exact-model overrides.

The container publishes host port `11435` to proxy port `11434`. The real Ollama service stays outside this Compose project.

## Scheduling algorithm

Inference endpoints enter an in-memory queue. A single dispatcher is the only code path that can open a scheduled generation request to Ollama.

`scheduler.mode: strict_priority` is the default, including for older configuration files without a mode field. At each dispatch boundary:

1. Expired and disconnected live HTTP requests are removed.
2. Waiting Odysseus requests go first, in arrival order, regardless of model name.
3. Other live clients use their configured priority, then arrival order. A lower-priority client waits for the previous client's idle hold; a higher-priority client does not.
4. Frigate catch-up starts one regeneration attempt only when live queues, active inference, and idle holds are clear. Discovered, eligible catch-up items whose retry delay has elapsed are newest-event-first.

Active inference is never interrupted to give another client a turn. In strict mode, priority aging, `max_wait`, model affinity, and batch limits cannot force Frigate ahead of Odysseus. Continuous Odysseus work can therefore postpone Frigate indefinitely; that is intentional. With the default one-minute Odysseus hold, a short web-search pause does not immediately hand the GPU to Frigate.

For `O1 F1 O2 F2 O3`, when the later requests arrive while O1 runs, the order is `O1 O2 O3`, the idle hold, then `F1 F2` if no new Odysseus request arrives.

For deployments that intentionally want the old fairness/affinity behavior, explicitly choose `scheduler.mode: balanced`. Only that compatibility mode applies priority aging, `max_wait` promotion, and model batch limits. A `max_wait` of zero disables forced promotion; it does not mean immediate expiration. Queue TTL is a separate setting in both modes.

### Lease versus Ollama keep-alive

These controls are related but different:

- `idle_hold` is a scheduling decision: leave the dispatcher idle briefly instead of handing the GPU to a lower-priority client. It does not delay a higher-priority request in strict mode, even when the model is unchanged.
- `keep_alive` is written into native Ollama generation request bodies: ask Ollama to retain that model for the configured duration.

The proxy never sends a separate preload request. The selected real request loads whatever model its JSON body names. OpenAI-compatible request bodies are not modified with native `keep_alive` fields. Once the scheduler has actually chosen a different model, the default GPU-safety policy sends a native `keep_alive: 0` cleanup request for the previous model and waits for `/api/ps` to confirm its unload before dispatching the replacement.

Client-wide policy example:

```yaml
clients:
  odysseus:
    model_policy:
      idle_hold: 1m
      max_batch_requests: 8
      max_batch_time: 90s
      keep_alive: 60s
```

Downloading or selecting a new Odysseus model requires no proxy configuration change. An optional exact override is possible when one unusual model needs different limits:

```yaml
models:
  unusually-large-model:latest:
    idle_hold: 30s
    max_batch_requests: 4
    max_batch_time: 2m
    keep_alive: 60s
```

## API behavior

Scheduled inference endpoints:

- `POST /api/generate`
- `POST /api/chat`
- `POST /api/embed`
- `POST /api/embeddings`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`

Explicitly allowlisted metadata endpoints—including `/api/tags`, `/api/show`, `/api/ps`, and `/v1/models`—pass through immediately and do not wait for inference. Unknown routes are rejected rather than risking a new inference endpoint bypassing serialization. Supported blob checks are metadata; blob uploads and model mutations use the management gate.

Model-management endpoints `/api/pull`, `/api/push`, `/api/create`, `/api/delete`, and `/api/copy` use an exclusive operation gate. Once one is waiting it has precedence at the next inference boundary, and it never runs concurrently with generation. They can be disabled entirely.

Response status, content type, application headers, and body bytes are streamed as Ollama supplies them. The proxy does not buffer a complete model response and does not invent heartbeat tokens. Hop-by-hop HTTP headers are removed as required for a proxy. Request bodies are capped individually by `server.body_limit_bytes`; `scheduler.max_queue_bytes` additionally bounds admitted active plus queued request bodies (64 MiB by default). This is a payload budget, not a guarantee about total process memory.

Unconfigured models are normally scheduled using their detected client's policy. Keep `scheduler.unknown_model_policy: schedule` for this model-agnostic behavior. The alternative `reject` mode is only useful for an intentional model allowlist.

## Deployment variables and `secrets.env`

Docker Compose loads `secrets.env` into the container. The YAML loader parses YAML first, then expands `${NAME}`, `${NAME:-default}`, and `${NAME:?error message}` placeholders in values, so environment text cannot inject additional YAML sections.

```dotenv
OLLAMA_URL=http://192.0.2.10:11434
FRIGATE_SOURCE=192.0.2.50/32
OBSERVABILITY_TOKEN=
SETTINGS_TOKEN=
MAINTENANCE_TOKEN=
FRIGATE_URL=
FRIGATE_USERNAME=
FRIGATE_PASSWORD=
FRIGATE_AUTH_TOKEN=
```

`OLLAMA_URL` and `MAINTENANCE_TOKEN` are required by the supplied base configuration, and `SETTINGS_TOKEN` is required to use the settings page/API. Generate each administrative token independently with `openssl rand -hex 32`. `SETTINGS_TOKEN` protects configuration reads and changes; `MAINTENANCE_TOKEN` authorizes pause/resume. Neither should be reused as the optional read-only `OBSERVABILITY_TOKEN`. `FRIGATE_SOURCE` can remain blank until Frigate is connected, or when Frigate sends `X-Ollama-Client: frigate`. The supplied `scheduler.default_client: odysseus` setting means an unmatched source automatically receives the Odysseus policy; Odysseus's changing container IP never needs to be configured. `secrets.env` is ignored by Git and excluded from the Docker build context.

The `192.0.2.0/24` addresses above are documentation placeholders. Replace them with addresses valid for your deployment.

## Settings page, persistence, and recovery

The settings page edits an allowlisted set of application settings such as the Ollama URL, client classification, queue limits, scheduling, circuit-breaker behavior, GPU safeguards, maintenance limits, and observability limits. It does not expose a raw YAML editor.

Configuration has three deliberately separate owners:

- `config.yml` is the read-only base configuration managed on the host.
- `/app/state/settings.json` contains validated, versioned browser overrides. It lives in the existing `ollama-scheduler-state` volume and takes precedence over matching base values.
- `secrets.env` remains host-only. The page reports only whether a token is configured; it never returns or changes token values.

Docker Compose is also host-only. The container has neither the Compose file nor the Docker socket mounted for writing, so the page cannot change ports, mounts, restart policy, image tags, memory limits, or Docker networking. Keep machine-specific Compose changes in the ignored `docker-compose.override.yml`, not in the tracked base file.

Use **Validate changes** before **Apply settings**. Apply atomically saves the override plus one last-known-good revision, stops admitting new inference, and waits for already-dispatched work to finish before beginning shutdown and exiting with status 75. The supplied Compose `restart: unless-stopped` policy starts it again with the new values. A systemd installation needs `Restart=on-failure`; a foreground `node` process must be started again manually.

If a safely editable setting prevents normal startup, the service enters a restricted configuration-recovery mode on the same container listener. `/settings` and `/healthz` remain available, `/readyz` and `/status` return HTTP 503 with `configuration_invalid`, and inference receives HTTP 503 until a valid configuration is applied and the supervisor restarts the service. Invalid YAML, a missing host-managed token, a bad volume mount, or a listener/Compose problem still requires a host-side fix. `SETTINGS_TOKEN` must be present in `secrets.env` even in recovery mode; without it, the static page loads but the settings API remains locked.

Because saved overrides take precedence, later edits to an overridden field in `config.yml` will not change that field until its saved override is reset. The page always displays the effective values, their revision, validation diagnostics, and whether the service is running normally or in configuration recovery.

## Queue and failure behavior

- Odysseus defaults to a protected 10-request queue. Overflow returns a JSON HTTP 429; interactive jobs are never silently discarded.
- Frigate defaults to 20 queued requests and `drop_oldest`. An evicted caller receives JSON HTTP 429. Jobs older than two minutes receive HTTP 408 and are never dispatched.
- Optional coalescing is newest-wins and only activates when at least one configured header or scalar JSON field yields a key. Do not enable it until the real Frigate identifiers are confirmed.
- A queued disconnect removes the job immediately. By default, a running disconnect stops downstream delivery but drains Ollama to a normal completion while holding the single-inference gate. This deliberately trades some otherwise-wasted GPU time for safer ROCm cleanup.
- Original inference payloads are never automatically replayed. Even a connection failure before response headers is ambiguous: the backend may have started work. Optional Frigate recovery instead checks saved descriptions and asks Frigate's own regeneration API to handle still-missing results.
- Three failures in the configured window open the circuit. With `queue_behavior: hold`, queued jobs remain subject to their normal TTL while health probes run; `reject_new` returns 503 for new inference.
- A recognized GPU out-of-memory error or an uncertain upstream completion can latch `recovery_required`. Queued work is failed with 503 and new inference is rejected until an operator has recovered the host and acknowledges recovery. HTTP 200 streaming responses can contain model errors; they are not automatically counted as successful generations.
- `/api/tags` and `/api/ps` are probed periodically. `/api/ps` reconciles the scheduler's model state when no request is active, covering Ollama restarts and external unloads.

The proxy intentionally does not kill `llama-server`, run `amd-smi`, or reboot the host. It contains a suspected GPU fault instead of claiming to repair kernel/driver state. The ambiguous condition “`/api/ps` empty while VRAM is busy” still requires a host-side `rocm-smi` check; no GPU devices or host privileges are granted to this container.

### GPU safety and recovery

The defaults are designed for the cancellation failure mode seen with large ROCm model loads:

```yaml
gpu_safety:
  drain_active_disconnects: true
  unload_on_model_switch: true
  unload_timeout: 30s
  recovery_on_oom: true
  error_body_limit_bytes: 65536
```

`drain_active_disconnects` applies only after dispatch. Callers that disappear while queued are still removed immediately. `unload_on_model_switch` runs only after scheduling has selected a different model. The error-body limit bounds retained error text; streaming responses are inspected incrementally for model errors without retaining complete output. Usage statistics that cannot be safely parsed within bounded buffers are unavailable, not invented.

When `/status` reports `backend.state: recovery_required`:

1. Check `ollama ps` and `sudo rocm-smi --showmeminfo vram --showpids` on the host.
2. Restart Ollama. If an `UNKNOWN` KFD PID still owns substantial VRAM, reboot the host to reset the driver.
3. Keep maintenance paused, with no active inference or management operation. Acknowledge recovery only after checking physical GPU state: `POST /_intermediary/v1/recovery/acknowledge`, authenticated with `MAINTENANCE_TOKEN`, and JSON `{"confirm_gpu_recovered":true}`. The endpoint checks a fresh Ollama loaded-model list and requires it to be empty; it does not reset the GPU or independently prove that driver allocations are gone.
4. Recovery acknowledgment leaves maintenance paused. Resume explicitly, then confirm `/readyz` returns 200 before sending inference again.

The recovery latch is intentionally not cleared by an HTTP health probe: `/api/tags` can succeed while ROCm still holds orphaned VRAM.

## Frigate description catch-up

Catch-up is opt-in (`frigate.enabled: false` by default). It is a durable to-do list of Frigate object/review IDs, timestamps, state, and retry metadata—not a second copy of camera images, prompts, or recordings. Frigate still retrieves its own retained media and stores the resulting descriptions.

Use `/settings` for enablement and ordinary timing/limit changes. Keep connection credentials in `secrets.env`:

```dotenv
FRIGATE_URL=https://YOUR_FRIGATE_HOST:8971
FRIGATE_USERNAME=YOUR_ADMIN_USERNAME
FRIGATE_PASSWORD=YOUR_PASSWORD
# Alternatively use an appropriate bearer credential instead of username/password.
FRIGATE_AUTH_TOKEN=
```

The URL is the Frigate origin, without `/api`. Use a trusted TLS certificate; credentials must not be embedded in the URL. The intermediary needs an administrator-capable Frigate API connection because regeneration is an administrative operation. This connection is separate from `FRIGATE_SOURCE`, which identifies live inference traffic, and separate from Frigate's Ollama URL, which must continue pointing at the intermediary.

For an intentionally unauthenticated internal API (commonly `http://YOUR_FRIGATE_HOST:5000`), choose **No login required — trusted local API** under **Catch-up → Frigate authentication** and validate/apply. This saves `frigate.auth_mode: none`, sends no credentials even if old credentials remain in the environment, and removes the missing-login warning. Keep that API restricted to trusted hosts; this setting does not secure it. Other modes are `password`, `token`, and the backward-compatible default `auto` (bearer token first, then username/password, otherwise no login). Credentials themselves remain host-managed in `secrets.env`.

- Object recovery uses Frigate's native event-description regeneration API.
- Review recovery requires an installed Frigate build exposing `PUT /api/review/{id}/regenerate_description`, such as the tested-against source interface in development build `0.19.0-bb6c2e9`. This is not a claim of live hardware validation or a recommendation to blindly upgrade a production camera system.
- Unsupported review regeneration must be reported as unavailable, not silently replaced with a time-period summary.
- Effective per-camera enablement, object/zone filters, and review alert/detection settings control eligibility. The worker skips descriptions present at its final fresh check, bypassing Frigate's API cache. Frigate has no atomic “generate only if still missing” operation: a separate live/manual completion can race that check and the subsequent regeneration request. Object `force:false` respects camera enablement; it is not a no-overwrite guard.
- Cameras configured only for early object triggers (`tracked_object_end: false`) are excluded from object recovery and show `early_trigger_only_not_recoverable`. Retained event records do not expose the significant-update count needed to prove that their early trigger fired. Review recovery remains independent. Enable **Send on end** in Frigate only if you actually want that behavior; the intermediary does not change it for you.
- Automatic discovery begins at first enablement and persists that starting point. Use **Fill missing descriptions** to deliberately scan older retained items. Automatic and manual candidates share a deduplicated, newest-first backlog.
- Live HTTP requests keep their normal bounded queue and timeouts. A lost live connection does not need to remain open for hours: missing descriptions are discovered from Frigate afterwards.
- A background attempt starts only when the GPU scheduler is idle and not paused/recovering. Once Frigate has accepted a regeneration or inference is running, it is not forcibly cancelled when a new live request arrives. Frigate's native requests are not tagged as live versus regeneration, so this is idle-only background admission, not preemption of every subsequent native request.
- Regeneration acceptance is not completion. The worker checks Frigate for the saved description, retries transient problems with delay, and records deleted events/missing media as skipped rather than retrying missing recordings forever.
- Snapshots/recordings must outlast the backlog. Review regeneration uses retained recordings; object regeneration uses available configured snapshots/thumbnails, not necessarily the exact original live image sequence.

The backlog lives at `/app/state/frigate-backlog.json` by default, in the existing named volume. Never delete that volume during upgrades. `max_jobs` bounds pending queue state; a `backlog_capacity_reached` warning means discovery keeps its cursor and waits for room rather than discarding pending items. Newest-first applies to discovered, ready jobs: undiscovered items behind a full queue or unfinished scan cannot participate yet. Monitor capacity when scanning large histories. `poll_interval`, `live_grace`, `retry_interval`, `max_retry_interval`, `request_timeout`, and `generation_timeout` distinguish discovery, time allowed for a live description to arrive, retry backoff, API requests, and waiting for a generated result.

`GET /_intermediary/v1/status` exposes `frigate.state`, `frigate.counts` (`pending`, `waiting_live`, `waiting_result`, `retrying`), and persistent `frigate.totals.completed` / `frigate.totals.skipped`. Recent jobs show reasons; connection or state-store failures appear as degraded/error state. To request the historical missing-description scan, use `POST /_intermediary/v1/frigate/scan` with `SETTINGS_TOKEN` and JSON `{"confirm":true}`. The scan requests work; it does not synchronously generate every description. Home Assistant examples are in [docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md).

The dashboard waiting list shows 30 jobs per page with **Previous / Next** controls; the display limit does not discard pending jobs. `GET /_intermediary/v1/frigate/jobs?offset=0&limit=30` browses all saved pending jobs using the same read authentication as catch-up status (`limit` accepts 1–100). Pages follow newest-first event time and can shift as jobs arrive or finish. Recent results remain bounded history, not an unlimited archive.

**Waiting Result** means Frigate accepted a generation handoff, not that the model is still running. The dashboard shows the remaining confirmation window (`generation_timeout`, normally 10 minutes). Until the description is confirmed or that window expires and retry processing can proceed, no second catch-up handoff starts. A model error can therefore look like a temporary stall. The proxy cannot reliably associate every native Frigate inference error with a specific backlog ID. Repeated context-size errors require changing the Frigate request/model context; retrying the same oversized request will not repair it.

`frigate.eligibility_skipped` counts discovery observations by exclusion reason, not distinct events: overlapping or repeated scans can count the same item again. Camera warnings and these counts help explain why a missing description is not eligible; they are not failed-generation totals.

Before enabling unattended recovery, test one retained object and one ended review on your installed Frigate instance, confirm the resulting descriptions appear in Frigate, then test live Odysseus priority and a container restart. Mock tests cannot validate real media retention, permissions, or GPU driver stability.

## Planned maintenance pause

Use maintenance pause when another application needs exclusive use of the GPU. It is safer and more informative than stopping the intermediary: callers receive a deliberate JSON HTTP 503 with code `maintenance_paused`, while the dashboard, status API, and pause state remain available.

Pausing is a safe transition rather than an abrupt cancellation:

1. New scheduled inference is rejected immediately with HTTP 503.
2. Queued inference is failed with the same status instead of being retained for hours.
3. If Ollama is already processing a request, the intermediary drains it to completion to avoid the ROCm cancellation/ghost-VRAM failure mode.
4. The loaded model is explicitly unloaded, and `/api/ps` must confirm that it is gone before `gpu_released` becomes true.

Model-management and other unsafe pass-through operations also receive the maintenance 503. Safe metadata reads such as `/api/tags`, `/api/ps`, `/api/show`, and `/v1/models` continue to work because they do not schedule GPU inference.

The pause endpoint returns HTTP 202 as soon as the pause record is safely persisted. Drain and unload then continue in the background; accepting the command is not yet proof that the GPU is free.

The simplest control surface is the **Pause mode** card at `http://<docker-host>:11435/debug`. Enter the separate maintenance token, choose **Manual** or a duration, and wait for the card to report both **Paused** and **GPU released: Yes**. The dashboard retains that credential only in the current browser tab's session storage.

For a manual pause with no automatic expiry:

```sh
read -rsp 'Maintenance token: ' MAINTENANCE_TOKEN; printf '\n'
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/pause \
  -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"exclusive GPU task"}'
```

For a timed pause, include a duration string. The supplied maximum is seven days (`168h`):

```sh
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/pause \
  -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"duration":"4h","reason":"exclusive GPU task"}'
```

The timed interval begins only after the active request has drained and model-unload confirmation has released the GPU. Use a manual pause for work whose end time is uncertain; a timed pause deliberately admits Ollama work again when it expires.

Before starting the other GPU task, inspect `GET /_intermediary/v1/status` or `/debug` and require all of these conditions:

```text
maintenance.state = paused
maintenance.gpu_released = true
maintenance.unload_error = null
```

`gpu_released` specifically means Ollama's `/api/ps` reports no loaded models. For a workload that needs virtually all VRAM—especially after a prior ROCm failure—also run `sudo rocm-smi --showmeminfo vram --showpids` on the host before starting it; the container cannot certify driver-level ghost allocations.

Resume manually when the exclusive task is finished:

```sh
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/resume \
  -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{}'
unset MAINTENANCE_TOKEN
```

The pause record is stored in the Compose volume mounted at `/app/state`, so manual and timed pauses survive intermediary container restarts. `maintenance.max_pause` limits only timed pauses; a manual pause remains until resumed.

Normally Ollama can remain running: after confirmed model unload it has no loaded model consuming a large VRAM allocation, and the paused intermediary prevents its clients from starting another inference request. If any application can bypass the intermediary, or the external workload requires absolute process-level isolation, stop only Ollama after `gpu_released` is true:

```sh
sudo systemctl stop ollama
```

Leave the intermediary running so clients receive the intentional 503 and operators retain status and control. Before resuming the intermediary, restart and verify Ollama:

```sh
sudo systemctl start ollama
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null
```

If `maintenance.state` is `error` or `gpu_released` is false, do not assume the GPU is free. Read `maintenance.unload_error`, check `ollama ps` and `rocm-smi`, and resolve the host-side condition first.

## Observability

`GET /status` returns backend/circuit/recovery state, current model/group, active request, whether an abandoned request is being drained, per-client and per-model queue depths/oldest ages, last activity, lease remaining, switch count, and shutdown admission state.

The responsive dashboard at `GET /debug` displays the current source client, request type/model/age, privacy-safe request size counts, queue contents, Ollama-reported VRAM/context, recovery state, and the most recent in-memory lifecycle events. Prompts, responses, images, headers, source addresses, and deduplication values are never retained in observability history.

The versioned read-only API is:

- `GET /_intermediary/v1/status` for a complete snapshot
- `GET /_intermediary/v1/history?limit=50` for bounded in-memory history
- `GET /_intermediary/v1/events` for live Server-Sent Events

Set `OBSERVABILITY_TOKEN` in `secrets.env` to require a bearer token for these data endpoints and legacy `/status` and `/metrics`. The static dashboard will request it and retain it only in the browser tab's session storage. A blank token is convenient on a trusted LAN but provides no read-API authentication. Pause/resume/recovery acknowledgment and settings/catch-up scanning are separate administrative operations protected by `MAINTENANCE_TOKEN` and `SETTINGS_TOKEN`; an observability token cannot mutate state.

Home Assistant can turn the shared snapshot into native sensors with one five-second REST poll. See [Home Assistant setup](docs/HOME_ASSISTANT.md).

`GET /metrics` emits Prometheus text including:

- `proxy_queue_depth{client=...}` and `proxy_oldest_queue_wait_seconds`
- `proxy_queue_wait_seconds` and `proxy_request_duration_seconds` histograms
- `proxy_requests_total`, `proxy_requests_failed_total`, `proxy_requests_dropped_total`
- `proxy_model_switches_total`
- `proxy_current_model{model=...}` and `proxy_backend_healthy`
- `proxy_active_request`, `proxy_active_request_duration_seconds`, and `proxy_queue_depth_total`
- `proxy_ollama_loaded_model_vram_bytes{model=...}`
- request/response byte and input/output token histograms when usage is available
- `proxy_model_load_duration_seconds` (dispatch-to-response-header estimate when a new model is expected)
- `proxy_active_disconnects_total` and `proxy_upstream_drain_duration_seconds`
- `proxy_model_unload_duration_seconds`
- `proxy_gpu_recovery_required` and `proxy_gpu_recovery_required_total`
- `proxy_maintenance_paused`, `proxy_maintenance_gpu_released`, and `proxy_maintenance_remaining_seconds`
- `proxy_maintenance_pauses_total`, `proxy_maintenance_resumes_total`, and `proxy_maintenance_gpu_releases_total`
- `proxy_upstream_draining`
- `proxy_circuit_breaker_opens_total`

All application logs are newline-delimited JSON. The supplied Compose files rotate container logs at 10 MiB across three files. Scheduling lifecycle entries include request ID, detected client, model, queue/dispatch/completion times, wait/duration, streaming flag, status, and switch reason. Supply `X-Request-ID` to correlate an existing trace; otherwise the proxy creates one. Prometheus model labels and per-metric series are bounded, with excess values aggregated rather than retained without limit.

Alert at minimum on `proxy_backend_healthy == 0`, `proxy_gpu_recovery_required == 1`, circuit openings, elevated queue age, drops, and the rate of `proxy_model_switches_total`. The last metric is the central before/after measure for GPU churn.

## Long HTTP timeouts

Queue time is deliberately unbounded by Node's server request timeout; the configured `ollama.request_timeout` starts only when a request is dispatched upstream. Every reverse proxy and client in front must allow the maximum queue wait plus model runtime.

Nginx or Nginx Proxy Manager “Advanced” configuration:

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 30m;
proxy_send_timeout 30m;
send_timeout 30m;
```

Nginx defines `proxy_read_timeout` between successive upstream reads, and disabling `proxy_buffering` passes streamed bytes onward as they arrive. See the [official proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

For Traefik, set the entry point response write timeout to zero (unlimited) or above the longest request, and attach a `ServersTransport` with a response-header timeout of zero or at least 30 minutes:

```yaml
# Static configuration
entryPoints:
  websecure:
    transport:
      respondingTimeouts:
        writeTimeout: 0s

# Dynamic configuration; reference this transport from the Ollama proxy service
http:
  serversTransports:
    ollama-long:
      forwardingTimeouts:
        responseHeaderTimeout: 0s
```

Traefik documents zero as no timeout for both [entry-point responding timeouts](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/) and [ServersTransport response-header timeout](https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/serverstransport/).

Avoid an orange-cloud Cloudflare path for this local inference API. Cloudflare currently documents a 125-second default proxy read timeout (Enterprise-configurable) and a 30-second proxy write timeout; queued requests can exceed those limits before any protocol-valid response exists. Use LAN/VPN access, DNS-only routing, or an appropriate Enterprise design. See [Cloudflare connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) and its [HTTP 524 guidance](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/).

## Ollama settings and rollout

Keep:

```text
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
```

After validating that all applications use the proxy, reduce `OLLAMA_MAX_QUEUE` gradually (for example, 32 and later 16). Do not expose direct Ollama to application traffic, or direct requests can bypass serialization.

Recommended rollout:

1. Deploy the proxy and confirm `/readyz` and `/status`.
2. Point Odysseus at it and verify that logs report `detected_client: odysseus` with `identification_method: fallback`.
3. Set `FRIGATE_SOURCE`, point Frigate at the proxy, generate controlled events, and verify that logs report `identification_method: source_ip`.
4. Observe response latency, drops, and model switches for at least a day before tuning holds/batches.
5. Only then reduce Ollama's internal queue.

The Ollama-compatible inference and model-management surface has no authentication layer, matching Ollama's local API model. Bind/publish it only on a trusted LAN or protect it with an authenticated reverse proxy/firewall. The settings and maintenance mutation APIs have their own bearer tokens, but those tokens do not protect ordinary Ollama routes. Do not expose model-management endpoints to untrusted callers.

## Development and tests

```sh
npm ci
npm test
npm run test:coverage
```

The tests use Node's built-in test runner and HTTP mocks. Coverage includes strict priority and balanced compatibility, same-model client holds, higher-priority hold bypass, bounded payload memory and metric cardinality, endpoint safety classification, streaming errors/draining, unload-before-switch, recovery latching, maintenance persistence, Frigate discovery/regeneration state transitions, settings validation/restarts, status/metrics, and existing streaming behavior. Live Frigate media access and ROCm hardware recovery require deployment acceptance tests.
