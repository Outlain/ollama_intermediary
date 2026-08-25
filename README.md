# Ollama Scheduling Proxy

A model-aware, streaming reverse proxy for multiple applications sharing one Ollama server and one GPU. It owns the external inference queue, forwards at most one generation at a time, and deliberately trades a small amount of idle time for far fewer large-model unload/reload cycles.

The supplied defaults target these workloads without tying them to particular model names:

- Odysseus: interactive priority, protected queue, and a one-minute model lease.
- Frigate: bounded newest-biased queue, short lease, and a two-minute TTL.
- Ollama: a configurable backend URL, `OLLAMA_NUM_PARALLEL=1`, and `OLLAMA_MAX_LOADED_MODELS=1`.

## Install from a GitHub Release

Tagged releases publish two artifacts:

- A versioned Linux `amd64` container image in GitHub Container Registry.
- A small deployment bundle containing Compose, configuration templates, documentation, and a SHA-256 checksum.

After substituting the public repository owner and version:

```sh
gh release download v1.0.0 \
  --repo OWNER/ollama-scheduling-proxy \
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

At each dispatch boundary:

1. Expired and disconnected work is removed.
2. A request whose client `max_wait` has elapsed can force a model switch.
3. Otherwise, requests for the selected model keep affinity while its request/time batch limits remain.
4. If the selected model has no queued work, its `idle_hold` lease delays an avoidable switch. A same-model follow-up wakes the dispatcher immediately.
5. When affinity does not decide, the highest effective priority runs:

```text
effective_priority = base_priority
                   + floor(wait / aging_interval) * aging_bonus
