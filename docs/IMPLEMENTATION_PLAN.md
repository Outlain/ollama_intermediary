# Intermediary reliability and Frigate catch-up

Implementation target: Frigate `0.19.0-bb6c2e9`, with capability checks rather
than assuming a version number guarantees an API. Existing operator config,
credentials, media, and Docker overrides must not be replaced.

## Agreed behavior

- Odysseus first, then live Frigate, then background catch-up. Never preempt an
  already running GPU request. Respect the configured Odysseus idle hold (1m in
  the example). Arbitrary model names continue to work.
- Automatic discovery starts at first enablement. A protected "Fill missing
  descriptions" action scans retained history, respecting Frigate settings.
- Persist metadata-only object and review jobs, merged newest-event-first.
  Frigate retains and reads the media; no image copies in the intermediary.
- Skip descriptions already present at the final fresh check. Frigate cannot
  atomically exclude a concurrent live/manual completion between check and PUT.
  Confirm completion in Frigate after
  an accepted regeneration request. Retry transient errors with backoff;
  explain expired/missing media without retrying it forever.
- Frigate does not identify regenerated inference separately from live
  inference. Start only one background handoff when otherwise idle; work
  already handed to Frigate cannot be preempted or reliably relabeled.
- Settings UI for ordinary configuration; secrets.env for credentials. Manual
  pause also stops catch-up; normal camera recording/detection stays in Frigate.

## Workstreams

1. Strict scheduling, bounded queue memory/metrics, safe endpoint classification.
2. Stream outcome handling, downstream closure, persistent GPU recovery latch,
   consistent status authorization, safe settings restart.
3. Durable Frigate client/discovery/eligibility/retry/reconciliation subsystem.
4. Configuration validation, settings and dashboard controls, status/HA fields.
5. Mock integration/regression tests, browser verification, deployment and HA
   documentation. Live camera/GPU verification still requires the user's host.

## Safety boundaries

No GPU driver reset, Docker socket, arbitrary Compose editor, or automatic
Frigate modification. A healthy metadata endpoint does not prove GPU health.
Recovery acknowledgment requires an operator to verify the real GPU, and is
separate from ordinary pause/resume. Development Frigate behavior may change.

## Completion checks

- Test strict priority/leases, failed and interrupted streams, maintenance,
  restart preservation, auth and redaction, queue bounds, both regeneration
  APIs, discovery boundaries, pagination, persistence, missing media, retries.
- Show build identity, backlog state and failures without prompts or images.
- Document upgrading without replacing settings/secrets/state and distinguish
  automated mock verification from unperformed live Frigate/ROCm tests.

## Verification performed

- Automated unit and local mock HTTP integration checks cover both native APIs,
  restart persistence, eligibility changes during tracking, strict scheduling,
  interrupted streams, recovery/management races, authorization and UI contracts.
- Isolated headless Chrome checks passed at desktop, 390px and 320px widths.
  No real credentials or camera data were used.
- Deployment/publication checks run locally. Live Frigate, Docker deployment,
  AMD GPU health and Home Assistant still require the operator's environment.
