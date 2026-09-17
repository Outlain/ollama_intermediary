# Optional AMD host telemetry and bounded Ollama recovery

This helper runs **on the Ollama Ubuntu host**, outside Docker. It is optional;
updating the intermediary image does not install it or grant host privileges.
Telemetry and automatic recovery are separately opt-in in the intermediary.
The initial hardware target is an AMD GPU supported by AMD SMI, including the
reported Radeon AI PRO R9700 / AMD SMI 26.2.2 setup. NVIDIA support is not implied.

The only host-control operation implemented is **restart `ollama.service`**.
There is no GPU reset, reboot, driver reload, arbitrary command, remote shell,
arbitrary service selection, or process-kill API. Restarting Ollama interrupts
all of its clients, including clients that bypass the intermediary. Route all
inference through the intermediary and keep its upstream Ollama port private.

## Safety contract

- Unix HTTP socket only: `/run/ollama-intermediary-host/control.sock`, mode 0660.
  Directory mode 0750. Filesystem/group membership is the authorization boundary;
  membership grants recovery control, not just telemetry. No TCP listener or
  additional browser token is used between the intermediary and helper.
- Dedicated unprivileged service account with `render` / `video` access.
  Only fixed read-only AMD SMI and systemd queries are executed for telemetry.
  GPU device permissions themselves are not a hardware read-only sandbox.
- Root-owned helper code/configuration and an exact sudoers rule permitting only
  `/usr/bin/systemctl restart ollama.service`. No Docker socket or privileged
  intermediary container is needed.
- Before restart: fresh device/process data must be known, GPU processes must
  belong to the managed Ollama systemd cgroup, and `KillMode=control-group` is
  required. An unrelated process, partial process list, missing VRAM information,
  changed service identity, corrupt state, or unreadable cgroup stops recovery.
- After restart: the systemd invocation must change; every recorded old worker
  PID/start-time identity must be gone; the new main PID must be in the service
  cgroup. GPU processes must be empty, activity zero, and residual VRAM no more
  than 512 MiB. These checks are in addition to, not a substitute for, the
  intermediary's independent idle samples and empty Ollama model list.
  Raising the intermediary's idle-VRAM threshold does not raise this separate
  helper ceiling; unsupported or higher-baseline hosts require manual review.
- Maximum **two restart dispatches per rolling hour**, minimum **five minutes**
  between dispatches. State and limits survive helper/container/service restarts.
  The intermediary additionally limits an individual recovery incident to **two
  attempts**; neither its per-incident limit nor these independent host limits
  are bypassed by clicking retry.
- A UUID operation ID is durably recorded **before** a restart. Retrying that same
  ID never restarts the service again, even after a timeout or helper crash. An
  uncertain operation stays uncertain until manual recovery; it is not silently
  reissued. Do not delete the helper journal to clear a limit or uncertainty.
- Inactive/unknown GPU telemetry never becomes a fictional zero. Process names
  and per-process VRAM may be unavailable. Reported physical VRAM is distinct from
  Ollama's loaded-model allocation and from CPU-visible VRAM/GTT.

An idle GPU reading by itself does **not** clear the intermediary's recovery
latch. The changed service incarnation and old-worker termination are the
recovery boundary. Manual pause remains a separate state; recovery must not
resume inference while an operator pause is active.

## Install manually on ubuntu-ai

Do not run this on the Frigate host. These commands deliberately install a new
local service and a narrowly scoped privilege rule. Review the files first,
pause inference, and use your normal change window. They do **not** restart
Ollama by themselves; enabling auto-recovery can later do so when required.

1. From an updated repository checkout, verify the host prerequisites:

   ```bash
   cd /opt/ollama_intermediary
   command -v amd-smi
   getent group render
   getent group video
   systemctl show ollama.service --property=ActiveState,InvocationID,MainPID,ControlGroup,KillMode
   ```

   Require a native systemd `ollama.service` with `KillMode=control-group` and a
   readable cgroup-v2 filesystem. This integration does not manage containerized
   Ollama. Record your existing intermediary upstream `ollama.url` from Settings;
   do not substitute the public intermediary port or the Frigate URL.

