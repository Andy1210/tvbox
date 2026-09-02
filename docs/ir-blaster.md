# IR blaster - the TV's volume, its input, and the soundbar

Most TVs don't accept volume over HDMI-CEC from a source device, so the box's
remotes (and MQTT/voice commands) have no way to change the TV's real volume.
A cheap network IR blaster pointed at the TV fixes that: the box tells the
blaster to replay the TV remote's learned volume codes.

Two more things are IR-only, and for a stronger reason than volume:

- **The TV's input.** CEC has no command with which a source device selects a
  _foreign_ input. `<Active Source>` says "show ME", and that is all - so a box
  can bring the television to its own socket and can never move it to the games
  console on the next one. The `<Set Stream Path>` broadcast and a spoofed
  `<Active Source>` are the usual tricks and neither is standard behaviour for a
  source device to send. Real IR input codes are.
- **A soundbar.** It is usually not on the CEC bus at all, and often on its own
  power circuit, so the only thing that reaches it is its own remote's codes.

One thing to know before wiring an input switch to anything: on a TV that only
forwards remote keys to the ACTIVE source - LG's SIMPLINK does this - moving the
television to another input makes the box's own CEC remote stop working until
something moves it back. That is why the input actions ask which socket rather
than stepping blind.

What uses it once configured:

- **BT/USB remotes**: the remote bridge swallows `KEY_VOLUMEUP` /
  `KEY_VOLUMEDOWN` / `KEY_MUTE` (native buttons or ones remapped to the
  volume actions in Settings → Remotes & accessories) and forwards them to the blaster.
  Holding the button autorepeats at a throttled pace. With no blaster
  configured the keys pass through untouched, exactly as before.
- **MQTT / voice assistants**: `{"action":"volume_up","steps":3}` on
  `tvbox/<id>/cmd` ([mqtt-integration.md](mqtt-integration.md)).
- **Settings UI**: per-command Test rows (Settings → Remotes & accessories → TV
  volume).

Everything funnels through one shell module ([shell/ir.js](../shell/ir.js))
with pluggable backends behind a single `send(action)` surface. Adding a new
vendor (e.g. Broadlink spoken natively, without Home Assistant) means adding
one more backend factory there - the config plumbing, the remote-bridge hook
and the MQTT actions don't change.

## Actions

The vocabulary is closed (`IR_ACTIONS` in [shell/config.js](../shell/config.js)),
because an action nothing is mapped to is refused rather than sent, and because
each one becomes a Home Assistant button with a stable entity id:

| action                                                          | what it is                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `volume_up` / `volume_down` / `mute`                            | the TV's own amplifier                                       |
| `tv_power`                                                      | the TV's power code, for a set whose CEC power does not work |
| `input_hdmi1` … `input_hdmi4`                                   | select that socket directly                                  |
| `soundbar_power`                                                | the soundbar's power key                                     |
| `soundbar_volume_up` / `soundbar_volume_down` / `soundbar_mute` | its volume                                                   |

A power code is normally a TOGGLE - one key that switches whichever way the
device was - and nothing here can read which way that is. Whatever sends the
command owns that honesty; the box only reports that the code went out.

The TV's own Source code is **not** in the list, though the code index carries it
(as `Input`) and a plan can hold it. Measured on the living-room LG: it opens the
set's input LIST rather than stepping to the next socket - and no remote the box
owns can drive that list, because those are paired to the BOX rather than to the
television. It would leave the screen in a menu somebody has to escape with the
TV's own remote. A discrete code completes the job with no navigation, which is
the only shape that works here. Bind it if your set steps on it instead.

## The `firetv` backend - no blaster hardware at all

If the box already has a Fire TV / Alexa remote paired to it, that remote _is_ a
blaster: the IR LED is in the remote, not in any Fire TV, and its keymap GATT
service takes an "InstantFire" command - blast this code, now
([docs/firetv-remote-ir.md](firetv-remote-ir.md)).

