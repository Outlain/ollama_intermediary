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
ODYSSEUS_SOURCE=
FRIGATE_SOURCE=
```

Fill the source CIDRs only when source-IP client classification is needed. Otherwise configure `X-Ollama-Client` headers or dedicated listeners.

Validate and start:

```sh
docker compose config
docker compose pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:11435/readyz
curl http://127.0.0.1:11435/status
```

The image uses `restart: unless-stopped`, so it returns after Docker or host restarts.

## Upgrade

Download and verify the new release bundle in a temporary directory. Preserve the installed `config.yml` and `secrets.env`, then replace only `docker-compose.yml` with the new release's file:

```sh
cd /opt/ollama-scheduling-proxy
cp /path/to/new-release/docker-compose.yml ./docker-compose.yml
docker compose pull
docker compose up -d
docker compose ps
```

Review changes to `config.example.yml` before adopting new options. Compose recreates the container while retaining local configuration files. In-memory queued inference jobs are intentionally not restored.

## Roll back

Restore the previous release's `docker-compose.yml`, which references an immutable version tag, then run:

```sh
docker compose pull
docker compose up -d
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

The service has no authentication. Keep it on a trusted LAN/VPN or place it behind an authenticated reverse proxy. Prevent applications from reaching Ollama directly, or they can bypass scheduler serialization.
