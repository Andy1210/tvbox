# Several boxes at once

One box tells you how it is doing from its own Settings screen. Two or three do
not: every piece of state is per box and none of it is anywhere else. The
diagnostics report lives on that box's boot partition, the update state lives in
that box's own launcher, and the answer to "which one is on an old version" is
three SSH sessions.

So each box publishes what it knows about itself on **one retained MQTT topic**,
`tvbox/<deviceId>/diag`, and whatever is watching decides what to do with it. The
box has no idea a fleet exists; it just answers the same question every five
minutes.

- [What is in it](#what-is-in-it)
- [The three questions it exists for](#the-three-questions-it-exists-for)
- [In Home Assistant](#in-home-assistant)
- [Without Home Assistant](#without-home-assistant)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)

## What is in it

Published when the box's MQTT client connects and every 5 minutes after that,
retained, and only while MQTT is configured at all (see
[mqtt-integration.md](mqtt-integration.md) for the broker setup). "On connect"
rather than "at boot" because MQTT may be configured long after the box came up,
and because a broker that was unreachable at boot produces the first payload when
it comes back. Collected by [shell/diag.js](../shell/diag.js).

Retained also means **the last thing a box said, not necessarily what is true
now**: a box that has been unplugged since yesterday still answers with
yesterday's payload. Whether it is online is a different topic, `status`, which is
the box's retained last will - so anything reading `diag` should read `status`
alongside it. The Home Assistant sensors below do exactly that, and go unavailable
rather than showing a stale temperature.

```jsonc
{
  "at": "2026-08-08T05:20:00.000Z",
  "hostname": "tvbox-livingroom",
  "model": "Raspberry Pi 5 Model B Rev 1.0",
  "ip": "192.168.1.219",
  "version": "2.3.0", // the shell that is running
  "release": "2.3.0", // null on a dev deploy: this box did not come from OTA
  "compositor": "0.1.6", // empty on a box still running the old session
  "bootedAt": "2026-08-07T19:02:11.000Z",
  "uptimeSec": 37069,
  "cpuTempC": 61.2,
  "mem": { "totalKb": 8244664, "availableKb": 5010112 },
  "disk": { "freeBytes": 21902000000, "totalBytes": 62000000000 },
  "net": {
    "kind": "wifi", // or "ethernet", or null when nothing is connected
    "device": "wlan0",
    "ssid": "…",
    "signalDbm": -55,
    "rateMbps": 390, // what the link NEGOTIATED, not what the radio can do
  },
  "update": {
    "state": "idle",
    "auto": true,
    "available": false,
    "latest": null,
    "unmet": [], // requirements this box cannot satisfy, e.g. ["compositor"]
    "lastCheckAt": 1786000000000,
    "rollback": null, // or { from, to, at } - see below
    // Nothing on the box reboots itself, so OS updates leave this waiting for a person.
    "os": { "rebootRequired": false, "packages": [] },
  },
}
```

## The three questions it exists for

**Which box is on an old version.** `version` plus `release`. The pair matters:
`release` is null on a box that was last touched by `deploy.sh`, and a dev deploy
also removes the rollback net ([updates-and-backup.md](updates-and-backup.md)), so
a box showing a version but no release is a box running something nobody can
reproduce.

**Which box rolled back last night, and from what.** When a release loses its
three boot attempts, `deploy/run-shell.sh` flips the `current` symlink back and
writes `~/.tvbox/update/failed`. Nothing else records that it happened, and by
morning the shell log has moved on, so the marker's **mtime is the only timestamp
there is** - it travels in `update.rollback.at`, with `from` naming the release
that could not boot. That is the whole reason the topic is retained: the
dashboard is read hours after the event.

**Which box's wifi has quietly dropped to a tenth of its speed.** `net.rateMbps`
is the negotiated link rate, which is the number that moves when NetworkManager's
power saving throttles a link; `signalDbm` can sit at a perfectly good -55 while
the rate collapses, which is exactly how this hides. `iw` is not in the platform
baseline, so the rate comes from NetworkManager's own `Bitrate` property over
D-Bus, and the level comes from `/proc/net/wireless` (nmcli only exposes a 0-100
quality, which is not the same thing).

## In Home Assistant

The [tvbox integration](homeassistant-integration.md) turns the payload into
diagnostic sensors on the box's existing device, so nothing new has to be set up:
if the box is already a `media_player` in Home Assistant, updating the integration
files and reloading gives it `sensor.<box>_version`, `_update`, `_last_rollback`,
`_booted`, `_link_rate`, `_signal`, `_cpu_temperature`, `_disk_free` and
`_memory_free`.

A card that shows the whole fleet, and which is the point of the exercise. It
names no box: `auto-entities` (HACS) picks up whatever tvbox devices exist, so
adding a fourth box adds a row.

```yaml
type: custom:auto-entities
card:
  type: entities
  title: TV boxes
filter:
  include:
    - integration: tvbox
      entity_id: "*_version"
    - integration: tvbox
      entity_id: "*_update"
    - integration: tvbox
      entity_id: "*_last_rollback"
    - integration: tvbox
      entity_id: "*_link_rate"
  exclude:
    - state: unavailable
sort:
  method: friendly_name
```

Plain-YAML equivalent, if you would rather not add a HACS card, with one box
spelled out (repeat the block per box):

```yaml
type: entities
title: TV boxes
entities:
  - entity: sensor.tvbox_livingroom_version
  - entity: sensor.tvbox_livingroom_update
  - entity: sensor.tvbox_livingroom_last_rollback
  - entity: sensor.tvbox_livingroom_link_rate
```

The two things worth an automation, rather than a glance:

```yaml
# A box rolled back overnight. The sensor is a timestamp, so "it changed" is the event.
automation:
  - alias: A TV box rolled back an update
    triggers:
      - trigger: state
        entity_id: sensor.tvbox_livingroom_last_rollback
        not_to:
          - unknown
          - unavailable
    actions:
      - action: notify.persistent_notification
        data:
          message: >-
            {{ state_attr(trigger.entity_id, 'failed_version') }} could not boot on
            {{ device_attr(trigger.entity_id, 'name') }}; it went back to
            {{ state_attr(trigger.entity_id, 'rolled_back_to') }}.

  # A link that has collapsed but is still "connected". 40 Mbit/s is well under
  # anything this hardware negotiates in a working state, and well over the rate a
  # box legitimately drops to while it is mirroring a phone.
  - alias: A TV box's wifi has collapsed
    triggers:
      - trigger: numeric_state
        entity_id: sensor.tvbox_livingroom_link_rate
        below: 40
        for: "00:10:00"
    actions:
      - action: notify.persistent_notification
        data:
          message: "{{ device_attr(trigger.entity_id, 'name') }} is linked at {{ states(trigger.entity_id) }} Mbit/s."
```

## Without Home Assistant

It is one retained topic, so anything that speaks MQTT can read the fleet:

```sh
mosquitto_sub -h <broker> -u <user> -P <pass> -t 'tvbox/+/diag' -v | while read -r topic payload; do
  echo "$payload" | jq -r --arg t "$topic" '"\($t | split("/")[1])  \(.version)  \(.net.rateMbps // "-") Mbit/s  \(.update.rollback.at // "no rollback")"'
done
```

Retained means every box answers immediately, not at its next tick. It also means
a box that is switched off still answers, with whatever it last said, so subscribe
to `status` too when that matters:

```sh
mosquitto_sub -h <broker> -u <user> -P <pass> -t 'tvbox/+/status' -v
```

A box whose `status` reads `offline` (its last will, published by the broker when
the connection dropped) is showing you history, not the present.

## What it deliberately does not do

- **No bespoke dashboard.** The box publishes data; the dashboard is whatever the
  owner already runs. A tvbox-specific fleet UI would be one more thing to host,
  authenticate and update, for a household with three boxes.
- **No control.** This topic is read-only state. Commands already have a topic
  (`cmd`), with its own vocabulary and its own gating.
- **No log shipping.** When something is actually broken, the answer is the boot
  partition report and safe mode ([diagnostics.md](diagnostics.md)), which work
  when the network does not. This payload is for the boxes that are fine, so the
  one that is not stands out.
- **Nothing that needs root.** Same rule as the rest of the shell: every number
  here comes from a file the box user can read or a command it can already run.
