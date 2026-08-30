# Installation and updates

The recommended production installation uses the deployment bundle attached to a GitHub Release. It pulls a prebuilt, versioned image from GitHub Container Registry rather than building or copying the source tree.

## Prerequisites

- A 64-bit `amd64` Linux host.
- Docker Engine with the `docker compose` plugin.
- Network access from the proxy container to the real Ollama API.

Verify Docker:

```sh
docker --version
docker compose version
sudo systemctl enable --now docker
```

Use Docker's official installation instructions when those commands are unavailable.

## Install a release

Replace `OWNER` and `v1.0.0` with the public repository owner and desired release:

```sh
mkdir -p /tmp/ollama-scheduler-install
cd /tmp/ollama-scheduler-install

gh release download v1.0.0 \
  --repo OWNER/ollama-scheduling-proxy \
  --pattern 'ollama-scheduling-proxy-v1.0.0-linux-amd64.tar.gz*'

sha256sum -c ollama-scheduling-proxy-v1.0.0-linux-amd64.tar.gz.sha256
tar -xzf ollama-scheduling-proxy-v1.0.0-linux-amd64.tar.gz
sudo mv ollama-scheduling-proxy-v1.0.0-linux-amd64 /opt/ollama-scheduling-proxy
sudo chown -R "$USER":"$USER" /opt/ollama-scheduling-proxy
cd /opt/ollama-scheduling-proxy

cp config.example.yml config.yml
cp secrets.example.env secrets.env
chmod 600 secrets.env
```

Without GitHub CLI, download the `.tar.gz` and `.sha256` assets from the release page in a browser, then continue at the checksum step.

Edit `secrets.env`:

```dotenv
OLLAMA_URL=http://YOUR_OLLAMA_HOST:11434
FRIGATE_SOURCE=
OBSERVABILITY_TOKEN=
MAINTENANCE_TOKEN=
```

The supplied configuration treats every unmatched request as Odysseus, so Odysseus needs no IP setting. Set `FRIGATE_SOURCE` to Frigate's stable IP or CIDR when Frigate is connected. It can remain blank until then.

`OBSERVABILITY_TOKEN` protects the detailed dashboard data and Home Assistant endpoint. Generate a token with `openssl rand -hex 32`, or leave it blank only when port `11435` is restricted to a trusted LAN/VPN.

`MAINTENANCE_TOKEN` is required and protects the state-changing pause/resume API. Generate it with `openssl rand -hex 32`. Do not reuse the observability token, and do not commit either token to Git.

Validate and start:

```sh
docker compose config
docker compose pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:11435/readyz
curl http://127.0.0.1:11435/status
```

Open `http://YOUR_UBUNTU_IP:11435/debug` to view the live dashboard. If a token is configured, enter the raw token when prompted. For Home Assistant, follow [HOME_ASSISTANT.md](HOME_ASSISTANT.md).

The image uses `restart: unless-stopped`, so it returns after Docker or host restarts. A named Docker volume stores the maintenance pause record at `/app/state`; pause state therefore survives container recreation and upgrades.

## Upgrade

Download and verify the new release bundle in a temporary directory. Preserve the installed `config.yml` and `secrets.env`, then replace only `docker-compose.yml` with the new release's file:

```sh
cd /opt/ollama-scheduling-proxy
cp /path/to/new-release/docker-compose.yml ./docker-compose.yml
docker compose pull
docker compose up -d
docker compose ps
```

Review changes to `config.example.yml` before adopting new options. Compose recreates the container while retaining local configuration files and the named maintenance-state volume. In-memory queued inference jobs are intentionally not restored.

When upgrading an installation that predates maintenance pause, add a unique `MAINTENANCE_TOKEN` to `secrets.env` and copy the new `maintenance:` section from `config.example.yml` into `config.yml` before starting the new image. The supplied `${MAINTENANCE_TOKEN:?...}` expression intentionally prevents startup with a blank administrative token.

## Roll back

