# Home Assistant quick-view dashboard

The intermediary exposes one stable JSON snapshot for Home Assistant, plus authenticated pause/resume controls and an optional historical Frigate missing-description scan:

```text
http://UBUNTU_IP:11435/_intermediary/v1/status
```

Use the Ubuntu host's LAN address. `127.0.0.1` is correct only when Home Assistant shares the intermediary's network namespace. The configuration below uses one shared REST request every five seconds for all entities.

## 1. Store the bearer tokens

Add the configured tokens from the intermediary's `secrets.env` to Home Assistant's `/config/secrets.yaml`:

```yaml
ollama_intermediary_authorization: "Bearer PASTE_THE_TOKEN_HERE"
ollama_intermediary_maintenance_authorization: "Bearer PASTE_THE_DIFFERENT_MAINTENANCE_TOKEN_HERE"
# Optional: only needed for the historical Frigate scan action below.
ollama_intermediary_settings_authorization: "Bearer PASTE_THE_SEPARATE_SETTINGS_TOKEN_HERE"
```

The word `Bearer` is required. The first value is `OBSERVABILITY_TOKEN`; if that intermediary token is blank, omit the `Authorization` header from the REST snapshot below. The second value is the required, separate `MAINTENANCE_TOKEN`. The optional third value is `SETTINGS_TOKEN`; it also authorizes broader intermediary configuration access, so restrict the Home Assistant account/actions that can use it. Never reuse the read-only observability credential for administrative control. Home Assistant secrets prevent accidental publication but are not encrypted at rest.

## 2. Add the REST entities

Add this entry to `/config/configuration.yaml`, replacing `UBUNTU_IP`. If the file already contains a top-level `rest:` section, append the `- resource:` entry beneath it instead of adding a second `rest:` key.

