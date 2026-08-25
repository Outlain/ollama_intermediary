# Home Assistant quick-view dashboard

The intermediary exposes one stable JSON snapshot for Home Assistant:

```text
http://UBUNTU_IP:11435/_intermediary/v1/status
```

Use the Ubuntu host's LAN address. `127.0.0.1` is correct only when Home Assistant shares the intermediary's network namespace. The configuration below uses one shared REST request every five seconds for all entities.

## 1. Store the bearer token

If `OBSERVABILITY_TOKEN` is set in the intermediary's `secrets.env`, add the same value to Home Assistant's `/config/secrets.yaml`:

```yaml
ollama_intermediary_authorization: "Bearer PASTE_THE_TOKEN_HERE"
```

The word `Bearer` is required. If the intermediary token is blank, omit the `Authorization` header below. Home Assistant secrets prevent accidental publication but are not encrypted at rest.

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
```

## 3. Validate and restart Home Assistant

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

## 4. Add the mobile dashboard card

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

  - type: entities
    title: Current inference
    show_header_toggle: false
    entities:
      - sensor.ollama_active_client
      - sensor.ollama_active_model
      - sensor.ollama_active_request_type
      - sensor.ollama_active_request_runtime
      - binary_sensor.ollama_upstream_draining

  - type: entities
    title: Scheduler
    show_header_toggle: false
    entities:
      - sensor.ollama_intermediary_state
      - sensor.ollama_backend_state
      - sensor.ollama_current_model
      - sensor.ollama_queued_requests
      - sensor.ollama_odysseus_queue
      - sensor.ollama_frigate_queue
      - sensor.ollama_oldest_queue_wait
      - sensor.ollama_model_switches
```

Home Assistant may append `_2` to an entity ID if that ID already exists. Check the actual IDs under **Settings → Tools → States** and adjust the card if necessary.

References: [RESTful integration](https://www.home-assistant.io/integrations/rest/), [secrets](https://www.home-assistant.io/docs/configuration/secrets/), [dashboard cards](https://www.home-assistant.io/dashboards/cards/), and [conditional cards](https://www.home-assistant.io/dashboards/conditional/).
