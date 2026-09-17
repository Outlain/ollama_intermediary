# Optional native Frigate completion bridge

This is a **custom, derived Frigate image**, not an official Frigate release.
It supports the exact Python sources at Frigate commit
[`bb6c2e9`](https://github.com/blakeblackshear/frigate/tree/bb6c2e9).
It does not change camera settings, prompts, model options, recordings, or the
Frigate database schema. Keep your original image for rollback.

## Why this is needed

Stock Frigate accepts a regeneration request asynchronously. It does not tell
the intermediary which subsequent Ollama request belongs to that regeneration,
or when generation fails before saving a description. Guessing from timing
could confuse a live request with a catch-up request.

The bridge carries a fresh, secret attempt ticket through the existing native
object and review processing paths. It labels the associated Ollama requests
and reports when the **whole native generation attempt** has finished. A valid
result handed to Frigate's save path is reported as success; the intermediary
still independently confirms that the description was actually saved.
These attempt tickets are generated automatically; they are not another token
you need to create, enter in the dashboard, or add to `secrets.env`.

This allows the intermediary to start another eligible generation while an
earlier result is being checked, without starting two Ollama inferences at once.
The intermediary remains responsible for queue priority, GPU serialization,
pause/drain, retries, and bounded pending confirmations. Merely installing this
image does not increase Ollama concurrency or fix a context-size HTTP 400.

## Build without changing your running Frigate

Do this on the **Frigate Docker host**, using a checkout of this repository that
contains this folder. The intermediary host does not need to build Frigate.

1. Record your current image and its immutable digest:

   ```bash
   docker inspect frigate --format '{{.Config.Image}}'
   docker inspect frigate --format '{{.Image}}'
   ```

   Run this using the image ID printed by the second command:

   ```bash
   docker image inspect IMAGE_ID_FROM_ABOVE --format '{{json .RepoDigests}}'
   ```

2. Use the appropriate `repository@sha256:...` digest from that output as the
   base. Preserve your existing hardware variant. **Do not substitute a moving
   `dev` or `stable` tag, or invent a tag from the version shown in the UI.**

   From the intermediary repository root:

   ```bash
   docker build \
     --build-arg FRIGATE_BASE_IMAGE='YOUR_EXISTING_REPOSITORY@sha256:YOUR_DIGEST' \
     -t frigate-intermediary:bb6c2e9-v1 \
     integrations/frigate
   ```

   The build verifies SHA-256 hashes of **all seven affected upstream files**
   before changing any of them. Another build, an already patched image, or a
   mismatched source refuses to build. Do not bypass this check: a newer Frigate
   source requires a reviewed, separately tested bridge revision.

3. The image is prepared but your running container has not changed. Back up
   Frigate's configuration and database using your normal procedure before
   scheduling a restart. Do not remove media/configuration volumes.

## Enable during a deliberate Frigate update

First update the intermediary to a version supporting this bridge. Pause
intermediary inference and allow active work to drain before restarting either
service. Editing/recreating Frigate briefly interrupts its camera processing.

In **your existing Frigate Compose service**, change only its image and add the
environment entry below. Preserve all existing ports, devices, volumes, shared
memory, credentials, and other settings. This is a fragment, not a replacement
Compose file:

```yaml
services:
  frigate:
    image: frigate-intermediary:bb6c2e9-v1
    environment:
      FRIGATE_INTERMEDIARY_BRIDGE: "1"
```

If your environment uses list syntax, add
`- FRIGATE_INTERMEDIARY_BRIDGE=1` to its existing list instead. In Portainer,
make these edits in the existing Frigate stack/container configuration.

The Ollama **description provider** must already point to the intermediary's
origin, e.g. `http://intermediary.lan:11435`, not directly to Ollama. The bridge
supports HTTP/HTTPS origins only, with no path prefix, embedded credentials,
query, or fragment. It does not change that provider setting for you.

Validate your Frigate Compose file, then recreate only that service using your
normal deployment workflow. Resume inference after both services are healthy.
The bridge defaults to **disabled** if the environment entry is absent.

## Verify

On the trusted internal, unauthenticated Frigate API used by this deployment:

```bash
curl -fsS http://frigate.lan:5000/api/intermediary/capabilities
```

Expected when enabled with an Ollama description provider:

```json
{"protocol":"ollama-intermediary-v1","object":true,"review":true,"completion_reports":true}
```

On an authenticated Frigate API, use an existing **admin** session; the endpoint
does not bypass Frigate authorization. An unpatched image returns 404. A patched
but disabled/unsupported configuration returns the protocol with false flags.
Neither should be interpreted as native completion support.

Do not expose Frigate's unauthenticated port 5000 publicly. The intermediary
must also be reachable from the Frigate container for inference and completion
reports. If a report is lost, the intermediary retains its conservative
timeout/reconciliation behavior; a capability response is not proof that every
callback can reach it.

## Protocol and safety

- Capability endpoint: admin-protected `GET /api/intermediary/capabilities`.
- Existing regeneration endpoints accept an optional
  `X-Ollama-Intermediary-Attempt` header: exactly 64 lowercase hexadecimal
  characters. Invalid tickets are rejected; tagged requests are rejected while
  the bridge is disabled or the description provider is not supported.
- The ticket travels explicitly through object metadata IPC, review IPC, and
  review threads. Live requests receive no catch-up ticket.
- An HTTPX request hook injects the scoped ticket only into POST
  `/api/generate` or `/api/chat` requests to the configured provider origin.
  It does not mutate shared client headers, and strips stale tickets on other
  requests/destinations. Model probes are not inference evidence.
- The review regeneration thread waits for its own native analysis child;
  normal live analysis remains asynchronous. Native success is marked only
  after a valid result is handed to Frigate's existing save/update path.
- Completion is posted to the configured provider origin plus
  `/_intermediary/v1/frigate/attempt`, with the same ticket header and
  `{"outcome":"success"|"failed","reason":"safe_enum"}`. No user-supplied
  callback URL, general API credential, prompt, description, or image is sent.
- Callbacks never follow redirects. They make at most three attempts with a
  two-second network timeout and short increasing delays. Missing/rejected
  reports never trigger an automatic second native generation inside Frigate.
- The bridge does not log ticket values or callback payloads. Existing Frigate
  logging remains unchanged; do not enable verbose prompt logging unnecessarily.
- There is no durable bridge job database. Restarts and lost callbacks require
  conservative intermediary reconciliation rather than guessed completion.

## Rollback

Restore the original Frigate image reference recorded above, remove/disable
`FRIGATE_INTERMEDIARY_BRIDGE`, and recreate only Frigate during a planned restart.
Do not delete volumes. The intermediary must detect native capabilities afresh
and use its conservative stock-Frigate path. Outstanding attempts may need their
normal reconciliation timeout after a restart; never force them complete just
because the image changed.

## Development tests

No Docker daemon, Frigate instance, camera images, model, or network is needed
for the standalone bridge tests:

```bash
python3 -m unittest discover -s integrations/frigate -p 'test_*.py' -v
```

For exact-source integration tests, download the seven files listed in
`apply_bridge.HASHES` from the official `bb6c2e9` source into an isolated folder
as `0.py` through `6.py` in that dictionary's order, then run:

```bash
FRIGATE_BRIDGE_SOURCE_FIXTURES=/path/to/isolated/source-fixtures \
  python3 -m unittest discover -s integrations/frigate -p 'test_*.py' -v
```

These tests compile every transformed file and execute the transformed native
object/review API, IPC, media, thread, provider, and save paths with controlled
stubs. They verify identity propagation, premature-completion prevention,
invalid-output/media failures, thread isolation, callback limits, and safety.
They are not a substitute for a staged smoke test with the actual derived image.