```yaml
rest:
  - resource: "http://UBUNTU_IP:11435/_intermediary/v1/status"
    method: GET
    scan_interval: 5
    timeout: 4
    headers:
      Accept: "application/json"
      Authorization: !secret ollama_intermediary_authorization

    sensor:
      - name: "Ollama Intermediary State"
        unique_id: ollama_intermediary_state
        icon: mdi:router-network
        value_template: >-
          {{ (value_json.get('scheduler') or {}).get('state')
             | default('unknown', true) }}

      - name: "Ollama Maintenance State"
        unique_id: ollama_maintenance_state
        icon: mdi:pause-circle-outline
        value_template: >-
          {{ (value_json.get('maintenance') or {}).get('state')
             | default('unknown', true) }}

      - name: "Ollama Maintenance Remaining"
        unique_id: ollama_maintenance_remaining
        icon: mdi:timer-pause-outline
        device_class: duration
        unit_of_measurement: "s"
        state_class: measurement
        value_template: >-
          {{ (((value_json.get('maintenance') or {}).get('remaining_seconds'))
              or 0) | float(0) | round(1) }}

      - name: "Ollama Backend State"
        unique_id: ollama_backend_state
        icon: mdi:server
        value_template: >-
          {{ (value_json.get('backend') or {}).get('state')
             | default('unknown', true) }}

      - name: "Ollama Current Model"
        unique_id: ollama_current_model
        icon: mdi:brain
        value_template: >-
          {{ (value_json.get('scheduler') or {}).get('current_model')
             | default('none', true) }}

      - name: "Ollama Active Client"
        unique_id: ollama_active_client
        icon: mdi:account-network
        value_template: >-
          {{ (value_json.get('active_request') or {}).get('client')
             | default('idle', true) }}

      - name: "Ollama Active Model"
        unique_id: ollama_active_model
        icon: mdi:brain
        value_template: >-
          {{ (value_json.get('active_request') or {}).get('model')
             | default('idle', true) }}

      - name: "Ollama Active Request Type"
        unique_id: ollama_active_request_type
        icon: mdi:message-processing
        value_template: >-
          {{ (value_json.get('active_request') or {}).get('type')
             | default('idle', true) }}

      - name: "Ollama Active Request Runtime"
        unique_id: ollama_active_request_runtime
        icon: mdi:timer-outline
        device_class: duration
        unit_of_measurement: "s"
        state_class: measurement
        value_template: >-
          {{ (((value_json.get('active_request') or {}).get('running_seconds'))
              or 0) | float(0) | round(1) }}

      - name: "Ollama Queued Requests"
        unique_id: ollama_queued_requests
        icon: mdi:tray-full
        unit_of_measurement: "requests"
        state_class: measurement
        value_template: >-
          {{ (value_json.get('queue') or {}).get('total') | int(0) }}

      - name: "Ollama Odysseus Queue"
        unique_id: ollama_odysseus_queue
        icon: mdi:alpha-o-box-outline
        unit_of_measurement: "requests"
        state_class: measurement
        value_template: >-
          {{ (((value_json.get('queue') or {}).get('by_client') or {})
              .get('odysseus')) | int(0) }}

      - name: "Ollama Frigate Queue"
        unique_id: ollama_frigate_queue
        icon: mdi:cctv
        unit_of_measurement: "requests"
        state_class: measurement
        value_template: >-
          {{ (((value_json.get('queue') or {}).get('by_client') or {})
              .get('frigate')) | int(0) }}

      - name: "Ollama Oldest Queue Wait"
        unique_id: ollama_oldest_queue_wait
        icon: mdi:timer-sand
        device_class: duration
        unit_of_measurement: "s"
        state_class: measurement
        value_template: >-
          {{ ((value_json.get('queue') or {}).get('oldest_wait_seconds')
              or 0) | float(0) | round(1) }}

      - name: "Ollama Model Switches"
        unique_id: ollama_model_switches
        icon: mdi:swap-horizontal
        unit_of_measurement: "switches"
        state_class: total_increasing
        value_template: >-
          {{ (value_json.get('scheduler') or {}).get('model_switches')
             | int(0) }}

      # Optional Frigate catch-up sensors: keep these under this same shared
      # REST resource, not a second resource with another polling loop.
      - name: "Ollama Frigate Recovery State"
        unique_id: ollama_frigate_recovery_state
        icon: mdi:cctv
        value_template: >-
          {{ (value_json.get('frigate') or {}).get('state')
             | default('disabled', true) }}

      - name: "Ollama Frigate Pending Descriptions"
        unique_id: ollama_frigate_pending_descriptions
        icon: mdi:playlist-clock
        unit_of_measurement: "descriptions"
        state_class: measurement
        value_template: >-
          {% set counts = (value_json.get('frigate') or {}).get('counts') or {} %}
          {{ (counts.get('pending', 0) | int(0))
             + (counts.get('waiting_live', 0) | int(0))
             + (counts.get('waiting_result', 0) | int(0))
             + (counts.get('retrying', 0) | int(0)) }}

      - name: "Ollama Frigate Lifetime Completed Descriptions"
        unique_id: ollama_frigate_completed_descriptions
        icon: mdi:check-all
        unit_of_measurement: "descriptions"
        state_class: total_increasing
        value_template: >-
          {{ (((value_json.get('frigate') or {}).get('totals') or {})
              .get('completed')) | int(0) }}

      - name: "Ollama Frigate Lifetime Skipped Descriptions"
        unique_id: ollama_frigate_skipped_descriptions
        icon: mdi:skip-next-circle-outline
        unit_of_measurement: "descriptions"
        state_class: total_increasing
        value_template: >-
          {{ (((value_json.get('frigate') or {}).get('totals') or {})
              .get('skipped')) | int(0) }}

    binary_sensor:
      - name: "Ollama Intermediary Ready"
        unique_id: ollama_intermediary_ready
        device_class: running
        value_template: >-
          {{ ((value_json.get('service') or {}).get('ready', false))
             | bool(false) }}

      - name: "Ollama Backend Reachable"
        unique_id: ollama_backend_reachable
        device_class: connectivity
        value_template: >-
          {{ ((value_json.get('backend') or {}).get('reachable', false))
             | bool(false) }}

      - name: "Ollama GPU Recovery Required"
        unique_id: ollama_gpu_recovery_required
        device_class: problem
        value_template: >-
          {{ ((value_json.get('backend') or {}).get('recovery_required', false))
             | bool(false) }}

      - name: "Ollama Upstream Draining"
        unique_id: ollama_upstream_draining
        device_class: running
        value_template: >-
          {{ ((value_json.get('scheduler') or {}).get('upstream_draining', false))
             | bool(false) }}

      - name: "Ollama Maintenance Paused"
        unique_id: ollama_maintenance_paused
        icon: mdi:pause-octagon
        value_template: >-
          {{ ((value_json.get('maintenance') or {}).get('paused', false))
             | bool(false) }}

      - name: "Ollama GPU Released For Maintenance"
        unique_id: ollama_gpu_released_for_maintenance
        icon: mdi:memory-arrow-down
        value_template: >-
          {{ ((value_json.get('maintenance') or {}).get('gpu_released', false))
             | bool(false) }}
```

