# tvbox MQTT integration

The box is an MQTT client (`shell/mqtt.js`). It publishes what it's playing and
its availability, and listens for commands and on-screen notifications - the
glue for Home Assistant or any other MQTT-speaking system. All topics are
namespaced per box under `tvbox/<deviceId>/…`.

Requirements: an MQTT broker the box can reach (for Home Assistant: the
Mosquitto add-on plus HA's **MQTT integration**), and a broker user for the box.

## Configuration

Set the broker on the TV under **Settings → Network → MQTT / Home Assistant**,
or edit the `mqtt` section of `~/.tvbox/config.json` (chmod 600). Changes made
in Settings apply immediately - the shell reconnects on save.

| Field      | Required | Default | Notes                                                                |
| ---------- | -------- | ------- | -------------------------------------------------------------------- |
| `host`     | yes      | -       | broker hostname/IP. Clearing it turns the integration off.           |
| `port`     | no       | `1883`  | plain MQTT over TCP (`mqtt://`); TLS is not supported.               |
| `username` | yes      | -       | the bridge only starts once `host` **and** `username` are set.       |
| `password` | no       | -       | write-only from the UI: re-saving other fields keeps the stored one. |
| `deviceId` | no       | `tvbox` | topic namespace segment; sanitized to `[A-Za-z0-9_-]`.               |

The client auto-reconnects (5 s period) and announces availability with a
retained last-will on the status topic.

## Topics

| Topic                   | Direction            | Payload                                           |
| ----------------------- | -------------------- | ------------------------------------------------- |
| `tvbox/<id>/status`     | box → (retained LWT) | `online` / `offline`                              |
| `tvbox/<id>/nowplaying` | box → (retained)     | `{ app, state, title?, artist?, image? }`         |
| `tvbox/<id>/cmd`        | → box                | `{ action, app? }` - control                      |
| `tvbox/<id>/notify`     | → box                | `{ title?, message?, image?, duration?, raise? }` |

Inbound payloads must be JSON (a non-JSON payload is ignored as an unknown
command).

### Now-playing (`nowplaying`, retained)

The launcher is the single source of truth for what's playing (Spotify, Live
TV); the shell bridges it out retained, so a late subscriber gets the current
state. `state` is `playing` | `paused` | `idle`; `app` is the app id.

The box also publishes **HA MQTT discovery** (retained, at
`homeassistant/sensor/tvbox_<id>/nowplaying/config`), so a sensor named
`sensor.tvbox_<id>_now_playing` appears in Home Assistant automatically: its
state is the title, with `app` / `state` / `artist` / `image` as attributes,
availability-gated on the status topic. No HA YAML needed for that.

### Commands (`cmd`)

`action` is one of:

- `launch` / `open` (+ `app`: an installed app id, e.g. `spotify`, `youtube`, `livetv`, `plex`)
- `home` - back to the launcher
- `play` / `resume`, `pause`, `stop` - shared player + forwarded to the active app
- `next`, `previous` - forwarded to the active app (e.g. Spotify)
- `tv_on`, `tv_off` / `standby` - TV power over HDMI-CEC

### Notifications (`notify`)

Shows an on-screen card on the TV. `title` + `message`, optional `image` URL
(e.g. a doorbell camera snapshot), `duration` in ms (default 8000, `0` =
sticky), and `raise: true` to bring the launcher forward over a running app.

## Home Assistant examples

A button that opens Spotify on the TV (any automation can publish the same
payload with `mqtt.publish`):

```yaml
# configuration.yaml
mqtt:
  button:
    - name: "TV: open Spotify"
      command_topic: "tvbox/livingroom-tv/cmd"
      payload_press: '{"action":"launch","app":"spotify"}'
```

Consume the auto-discovered now-playing sensor - dim the lights when playback
starts:

```yaml
automation:
  - alias: "Dim the lights when the TV box plays"
    trigger:
      - platform: state
        entity_id: sensor.tvbox_livingroom_tv_now_playing
        attribute: state
        to: "playing"
    action:
      - service: light.turn_on
        target: { entity_id: light.living_room }
        data: { brightness_pct: 30 }
```

Push a doorbell notification onto the TV:

```yaml
service: mqtt.publish
data:
  topic: tvbox/livingroom-tv/notify
  payload: >
    {"title":"Doorbell","message":"Someone's at the door",
     "image":"http://<ha>/api/camera_proxy/camera.front_door?token=…",
     "duration":15000,"raise":true}
```
