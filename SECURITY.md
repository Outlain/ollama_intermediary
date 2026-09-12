# Security policy

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue. Use the repository's **Security** tab to open a private security advisory with reproduction details, affected versions, and any suggested mitigation.

The service is intended for trusted LAN or VPN deployment. Its Ollama-compatible inference and model-management routes are intentionally unauthenticated, so it must not be exposed directly to the public internet. Protect it with a firewall or authenticated reverse proxy, and restrict direct access to the underlying Ollama API.

Administrative surfaces use separate bearer credentials:

- `SETTINGS_TOKEN` protects configuration reads and mutations at `/settings` and `/_intermediary/v1/settings`.
- `MAINTENANCE_TOKEN` protects pause and resume mutations.
- `OBSERVABILITY_TOKEN` optionally protects detailed read-only status data.

Do not reuse these tokens. They do not authenticate ordinary Ollama-compatible routes. The settings page retains its credential only in browser-tab session storage, never local storage. Bearer tokens are readable by anyone who can observe unencrypted HTTP traffic, so use the page only over a trusted LAN/VPN or terminate TLS at an authenticated reverse proxy. Keep administrator browser devices and `secrets.env` appropriately restricted.

The settings service intentionally has no Docker socket and cannot write `docker-compose.yml`, `config.yml`, or `secrets.env`. It stores only allowlisted, validated overrides in the state volume at `/app/state/settings.json`; host-managed token values are never returned to the browser. Ollama URLs containing credentials, query strings, or fragments are rejected. Treat the state volume as deployment-sensitive because non-secret settings can still reveal internal hostnames and network layout.

Local deployment files such as `secrets.env` and `config.yml` must never be committed. The repository's publication check and ignore rules enforce this for normal workflows.