2. Create the account **only if it does not already exist**:

   ```bash
   sudo useradd --system --user-group --no-create-home \
     --home-dir /nonexistent --shell /usr/sbin/nologin \
     --groups render,video ollama-intermediary-host
   ```

3. Install the reviewed helper and service definition:

   ```bash
   sudo install -d -o root -g root -m 0755 /opt/ollama-intermediary-host
   sudo install -o root -g root -m 0644 integrations/host/host_helper.py /opt/ollama-intermediary-host/host_helper.py
   sudo install -o root -g root -m 0644 integrations/host/ollama-intermediary-host.service /etc/systemd/system/ollama-intermediary-host.service
   sudo visudo -cf integrations/host/ollama-intermediary-host.sudoers
   sudo install -o root -g root -m 0440 integrations/host/ollama-intermediary-host.sudoers /etc/sudoers.d/ollama-intermediary-host
   sudo visudo -c
   ```

   If any sudoers validation fails, stop and correct it before continuing. Do
   not broaden the rule to `systemctl *` or passwordless arbitrary `sudo`.

4. For a **new installation**, copy the environment template once:

   ```bash
   sudo install -o root -g root -m 0640 integrations/host/host-helper.env.example /etc/ollama-intermediary-host.env
   sudoedit /etc/ollama-intermediary-host.env
   ```

   Set `MANAGED_OLLAMA_ORIGIN` to the **exact** origin used as the intermediary's
   upstream `ollama.url`, including its scheme, host spelling and port, e.g.
   `http://192.0.2.10:11434` (documentation address; replace it). An origin mismatch
   blocks automatic recovery. Do not use `http://...:11435` or an `/api` suffix.
   Set `AMD_SMI_PATH` to the absolute installed root-owned `amd-smi` path discovered
   in step 1. The default is `/opt/rocm/bin/amd-smi`.
   On later updates, preserve this configured file instead of copying the template.

5. Check that the dedicated user can read GPU data without sudo, then start only
   the helper. Use your actual AMD SMI path in the first two commands:

   ```bash
   sudo -u ollama-intermediary-host /opt/rocm/bin/amd-smi metric --mem-usage --usage --temperature --power --json
   sudo -u ollama-intermediary-host /opt/rocm/bin/amd-smi process --json
   sudo systemctl daemon-reload
   sudo systemctl enable --now ollama-intermediary-host.service
   sudo curl --unix-socket /run/ollama-intermediary-host/control.sock http://localhost/v1/status
   ```

   Expect `protocol: "ollama-intermediary-host-v1"`, correct
   `managed_ollama_origin`, `service.active: true`, and `telemetry.available: true`.
   Per-GPU `processes_known` must be true for automatic recovery. If a command
   requires additional access, investigate the driver/device/cgroup permissions;
   do not run the whole helper as root or give it unrestricted sudo.

6. Give only the intermediary container access to the helper socket:

   ```bash
   getent group ollama-intermediary-host
   ```

   Use that group's numeric GID as `HOST_HELPER_GID` in your Compose interpolation
   environment (normally the existing `.env` next to Compose, **not** only a
   container `env_file`). Merge the fragment in
   [`compose.host-helper.example.yml`](compose.host-helper.example.yml) into your
   existing deployment, or save it as an additional Compose file and consistently
   pass both `-f` arguments on all future Compose commands. Preserve existing
   settings, secrets, state volumes, ports and restrictions.

   The bind is the **directory**, read-only, so a helper restart can replace its
   socket without leaving the container attached to an obsolete socket inode.
   A read-only bind still permits connecting to the Unix socket; it prevents the
   container from replacing it. On host reboot, start the helper before recreating
   the container; a missing directory must not become a root-owned Docker-created
   directory. The supplied service preserves it across helper restarts. If the
   runtime directory was recreated, recreate the intermediary
   container as well so its bind refers to the current directory.

   Validate your merged Compose file, then recreate only `ollama-scheduler` with
   your normal workflow. Do not run `down -v`. A restart alone does not apply new
   socket mounts, supplementary groups or container environment variables.