```

FIFO is preserved within each client/model pair. The hard `max_wait` rule is the starvation backstop; aging gives old work increasing weight before that point. `max_batch_requests` and `max_batch_time` bound how long a busy model can retain affinity.

For `O1 F1 O2 F2 O3`, if the later jobs arrive while O1 runs, the expected order is `O1 O2 O3 F1 F2`, subject to maximum-wait and batch limits.

### Lease versus Ollama keep-alive

These controls are related but different:

- `idle_hold` is a scheduling decision: leave the dispatcher idle briefly instead of choosing another model.
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
- `POST /v1/embeddings`

Metadata endpoints—including `/api/tags`, `/api/show`, `/api/ps`, and `/v1/models`—pass through immediately and do not wait for inference. Unknown non-management endpoints also pass through.

Model-management endpoints `/api/pull`, `/api/push`, `/api/create`, `/api/delete`, and `/api/copy` use an exclusive operation gate. Once one is waiting it has precedence at the next inference boundary, and it never runs concurrently with generation. They can be disabled entirely.

Response status, content type, application headers, and body bytes are streamed as Ollama supplies them. The proxy does not buffer a complete model response and does not invent heartbeat tokens. Hop-by-hop HTTP headers are removed as required for a proxy. Request bodies are capped by `server.body_limit_bytes` because queued payloads live in memory.

Unconfigured models are normally scheduled using their detected client's policy. Keep `scheduler.unknown_model_policy: schedule` for this model-agnostic behavior. The alternative `reject` mode is only useful for an intentional model allowlist.

## Deployment variables and `secrets.env`

Docker Compose loads `secrets.env` into the container. The YAML loader expands `${NAME}`, `${NAME:-default}`, and `${NAME:?error message}` placeholders before parsing the configuration.

```dotenv
OLLAMA_URL=http://192.0.2.10:11434
FRIGATE_SOURCE=192.0.2.50/32
```

Only `OLLAMA_URL` is required. `FRIGATE_SOURCE` can remain blank until Frigate is connected, or when Frigate sends `X-Ollama-Client: frigate`. The supplied `scheduler.default_client: odysseus` setting means an unmatched source automatically receives the Odysseus policy; Odysseus's changing container IP never needs to be configured. `secrets.env` is ignored by Git and excluded from the Docker build context.

The `192.0.2.0/24` addresses above are documentation placeholders. Replace them with addresses valid for your deployment.

## Queue and failure behavior

- Odysseus defaults to a protected 10-request queue. Overflow returns a JSON HTTP 429; interactive jobs are never silently discarded.
- Frigate defaults to 20 queued requests and `drop_oldest`. An evicted caller receives JSON HTTP 429. Jobs older than two minutes receive HTTP 408 and are never dispatched.
- Optional coalescing is newest-wins and only activates when at least one configured header or scalar JSON field yields a key. Do not enable it until the real Frigate identifiers are confirmed.
- A queued disconnect removes the job immediately. By default, a running disconnect stops downstream delivery but drains Ollama to a normal completion while holding the single-inference gate. This deliberately trades some otherwise-wasted GPU time for safer ROCm cleanup.
- Generation requests are not retried. Even a connection failure before response headers is ambiguous—the backend may have started work—so version 1 chooses duplicate safety.
- Three failures in the configured window open the circuit. With `queue_behavior: hold`, queued jobs remain subject to their normal TTL while health probes run; `reject_new` returns 503 for new inference.
- A response containing a recognized ROCm/GPU out-of-memory signature bypasses the ordinary failure threshold and latches `recovery_required`. Queued work is failed with 503, new inference is rejected, and `/readyz` remains 503 until the proxy process is restarted after Ollama or the host has been recovered.
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

`drain_active_disconnects` applies only after dispatch. Callers that disappear while queued are still removed immediately. `unload_on_model_switch` runs only after normal lease/priority/batch scheduling has selected a different model, so it does not shorten `idle_hold`. The error-body limit bounds how much of an HTTP 5xx body is retained for fault classification; successful and streaming response bodies are not buffered.

When `/status` reports `backend.state: recovery_required`:

1. Check `ollama ps` and `sudo rocm-smi --showmeminfo vram --showpids` on the host.
2. Restart Ollama. If an `UNKNOWN` KFD PID still owns substantial VRAM, reboot the host to reset the driver.
3. Restart the intermediary container after the backend is clean: `docker compose restart ollama-scheduler`.
4. Confirm `/readyz` returns 200 before sending inference again.

The recovery latch is intentionally not cleared by an HTTP health probe: `/api/tags` can succeed while ROCm still holds orphaned VRAM.

## Observability

`GET /status` returns backend/circuit/recovery state, current model/group, active request, whether an abandoned request is being drained, per-client and per-model queue depths/oldest ages, last activity, lease remaining, switch count, and shutdown admission state.

The responsive dashboard at `GET /debug` displays the current source client, request type/model/age, privacy-safe request size counts, queue contents, Ollama-reported VRAM/context, recovery state, and the most recent in-memory lifecycle events. Prompts, responses, images, headers, source addresses, and deduplication values are never retained in observability history.

The versioned read-only API is:

- `GET /_intermediary/v1/status` for a complete snapshot
- `GET /_intermediary/v1/history?limit=50` for bounded in-memory history
- `GET /_intermediary/v1/events` for live Server-Sent Events

Set `OBSERVABILITY_TOKEN` in `secrets.env` to require a bearer token for these three data endpoints. The static dashboard will request it and retain it only in the browser tab's session storage. A blank token is convenient on a trusted LAN but provides no API authentication. The dashboard and API cannot cancel work or perform model/GPU management.

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
- `proxy_upstream_draining`
- `proxy_circuit_breaker_opens_total`

All application logs are newline-delimited JSON. Scheduling lifecycle entries include request ID, detected client, model, queue/dispatch/completion times, wait/duration, streaming flag, status, and switch reason. Supply `X-Request-ID` to correlate an existing trace; otherwise the proxy creates one.

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

The service has no authentication layer, matching Ollama's local API model. Bind/publish it only on a trusted LAN or protect it with an authenticated reverse proxy/firewall. Do not expose model-management endpoints to untrusted callers.

## Development and tests

```sh
npm ci
npm test
npm run test:coverage
```

The tests use Node's built-in test runner and a real HTTP mock Ollama. They cover FIFO, priority, aging/max-wait fairness, affinity batching, lease behavior, bounded batches, TTL, overflow, queued cancellation, active and streaming disconnect draining, unload-before-switch confirmation, ROCm OOM recovery latching, streaming latency, single upstream generation concurrency, circuit breaking, metadata bypass, exclusive model management, mappings, unknown models, keep-alive normalization, status/metrics, graceful shutdown, the `O O O F F` scenario, and post-restart model reconciliation.
