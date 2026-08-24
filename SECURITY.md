# Security policy

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue. Use the repository's **Security** tab to open a private security advisory with reproduction details, affected versions, and any suggested mitigation.

The service is intended for trusted LAN or VPN deployment. It does not provide authentication and should not be exposed directly to the public internet. Protect it with a firewall or authenticated reverse proxy, and restrict direct access to the underlying Ollama API.

Local deployment files such as `secrets.env` and `config.yml` must never be committed. The repository's publication check and ignore rules enforce this for normal workflows.
