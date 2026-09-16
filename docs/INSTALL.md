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

Use a tag actually published at [Outlain/ollama_intermediary releases](https://github.com/Outlain/ollama_intermediary/releases), replacing the example `v1.0.0`. A version bump in source does not publish a container by itself:

```sh
mkdir -p /tmp/ollama-scheduler-install
cd /tmp/ollama-scheduler-install

gh release download v1.0.0 \
  --repo Outlain/ollama_intermediary \
  --pattern 'ollama-scheduling-proxy-v1.0.0-linux-amd64.tar.gz*'

sha256sum -c ollama-scheduling-proxy-v1.0.0-linux-amd64.tar.gz.sha256
tar -xzf ollama-scheduling-proxy-v1.0.0-linux-amd64.tar.gz
sudo mv ollama-scheduling-proxy-v1.0.0-linux-amd64 /opt/ollama_intermediary
sudo chown -R "$USER":"$USER" /opt/ollama_intermediary
cd /opt/ollama_intermediary

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

The image uses `restart: unless-stopped`, so it returns after Docker or host restarts and after a settings apply. A named Docker volume stores maintenance state, validated settings overrides, and the optional Frigate backlog under `/app/state`; they survive container recreation and upgrades. Container logs rotate at 10 MiB across three files.

## Upgrade

Keep local machine-specific Compose changes in `docker-compose.override.yml`. It is ignored by this repository and Compose loads it automatically alongside the supplied `docker-compose.yml`. The tracked/bundled base file can then receive project updates while the override retains host-specific additions. Always inspect the merged result with `docker compose config`.

For a release-bundle installation, download and verify the new bundle in a temporary directory. Install the new bundled base Compose file and image reference without replacing `config.yml`, `secrets.env`, `docker-compose.override.yml`, or the named state volume:

```sh
cd /opt/ollama_intermediary
cp /path/to/new-release/docker-compose.yml ./docker-compose.yml
docker compose config
docker compose pull
docker compose up -d
docker compose ps
```

`config.example.yml` is documentation for new installations; do not copy it over an existing `config.yml` during an upgrade. Review its changes and deliberately adopt only options you want. Compose recreates the container while retaining `config.yml`, `secrets.env`, the optional override file, and the named state volume. In-memory queued inference jobs are intentionally not restored; durable Frigate IDs and retry state are restored. Do not run `docker compose down -v` during an update.

Upgrade while idle, or first pause from `/debug` and wait for the active request to drain. Container replacement has a finite stop grace period and is not a safe way to interrupt a long-running GPU request. A persisted maintenance pause remains paused after the update until you resume it.

Version 1.1 defaults to strict Odysseus priority, even when an older config has no `scheduler.mode`. Choose `balanced` explicitly in Settings only if you want the previous aging, maximum-wait promotion, and affinity behavior. Existing connection settings and secrets are not reset. Frigate recovery is disabled until you configure and enable it.

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

Pause the intermediary and wait until no inference/management request is active. Restart Ollama if needed. If `rocm-smi` still shows an `UNKNOWN` process retaining substantial VRAM, reboot the host. Once physical GPU memory is clean and `ollama ps` is empty, acknowledge the recovery using the separate maintenance credential. The endpoint requires maintenance to remain paused and independently checks the current loaded-model list:

```sh
read -rsp 'Maintenance token: ' MAINTENANCE_TOKEN; printf '\n'
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/recovery/acknowledge \
  -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"confirm_gpu_recovered":true}'
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/resume \
  -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{}'
unset MAINTENANCE_TOKEN
curl http://127.0.0.1:11435/readyz
```

Acknowledgment does not reset hardware and does not resume inference by itself. The separate resume command above deliberately reopens admission only after the acknowledgment succeeds. Run these commands one at a time and stop if acknowledgment returns an error.

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
docker compose config --quiet
INTERMEDIARY_BUILD="$(git rev-parse --short HEAD)" docker compose build ollama-scheduler
docker compose up -d --no-deps ollama-scheduler
docker compose ps
curl -fsS http://127.0.0.1:11435/readyz
```

Those three local deployment files are ignored by Git, and the named state volume is outside the source tree, so the pull does not replace base settings, secrets, saved browser overrides, or maintenance state.

The build argument labels the running source build in the status snapshot. `docker compose config --quiet` validates without printing resolved secret values; if inspecting the full merged Compose output, do not paste its environment values publicly.

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

The page requires validation before apply. A successful apply atomically saves a new revision and the prior last-known-good override, stops new inference admission, waits for dispatched work to finish before shutdown, and exits with status 75. Docker's supplied `restart: unless-stopped` policy restarts the service with the new effective configuration. If you deploy without Compose, configure a supervisor such as systemd with `Restart=on-failure`; a foreground process cannot restart itself.

## Enable Frigate object and review recovery

1. Keep Frigate's Ollama provider pointed at this intermediary. Verify live requests are identified as `frigate` before enabling recovery.
2. Set `FRIGATE_URL` in `secrets.env` to the reachable Frigate origin (for example `https://YOUR_FRIGATE_HOST:8971`, without `/api`). Supply `FRIGATE_USERNAME` and `FRIGATE_PASSWORD`, or `FRIGATE_AUTH_TOKEN`, for an administrator-capable connection. Use trusted TLS, and do not put credentials into the URL or UI.
3. Recreate the intermediary after environment changes: `docker compose up -d --force-recreate ollama-scheduler`. Do this at an idle/paused boundary.
4. Open `/settings`, enable Frigate recovery, and validate/apply. Normal discovery starts at enablement, not weeks of old history. Retained connection settings and the existing state volume are reused.
5. Confirm the dashboard reports both object and review API capabilities. Review regeneration requires a Frigate build exposing the individual review regeneration API; Frigate 0.18 lacks it, while the targeted development build `0.19.0-bb6c2e9` includes it.
6. Test one retained object and one ended review. Check that the descriptions actually appear in Frigate; an accepted API request is not yet success. Then use **Fill missing descriptions** only if you want to include older retained items.

Catch-up respects current per-camera settings, works newest-first behind live requests, and stores IDs/state rather than images. Frigate must still retain the appropriate snapshots/recordings. Missing media and deleted events are reported rather than reconstructed. The existing live HTTP queue can still time out; the durable backlog provides a later regeneration path instead of holding each connection open for hours.

Check camera warnings before enabling a large historical scan. Object recovery excludes early-trigger-only cameras because retained events do not reveal whether their significant-update trigger fired; it does not change those Frigate settings. The final fresh description check avoids ordinary duplicate work, but Frigate provides no atomic no-overwrite guarantee against a separate live/manual completion. A full backlog pauses discovery without discarding queued items; newest-first ordering covers discovered jobs ready to run, not items still waiting to be discovered.

The backlog is tied to the configured Frigate server address. Changing its host, port, or HTTP/HTTPS scheme stops catch-up with `backlog_origin_changed`; it does not erase the old jobs or send their IDs to a different server. Restore the original address to resume that backlog. For an intentional server migration, disable catch-up and configure a different persistent `frigate.state_path` on the host before re-enabling, keeping the old state file intact. Discovery starts anew; **Fill missing descriptions** can rediscover retained work on the new address. Prefer stable DNS or a reserved IP to avoid unnecessary migrations.

See the [README catch-up section](../README.md#frigate-description-catch-up) for timing limits and the [Home Assistant optional sensors/action](HOME_ASSISTANT.md) for quick-view controls. Production API permissions, media availability, and GPU stability still need verification on your actual deployment.

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