The interesting part is that a blast is bound to no BUTTON. Programming the
remote's keymap can only reach the handful of keys the firmware assigns a scan id
to (Power, Volume ±, Mute); a blast needs no scan id, so it can send a code for a
button the remote does not physically have - which is exactly what a TV input is.

Configure it with the remote's MAC and, per action, which entry of the saved
remote plan to send, as `<kind>:<Key>`:

```json
"ir": {
  "backend": "firetv",
  "firetv": {
    "mac": "7C:ED:C6:12:E6:3C",
    "actions": {
      "input_hdmi2": "tv:HDMI2",
      "soundbar_power": "audio:Power"
    }
  }
}
```

Addressing by device KIND rather than by device id is what keeps "the soundbar's
power" and "the TV's power" apart - `assign` in the plan answers a different
question (what does the Power BUTTON do), and it has one slot. A kind is also the
stable half of a plan: a device id is a hash of the frames a published index
grouped, and a rebuilt index can regroup them.

Two costs, both from the hardware:

- **The remote sleeps between presses, and the link is what has to be kept.** A
  blast when nobody has touched it may find nothing to talk to, and the error says
  so ("press a button on it to wake it, then retry") rather than reporting a
  failure that looks like a broken TV.

  What made this look far worse than it is was our own process model. One process
  per blast disconnects at the end - and about two seconds later the remote is
  unreachable, so the NEXT blast spends its whole budget failing to connect.
  Measured: 2.6 s for a blast to an awake remote from a cold process, then 8.2 s of
  nothing for the same blast right after it. Held instead, by one resident process,
  **a blast costs ~0.9 s and 20 of them over 20 minutes all worked**, the link
  still up at the end - including one after three minutes of complete silence. So
  `serve` holds the link (see [firetv-remote-ir.md](firetv-remote-ir.md)) and the
  shell keeps one of those - there is one IR backend, so one service - the way the
  esphome backend keeps
  one connection to its device.
  **A BUTTON is still the sure path, and voice works while the link is held.** A press wakes the remote, so a bound button always works. Voice depends on
  whether the resident link is up: while it is, a spoken blast is as good as a
  pressed one, and once it is gone only a press brings the remote back. For a voice
  path that does not depend on that, use a mains-powered blaster (`esphome`) - it
  can be TAUGHT these codes by putting it in learn mode and blasting each one at it
  from the remote.