7. In the intermediary's Settings, first verify host telemetry is enabled and
   shows fresh physical VRAM separately from Ollama models. Then enable automatic
   recovery in Settings. The Compose example deliberately leaves it off until
   these checks pass. Saved browser settings can override environment defaults.
   Do not deliberately crash the GPU to test recovery. Use the existing recovery
   workflow if already locked; otherwise leave it enabled for future incidents.

## Update, disable and rollback

Updating the intermediary container alone does not update this helper. Review and
reinstall only the root-owned Python/service/sudoers files from step 3, preserve
the configured environment and `/var/lib/ollama-intermediary-host/state.json`,
then run `sudo systemctl daemon-reload` and
`sudo systemctl restart ollama-intermediary-host.service`. This restarts the
helper, **not Ollama**. Avoid doing this during a recovery operation; interruption
can deliberately leave that operation uncertain instead of risking a second restart.

To turn off automatic restarts, disable automatic recovery in intermediary
Settings. Telemetry can remain enabled. To fully remove access, disable both
features, remove only the optional socket/group/env additions from Compose, and
recreate the intermediary container. Stop/disable the helper with
`sudo systemctl disable --now ollama-intermediary-host.service`. Removing its exact
sudoers file additionally revokes restart authority; preserve the journal for
audit and safe rollback. No recordings, Frigate configuration or backlog data is
stored in this helper.

## API / limits

`GET /v1/status` returns protocol, collection-start `sampled_at`, exact managed
origin, systemd service identity, telemetry, and restart-policy availability.
Systemd identity is checked before and after telemetry collection; a change
makes the sample unavailable. Unknown values are `null`, not zero. All metric
numbers are normalized to bytes, percent, degrees C and watts.

`POST /v1/ollama/restart` accepts exactly:

```json
{"operation_id":"11111111-1111-4111-8111-111111111111","expected_invocation_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Normal response fields are `operation_id`, `state` (`completed`, `failed`, or
`uncertain`), `before_invocation_id`, `after_invocation_id`, `restarted`, and an
optional safe `error` code. `restarted:false` on an **uncertain** response does
not prove no restart occurred; it means completion of the command was not
observed. Callers must retain/replay the same UUID and expected identity after
transport errors. Never manufacture a new UUID merely because a call timed out.

Socket requests are serialized. Commands have bounded time and output (2 seconds
per service query, 4 seconds per AMD diagnostic, 45 seconds for restart, 1 MiB
aggregate stdout/stderr); HTTP bodies
are limited to 2 KiB. Status may take up to roughly 12 seconds on a slow host;
clients should use bounded timeouts and label old samples stale. An uncertain
restart is never inferred successful from the HTTP status alone. The journal
retains up to 100,000 operation IDs without silently dropping idempotency history;
reaching that bound stops further mutations for operator maintenance.

## Validation

```bash
python3 -m unittest discover -s integrations/host -p 'test_*.py' -v
```

Tests use mocked AMD/systemd data, temporary files and local Unix sockets; no
sudo, real Ollama restart or GPU mutation is performed. They cover recorded idle
R9700 readings, current/26.x AMD JSON shapes, unknown fields, cgroup ownership,
service-epoch changes, surviving old workers, restart limits, crash-safe UUID
replay, corrupted state, socket mode, request bounds and command timeouts.

References: [AMD SMI CLI](https://rocm.docs.amd.com/projects/amdsmi/en/latest/how-to/amdsmi-cli-tool.html),
[AMD CLI JSON process implementation](https://github.com/ROCm/amdsmi/blob/amd-mainline/amdsmi_cli/amdsmi_commands.py),
[systemd KillMode](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html),
[systemd InvocationID](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html).