## 3. Add pause/resume actions

Add this separate top-level block to `/config/configuration.yaml`, replacing `UBUNTU_IP`. If `rest_command:` already exists, add these three entries beneath it instead of creating a second key.

```yaml
rest_command:
  ollama_intermediary_pause:
    url: "http://UBUNTU_IP:11435/_intermediary/v1/maintenance/pause"
    method: POST
    headers:
      Authorization: !secret ollama_intermediary_maintenance_authorization
    content_type: "application/json"
    payload: '{"reason":"Home Assistant manual pause"}'
    timeout: 30

  ollama_intermediary_pause_4h:
    url: "http://UBUNTU_IP:11435/_intermediary/v1/maintenance/pause"
    method: POST
    headers:
      Authorization: !secret ollama_intermediary_maintenance_authorization
    content_type: "application/json"
    payload: '{"duration":"4h","reason":"Home Assistant timed pause"}'
    timeout: 30

  ollama_intermediary_resume:
    url: "http://UBUNTU_IP:11435/_intermediary/v1/maintenance/resume"
    method: POST
    headers:
      Authorization: !secret ollama_intermediary_maintenance_authorization
    content_type: "application/json"
    payload: '{}'
    timeout: 30

  # Optional; requires Frigate catch-up to be configured and enabled.
  ollama_intermediary_frigate_scan:
    url: "http://UBUNTU_IP:11435/_intermediary/v1/frigate/scan"
    method: POST
    headers:
      Authorization: !secret ollama_intermediary_settings_authorization
    content_type: "application/json"
    payload: '{"confirm":true}'
    timeout: 30
```

The pause command returns HTTP 202 after the pause record is safely stored; draining and unload continue in the background. The timed interval begins only after the intermediary confirms GPU release. A manual pause has no expiry; use it when the external task's duration is uncertain. New inference receives HTTP 503 while paused. When Frigate catch-up is configured, eligible missing descriptions can be discovered and regenerated after resuming, subject to media retention and API support; original HTTP connections are not kept open for hours.

The optional scan action finds retained items missing descriptions and skips results already present at the final fresh check. Frigate lacks an atomic generate-if-missing operation, so an independent live/manual completion can still race the regeneration request. The scan does not start unrestricted GPU work: discovered eligible jobs share a newest-first durable backlog behind Odysseus and live Frigate. A full backlog pauses discovery, so ordering applies only to discovered jobs ready to run.

The pending sensor includes items waiting for live results, queued recovery, accepted regenerations awaiting results, and delayed retries. Completed/skipped sensors read persistent lifetime totals; skipped can include expired media, deleted events, or items no longer eligible. Check the intermediary dashboard's recent jobs, early-trigger-only camera warnings, capacity warnings, and degraded/error state for details. Normal first enablement starts from that moment forward; only the explicit scan includes earlier history.

Before starting the other GPU task, require `sensor.ollama_maintenance_state` to read `paused` and `binary_sensor.ollama_gpu_released_for_maintenance` to be `on`. An `error` state or a released sensor that remains off means the unload was not confirmed.

Keep these REST commands and their dashboard buttons limited to trusted Home Assistant administrators. The button confirmation prevents an accidental tap, but it is not an authorization boundary; Home Assistant holds the administrative token and sends it on the user's behalf.

## 4. Validate and restart Home Assistant

In Home Assistant, use **Settings → Tools → YAML → Check configuration**, then restart Home Assistant. For Home Assistant OS CLI:

```bash
ha core check
ha core restart
```

For Home Assistant Container:

```bash
docker exec homeassistant python -m homeassistant --script check_config --config /config
docker restart homeassistant
```

If the entities are unavailable, run this from the Home Assistant host or container and verify that it returns JSON:

```bash
curl -H "Authorization: Bearer PASTE_THE_TOKEN_HERE" \
  http://UBUNTU_IP:11435/_intermediary/v1/status
```

