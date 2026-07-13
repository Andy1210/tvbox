# IR blaster - TV volume from the box

Most TVs don't accept volume over HDMI-CEC from a source device, so the box's
remotes (and MQTT/voice commands) have no way to change the TV's real volume.
A cheap network IR blaster pointed at the TV fixes that: the box tells the
blaster to replay the TV remote's learned volume codes.

What uses it once configured:

- **BT/USB remotes**: the remote bridge swallows `KEY_VOLUMEUP` /
  `KEY_VOLUMEDOWN` / `KEY_MUTE` (native buttons or ones remapped to the
  volume actions in Settings → Peripherals) and forwards them to the blaster.
  Holding the button autorepeats at a throttled pace. With no blaster
  configured the keys pass through untouched, exactly as before.
- **MQTT / voice assistants**: `{"action":"volume_up","steps":3}` on
  `tvbox/<id>/cmd` ([mqtt-integration.md](mqtt-integration.md)).
- **Settings UI**: per-command Test buttons (Settings → Peripherals → IR
  blaster).

Everything funnels through one shell module ([shell/ir.js](../shell/ir.js))
with pluggable backends behind a single `send(action)` surface. Adding a new
vendor (e.g. Broadlink spoken natively, without Home Assistant) means adding
one more backend factory there - the config plumbing, the remote-bridge hook
and the MQTT actions don't change.

## Backend: ESPHome device (`esphome`)

Talks the ESPHome native API (TCP 6053) straight to the device - no Home
Assistant required. Tested with the **Seeed XIAO Smart IR Mate** stock
firmware, which models "replay a learned signal" as two entities: a _signal
select_ (`signal_select`, options `Signal0`…`Signal9`) plus a _send button_
(`send`). Any ESPHome IR transmitter with the same select+button shape works;
the entity object_ids are configurable.

Setup:

1. Teach the device the TV remote's codes (on the IR Mate: hold its button to
   enter learn mode, or press its HA `Learn` button, then press the TV
   remote's key at it). Note which slot got which key - e.g. `Signal0` =
   volume up, `Signal1` = volume down, `Signal2` = mute.
2. Settings → Peripherals → IR blaster: backend _ESPHome device_, set the
   device host (IP or mDNS name). Port stays empty for the default (6053).
   If the device's API is encrypted, paste its `api.encryption.key` into
   _API encryption key_ (the XIAO stock firmware ships unencrypted).
3. Map the commands to the learned slots (`Signal0`, …) and hit _Test_.

The shell keeps one auto-reconnecting connection to the device (the ESPHome
API allows multiple clients, so Home Assistant can stay connected too). A
send = "set the select to the slot, press the send button", serialized so
overlapping commands can't replay the wrong slot.

## Backend: Home Assistant script (`homeassistant`)

For blasters the box can't (yet) speak natively - **Broadlink RM4**, SmartIR,
Tuya IR, anything HA can drive. Each command runs an HA script; tvbox never
needs the vendor protocol.

1. In HA, create one script per command, e.g. for a Broadlink RM4:

   ```yaml
   script:
     tv_volume_up:
       sequence:
         - service: remote.send_command
           target: { entity_id: remote.rm4_mini }
           data: { device: tv, command: volume_up }
   ```

2. Settings → Peripherals → IR blaster: backend _Home Assistant script_, set
   the HA URL and a long-lived access token (HA profile → Security).
3. Map each command to its script entity id (`script.tv_volume_up`, …).

Plain `http://` HA URLs are accepted only toward LAN hosts - the token never
crosses the internet in cleartext; use `https://` (e.g. Nabu Casa) otherwise.

## Plumbing (for debugging)

- Config lives under `ir` in `~/.tvbox/config.json` (secrets chmod-600;
  the launcher only ever sees `has*` flags). Saving from the UI reconnects
  the backend and reloads the remote bridge immediately.
- `POST /tvbox/api/ir/send` `{ action, steps? }` - what the bridge and the
  Test buttons call; answers `{ ok: false, error }` instead of a 500 when the
  blaster is down. `GET /tvbox/api/ir/status` - backend health + last error.
- Bridge-side log lines (`journalctl --user -u tvbox-remote`) show
  `ir send failed: …` when the shell/blaster is unreachable; the shell log
  (`~/.tvbox/shell.log`) carries the backend errors themselves.