Restore the previous release's `docker-compose.yml`, which references an immutable version tag, then run:

```sh
docker compose pull
docker compose up -d
```

The supplied configuration enables GPU-safety draining, unload-before-switch, and latched ROCm OOM recovery. Keep the `gpu_safety` section enabled unless you are deliberately diagnosing one of those mechanisms.

If `/readyz` later reports `recovery_required`, inspect the host with:

```sh
ollama ps
sudo rocm-smi --showmeminfo vram --showpids
```

Restart Ollama first. If `rocm-smi` still shows an `UNKNOWN` process retaining substantial VRAM, reboot the host. Once GPU memory is clean, restart the intermediary so it clears its deliberate recovery latch:

```sh
cd /opt/ollama_intermediary
docker compose restart ollama-scheduler
curl http://127.0.0.1:11435/readyz
```

## Install from source instead

```sh
git clone https://github.com/OWNER/ollama-scheduling-proxy.git
cd ollama-scheduling-proxy
cp config.example.yml config.yml
cp secrets.example.env secrets.env
chmod 600 secrets.env
docker compose up -d --build
```

Update a source installation with:

```sh
git pull --ff-only
docker compose up -d --build
```

## Exposure

The default mapping exposes host port `11435` on every interface. For local-only access, change it to:

```yaml
ports:
  - "127.0.0.1:11435:11434"
```

Inference remains compatible with Ollama's unauthenticated local API. Keep it on a trusted LAN/VPN or place it behind an authenticated reverse proxy. The maintenance mutation endpoints additionally require their own bearer token. Prevent applications from reaching Ollama directly, or they can bypass scheduler serialization and maintenance pause.

## Exclusive GPU maintenance

For a planned GPU-heavy task, keep the intermediary running and pause scheduling instead of shutting down both services. This gives callers an explicit HTTP 503 response, safely drains any request Ollama has already accepted, fails queued work, unloads the current model, and confirms the unload before declaring the GPU released.

The pause request receives HTTP 202 after its state is persisted. Drain and unload continue asynchronously, so always check maintenance status before starting the external workload.

You can use the **Pause mode** card on `/debug`; enter the separate maintenance token, choose a manual or timed pause, and wait for **GPU released: Yes**. The equivalent API commands are below.

Prompt for the administrative token without putting it in shell history, then start a manual pause:

```sh
read -rsp 'Maintenance token: ' MAINTENANCE_TOKEN; printf '\n'
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/pause \
  -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"exclusive GPU task"}'
```

Use a timed pause only when the task has a reliable upper bound:

```sh
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/pause \
  -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"duration":"4h","reason":"exclusive GPU task"}'
```

`duration` must be greater than zero and no longer than `maintenance.max_pause` (`168h` by default). Its clock starts after drain and confirmed model unload, not when the pause request first arrives.

Check the dashboard or authenticated status snapshot. Start the external workload only when `maintenance.state` is `paused`, `maintenance.gpu_released` is `true`, and `maintenance.unload_error` is null. If unload fails, the intermediary reports `maintenance.state: error`; inspect Ollama and GPU state instead of assuming VRAM was released.

For a workload that needs virtually all VRAM, also confirm host-level allocation with `sudo rocm-smi --showmeminfo vram --showpids`. The intermediary's `gpu_released` assertion proves that Ollama's `/api/ps` is empty; it cannot prove that a failed ROCm process has not left a driver-level allocation behind.

Resume after the other task finishes:

```sh
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/resume \
  -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{}'
unset MAINTENANCE_TOKEN
```

Ollama normally may remain running because the confirmed unload frees its model VRAM. If clients can bypass the intermediary or process-level isolation is required, wait for `gpu_released: true`, run `sudo systemctl stop ollama`, and leave the intermediary online. Run `sudo systemctl start ollama` and verify `curl -fsS http://127.0.0.1:11434/api/tags` before resuming. A manual pause is safest when task duration is uncertain because a timed pause intentionally resumes admission at expiry.