- **The box cannot wake it, and the reason is not the one it looks like.** This is
  the first idea everybody has, so it is worth the paragraph. A sleeping remote is
  _silent_: 95 s of LE scanning finds a dozen other devices in the room, including
  the television, and never the remote - no advertisement of any kind and no
  find-my beacon. Twelve minutes untouched: zero reconnects. A patient `Connect()`
  is abandoned by BlueZ after ~41 s, and the remote-finder fails with `Not
connected`. Only a button press brings it back.

  **A link the box does not hold does not come back on its own.** From an HCI trace
  (`btmon -w`, read back with `btmon -r` - see the tooling note below): the
  disconnect is ours (`Reason: Connection Terminated By Local Host`), and in the
  next two minutes there is not one `LE Connection Complete` and exactly one
  advertising report of any kind on the whole adapter, with scanning enabled for
  part of that window. A second blast with no press in between fails ("the remote
  did not answer in time"). So without a held link the chain is: press, one blast,
  silence until the next press - which is what the resident service exists to
  break.

  The kernel's LE accept list with auto-connect (`btmgmt add-device -a 2 -t 1
<mac>`) has NOT been shown to rescue that, and two earlier notes here claiming it
  did were misread measurements rather than results: this `btmgmt` has no command
  that lists the accept list at all (its usage error was read as an empty list),
  and `bluetoothctl devices Connected` sampled straight after a blast still reports
  the old state, which is not the same thing as a reconnect. The contents of an LE
  accept list cannot be read back over HCI either - there is a command for its
  size and none for its entries - so anything claimed about it has to be claimed
  from behaviour.

  A find-my beacon is a different thing again, and this remote has none: **it has to
  be provisioned, and only a Fire TV has ever done that**. From the Fire OS firmware: the host writes `01` plus two
  16-byte IRKs to `cfbfb001` (the same characteristic the ring's `03 01` goes to),
  then `02 01`; the ring path itself is gated on `cfg_state == 1` and otherwise
  logs _"device is not configured, cannot ring"_. So the finder is not magic and a
  Fire TV cannot reach an unreachable remote either - it has user-visible
  `Ring operation timeout in 30 seconds` and `Tracking device connect timeout`
  errors. What Fire OS does have is a **standing intent to connect that is never
  withdrawn**: it suppresses connection-parameter updates for Amazon remotes,
  never removes one from the background connection list (upstream AOSP does), and
  adds it even when the first connect fails. A Pi can copy that with the kernel's
  LE accept list (`btmgmt add-device`), which removes the 41 s cap - but with an
  unprovisioned remote there is nothing on air to accept.

  So the honest state: **a button press is the only wake there is from this end.**
  What Fire OS has that a Pi does not is read from its firmware rather than
  measured here - a standing intent to connect that is never withdrawn, and
  suppressed connection-parameter updates so the remote keeps its own power policy.
  Copying that would be a bench experiment, not a setting. What the box does
  instead is hold the link it already has, for as long as the remote keeps it up.

- **And a blast goes wherever the remote is LYING.** Measured on the same soundbar,
  minutes apart, with byte-identical codes: once nothing happened, once it switched.
  Nothing had changed but where the remote was. A television is a large target and
  forgiving; a soundbar's receiver is small and low. This is the second and less
  obvious reason the backend suits a button - the hand that presses it is also the
  hand that aims it.
- **A send over the held link is ~0.9 s**, and the queue adds 250 ms between steps,
  so a ten-step volume ramp is still about eleven seconds of it. Let the remote's own programmed keys do volume
  (`irPassthrough`) and keep this for the one-shot actions.

**Holding the link changes who can fire IR, and that is worth stating.** Before it,
a blast needed the remote awake, so in practice somebody had to have picked it up -
a physical gate on every remote trigger. Now the box holds the link, so anything that
can reach `POST /tvbox/api/ir/send` (loopback, and any process on the box) or publish
to `tvbox/<id>/cmd` on the broker (no box-side authentication - see
[SECURITY.md](../SECURITY.md)) can fire IR at the room for as long as the link lasts.
That is the point of the feature; it is also a capability that used to be gated by a
hand on a remote. The socket the service listens on is `0600` in the box user's home,
which is a boundary against other USERS and not against the box's own apps - those run
as the same user. What the request check buys is narrower than it
looks: `check_blast_request` holds a request to the fields, ranges, timing count and
time on air of a real code - so it cannot be used to hold the air for five minutes or
to hand the remote's firmware a value nothing would write - but a well-formed code that
is in no plan is accepted, so anything running as that user can fire arbitrary consumer
IR while the link is held.

[remote/firetv_ir_plan.example.json](../remote/firetv_ir_plan.example.json) is a
hand-written plan carrying real LG input codes and a Samsung soundbar's power
capture, for a box whose published index predates the input keys.

## A button on any remote

`ir:<action>` is a remap action (Settings → Remotes & accessories → Remote buttons), so any
button the box can see can fire any configured IR action - including the buttons
a Fire TV remote's own keymap cannot reach, like a Remote Pro's headphone key
(consumer usage 0x0280). It fires once per press: a blast is a single command, a
power toggle sent twice undoes itself, and on the `firetv` backend an autorepeat
would queue seconds of BLE work per held second.

## In Home Assistant

Every configured action is published as a `button` entity over MQTT discovery, on
the box's own HA device. Pressing one publishes the same `{"action":"…"}` object
an automation or a voice assistant would put on `tvbox/<id>/cmd`, so there is one
path into the box rather than a private second one.

The entities follow the config: removing an action deletes its button (a
discovery config topic is retained, so a button nobody deletes would stay in Home
Assistant pressing into a box that no longer maps it).

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
2. Settings → Remotes & accessories → TV volume: backend _ESPHome device_, set the
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

2. Settings → Remotes & accessories → TV volume: backend _Home Assistant script_, set
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