## 5. Add the mobile dashboard card

Edit a Home Assistant dashboard, add a **Manual** card, and paste:

```yaml
type: vertical-stack
cards:
  - type: conditional
    conditions:
      - condition: state
        entity: binary_sensor.ollama_gpu_recovery_required
        state: "on"
    card:
      type: tile
      entity: binary_sensor.ollama_gpu_recovery_required
      name: "GPU recovery required — check the intermediary"
      icon: mdi:alert-octagon
      color: red

  - type: grid
    columns: 2
    square: false
    cards:
      - type: tile
        entity: binary_sensor.ollama_intermediary_ready
        name: Intermediary
      - type: tile
        entity: binary_sensor.ollama_backend_reachable
        name: Ollama backend
      - type: tile
        entity: sensor.ollama_current_model
        name: Loaded model
      - type: tile
        entity: sensor.ollama_active_client
        name: Active client
      - type: tile
        entity: sensor.ollama_queued_requests
        name: Total queued
      - type: tile
        entity: sensor.ollama_oldest_queue_wait
        name: Oldest wait
      - type: tile
        entity: sensor.ollama_maintenance_state
        name: Maintenance
      - type: tile
        entity: binary_sensor.ollama_gpu_released_for_maintenance
        name: GPU released

  - type: entities
    title: Current inference
    show_header_toggle: false
    entities:
      - sensor.ollama_active_client
      - sensor.ollama_active_model
      - sensor.ollama_active_request_type
      - sensor.ollama_active_request_runtime
      - binary_sensor.ollama_upstream_draining

  - type: horizontal-stack
    cards:
      - type: button
        name: Pause manually
        icon: mdi:pause
        tap_action:
          action: perform-action
          perform_action: rest_command.ollama_intermediary_pause
          confirmation:
            text: "Pause Ollama scheduling and release the GPU?"
      - type: button
        name: Pause 4 hours
        icon: mdi:timer-pause
        tap_action:
          action: perform-action
          perform_action: rest_command.ollama_intermediary_pause_4h
          confirmation:
            text: "Pause Ollama scheduling for four hours after GPU release?"
      - type: button
        name: Resume
        icon: mdi:play
        tap_action:
          action: perform-action
          perform_action: rest_command.ollama_intermediary_resume
          confirmation:
            text: "Allow Ollama inference requests again?"

  - type: entities
    title: Scheduler
    show_header_toggle: false
    entities:
      - sensor.ollama_intermediary_state
      - sensor.ollama_maintenance_state
      - sensor.ollama_maintenance_remaining
      - binary_sensor.ollama_maintenance_paused
      - binary_sensor.ollama_gpu_released_for_maintenance
      - sensor.ollama_backend_state
      - sensor.ollama_current_model
      - sensor.ollama_queued_requests
      - sensor.ollama_odysseus_queue
      - sensor.ollama_frigate_queue
      - sensor.ollama_oldest_queue_wait
      - sensor.ollama_model_switches

  # Optional Frigate recovery card; uses the sensors/action above.
  - type: entities
    title: Frigate description recovery
    show_header_toggle: false
    entities:
      - sensor.ollama_frigate_recovery_state
      - sensor.ollama_frigate_pending_descriptions
      - sensor.ollama_frigate_lifetime_completed_descriptions
      - sensor.ollama_frigate_lifetime_skipped_descriptions

  - type: button
    name: Fill missing Frigate descriptions
    icon: mdi:playlist-plus
    tap_action:
      action: perform-action
      perform_action: rest_command.ollama_intermediary_frigate_scan
      confirmation:
        text: "Scan retained Frigate history for missing descriptions and queue eligible items?"
```

Home Assistant may append `_2` to an entity ID if that ID already exists. Check the actual IDs under **Settings → Tools → States** and adjust the card if necessary.

References: [RESTful integration](https://www.home-assistant.io/integrations/rest/), [RESTful Command](https://www.home-assistant.io/integrations/rest_command/), [secrets](https://www.home-assistant.io/docs/configuration/secrets/), [dashboard actions](https://www.home-assistant.io/dashboards/actions/), [dashboard cards](https://www.home-assistant.io/dashboards/cards/), and [conditional cards](https://www.home-assistant.io/dashboards/conditional/).
