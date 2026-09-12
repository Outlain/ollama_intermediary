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
SETTINGS_TOKEN=
MAINTENANCE_TOKEN=
```

The supplied configuration treats every unmatched request as Odysseus, so Odysseus needs no IP setting. Set `FRIGATE_SOURCE` to Frigate's stable IP or CIDR when Frigate is connected. It can remain blank until then.

`OBSERVABILITY_TOKEN` protects the detailed dashboard data and Home Assistant endpoint. Generate a token with `openssl rand -hex 32`, or leave it blank only when port `11435` is restricted to a trusted LAN/VPN.

`SETTINGS_TOKEN` is required to use configuration reads and changes at `/settings`. Generate it separately with `openssl rand -hex 32`. It is intentionally loaded directly from the container environment so it can still authenticate the restricted recovery page when ordinary configuration is invalid.

`MAINTENANCE_TOKEN` is required and protects the state-changing pause/resume API. Generate it with `openssl rand -hex 32`. Keep all three tokens distinct, and never commit them to Git.

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

Open `http://YOUR_UBUNTU_IP:11435/settings` to view or change structured application settings. Enter `SETTINGS_TOKEN`; it is retained only in the current browser tab's session storage.

The image uses `restart: unless-stopped`, so it returns after Docker or host restarts and after a settings apply. A named Docker volume stores both the maintenance pause record and validated settings overrides under `/app/state`; both survive container recreation and upgrades.

## Upgrade

Keep local machine-specific Compose changes in `docker-compose.override.yml`. It is ignored by this repository and Compose loads it automatically alongside the supplied `docker-compose.yml`. The tracked/bundled base file can then receive project updates while the override retains host-specific additions. Always inspect the merged result with `docker compose config`.

For a release-bundle installation, download and verify the new bundle in a temporary directory. Install the new bundled base Compose file and image reference without replacing `config.yml`, `secrets.env`, `docker-compose.override.yml`, or the named state volume:

```sh
cd /opt/ollama-scheduling-proxy
cp /path/to/new-release/docker-compose.yml ./docker-compose.yml
docker compose config
docker compose pull
docker compose up -d
docker compose ps
```

`config.example.yml` is documentation for new installations; do not copy it over an existing `config.yml` during an upgrade. Review its changes and deliberately adopt only options you want. Compose recreates the container while retaining `config.yml`, `secrets.env`, the optional override file, and the named state volume. In-memory queued inference jobs are intentionally not restored.

When upgrading an installation that predates the settings page, add a unique `SETTINGS_TOKEN` to `secrets.env`. The new image can use the existing `/app/state` volume for `/app/state/settings.json`; no second volume is required. Installations predating maintenance pause also need a unique `MAINTENANCE_TOKEN` and the `maintenance:` section from `config.example.yml`. The supplied `${MAINTENANCE_TOKEN:?...}` expression intentionally prevents normal startup with a blank administrative token.

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
git clone https://github.com/Outlain/ollama_intermediary.git
cd ollama_intermediary
cp config.example.yml config.yml
cp secrets.example.env secrets.env
chmod 600 secrets.env
docker compose up -d --build
```

The two `cp` commands above are for a first installation only. Never run them over an existing installation during an upgrade.

For a normal source update, leave `config.yml`, `secrets.env`, and `docker-compose.override.yml` in place:

```sh
cd /opt/ollama_intermediary
git pull --ff-only
docker compose config
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:11435/readyz
```

Those three local deployment files are ignored by Git, and the named state volume is outside the source tree, so the pull does not replace base settings, secrets, saved browser overrides, or maintenance state.

If `git pull` says a locally modified tracked `docker-compose.yml` would be overwritten, preserve that edit while updating:

```sh
cd /opt/ollama_intermediary
git stash push -m "local Compose settings before upgrade" -- docker-compose.yml
git pull --ff-only
git stash pop
docker compose config
docker compose up -d --build
```

If `git stash pop` reports a conflict, do not discard either side. Keep the new project defaults and move only the host-specific values into `docker-compose.override.yml`, then run `docker compose config` again. Even without a conflict, migrating local base-file edits into the ignored override prevents the next pull from stopping. First retain a patch copy of the exact local edit:

```sh
git diff -- docker-compose.yml > /tmp/ollama-intermediary-compose-local.patch
```

A small override looks like this:

```yaml
services:
  ollama-scheduler:
    environment:
      LOG_LEVEL: debug
```

After host-specific values are represented in the ignored override, restore the tracked base file once with `git restore docker-compose.yml`, then run `docker compose config` again and confirm the merged service still contains those values before recreating it. The temporary patch remains available if the override needs correction. Future `git pull --ff-only` updates will then be straightforward. Do not use `cp -f config.example.yml config.yml`, `git reset --hard`, or a whole-tree replacement as an update procedure.

## Exposure

The default mapping exposes host port `11435` on every interface. For local-only access, change it to:

```yaml
ports:
  - "127.0.0.1:11435:11434"
```

Inference remains compatible with Ollama's unauthenticated local API. Keep it on a trusted LAN/VPN or place it behind an authenticated reverse proxy. The settings API and maintenance mutation endpoints additionally require separate bearer tokens, but those tokens do not protect ordinary Ollama routes. Prevent applications from reaching Ollama directly, or they can bypass scheduler serialization and maintenance pause.

## Settings page and configuration recovery

Open `http://YOUR_UBUNTU_IP:11435/settings` and enter `SETTINGS_TOKEN`. The page exposes only structured application settings that the intermediary knows how to validate. It never edits raw YAML, `config.yml`, `secrets.env`, Docker Compose, Docker networks, volumes, ports, or the Docker socket.

The effective configuration is assembled in this order:

1. The operator-managed, read-only `config.yml` provides the base.
2. Validated overrides from `/app/state/settings.json` replace matching editable values.
3. Host-managed tokens remain supplied by `secrets.env`; their values are never sent to the browser.

The page requires validation before apply. A successful apply atomically saves a new revision and the prior last-known-good override, stops new inference admission, gracefully drains an active upstream request, and exits with status 75. Docker's supplied `restart: unless-stopped` policy restarts the service with the new effective configuration. If you deploy without Compose, configure a supervisor such as systemd with `Restart=on-failure`; a foreground process cannot restart itself.

If application configuration is invalid, the intermediary starts a restricted recovery listener on the same container port. In recovery mode:

- `/settings` and `/healthz` remain reachable.
- `/readyz`, `/status`, inference, and model-management routes return HTTP 503.
- Safe, editable application values can be validated and applied from the page.
- Invalid YAML, missing host-only credentials, an invalid `SETTINGS_PATH`, a bad volume mount, or Compose/listener problems must be fixed on the host.

The settings API is locked unless `SETTINGS_TOKEN` exists in the container environment, including during recovery. After changing `secrets.env`, recreate the container so Docker loads the new value:

```sh
docker compose up -d --force-recreate
```

If a value changed in `config.yml` still appears unchanged, it probably has a saved browser override. The settings page displays the effective value and its persisted revision. Reset the relevant override before expecting the base-file value to win.

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
