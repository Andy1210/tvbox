# tvbox ↔ Home Assistant (MQTT)

The box is an MQTT client. It publishes what it's playing and its availability,
and listens for commands and on-screen notifications. All topics are namespaced
per box by its `deviceId` (the hostname unless overridden), e.g.
`tvbox/livingroom-tv/…`.

Requirements: an MQTT broker both HA and the box can reach, and HA's **MQTT
integration** connected to it. The box's broker settings live in
`~/.tvbox/config.json` (`mqtt: { host, port, username, password, deviceId }`,
chmod 600), provisioned out-of-band with a dedicated broker user.

## Topics

| Topic                   | Direction            | Payload                                           |
| ----------------------- | -------------------- | ------------------------------------------------- |
| `tvbox/<id>/status`     | box → (retained LWT) | `online` / `offline`                              |
| `tvbox/<id>/nowplaying` | box →                | `{ app, state, title, artist, image }` (retained) |
| `tvbox/<id>/cmd`        | → box                | `{ action, app? }` - control                      |
| `tvbox/<id>/notify`     | → box                | `{ title, message, image?, duration?, raise? }`   |

### Now-playing sensor (auto-discovered)

The box publishes HA MQTT discovery, so a sensor
`sensor.<id>_now_playing` appears automatically: its **state** is the track/
channel title, with `app` / `artist` / `image` as attributes, available-gated on
the status topic. No HA YAML needed.

### Commands (`cmd`)

`action` is one of: `launch` (+ `app`: youtube | spotify | plex | livetv |
homeassistant), `home`, `play`, `pause`, `stop`, `next`, `previous`, `tv_on`,
`tv_off`. `tv_on`/`tv_off` drive the TV over HDMI-CEC.

A voice assistant or any HA automation can publish these via `mqtt.publish`:

```yaml
service: mqtt.publish
data:
  topic: tvbox/livingroom-tv/cmd
  payload: '{"action":"launch","app":"spotify"}'
```

### Notifications (`notify`)

Publish to show an on-screen card on the TV (title + message, optional image such
as a doorbell camera snapshot). `duration` ms (default 8000, 0 = sticky);
`raise:true` brings the box's launcher forward over a running app.

```yaml
# doorbell automation
service: mqtt.publish
data:
  topic: tvbox/livingroom-tv/notify
  payload: >
    {"title":"Doorbell","message":"Someone's at the door",
     "image":"http://<ha>/api/camera_proxy/camera.front_door?token=…",
     "duration":15000,"raise":true}
```
