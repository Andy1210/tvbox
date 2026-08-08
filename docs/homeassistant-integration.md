# tvbox ↔ Home Assistant

The box's MQTT surface - config fields, every topic, payloads, plain-YAML
examples - is documented in **[mqtt-integration.md](mqtt-integration.md)**. That
alone already gives you a now-playing sensor (auto-discovered), buttons that
launch apps, and on-screen notifications, with no custom code.

This page is about the other half: making the box **a real `media_player`
entity** - state, transport controls, a source list, a volume slider, artwork - so
it appears in Home Assistant as the device it is instead of a sensor plus a
handful of buttons.

## Why an integration and not MQTT discovery

Home Assistant's MQTT integration can auto-create almost every entity type from a
retained discovery payload. It cannot create a `media_player`: there is no MQTT
media player platform. That is the whole reason this exists; everything else the
box needed was already reachable over plain MQTT.

So this is a **thin** integration over the MQTT connection Home Assistant already
has:

- no polling, no HTTP to the box, no credentials of its own - the broker is the
  only channel;
- the box's topics are **retained**, so the entity is correct the moment it is
  created rather than after the next event;
- discovery still happens, at the integration level: the box publishes a retained
  `tvbox/<id>/announce` and the integration's manifest declares that topic, so
  Home Assistant **offers** a box that comes online. Nothing to type in.

## Install

The integration lives in this repo at
[`homeassistant/custom_components/tvbox/`](../homeassistant/custom_components/tvbox).
Copy it into the Home Assistant config directory and restart:

```sh
# from a checkout of this repo, to a HA whose config dir is /config
scp -r homeassistant/custom_components/tvbox <ha-host>:/config/custom_components/
```

Prerequisites: HA's **MQTT integration** set up against the same broker as the box
(Settings → Network → MQTT on the TV) - the same requirement plain MQTT already
had.

After the restart Home Assistant should offer the box under **Settings → Devices &
services** as a discovered `tvbox`. If it does not (a broker that strips retained
messages, or MQTT configured on the box after HA started), add it by hand: **Add
integration → tvbox**, then the box's MQTT device id (Settings → Network → MQTT on
the TV; it defaults to the hostname).

One config entry per box - which is also how several boxes stay apart, since the
device id is per box by construction
([updates-and-backup.md](updates-and-backup.md#setting-up-a-second-box-from-this-one)).

**Updating it later is the same copy plus a restart**, and the restart is not
optional: reloading the integration re-runs the config entry, it does not re-import
changed Python. A version that adds a platform (the diagnostics below did) only
appears once Home Assistant has started again. Nothing else has to be touched - the
config entries, and the entity ids already in dashboards and automations, survive.

## What the entity does

| Home Assistant                    | On the box                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| state, title/artist/album/artwork | the composed `state` topic (mpv + the app's now-playing + the sink)                                                            |
| play / pause / stop / next / prev | the shared mpv player, forwarded to the foreground app                                                                         |
| seek                              | absolute, **only** while the box's own mpv holds the clock                                                                     |
| volume slider, mute               | the box's **own** output sink (wireplumber's default sink)                                                                     |
| volume up / down buttons          | the **TV's** amplifier over the box's IR blaster - on a TV with no CEC volume, the only thing that changes what the room hears |
| turn on / off                     | TV power over HDMI-CEC. The box has no soft power state; it is always on.                                                      |
| source list                       | the installed, launchable apps - selecting one launches it                                                                     |
| availability                      | the retained LWT on `status`                                                                                                   |

**Supported features are what the box advertises**, not a fixed list: the announce
carries the box's command vocabulary, so a box on an older release never shows a
control that would go nowhere, and a box that grows a command needs one row added
to `_FEATURE_FOR_COMMAND` in `media_player.py`.

`play_media` is deliberately **not** implemented. The box plays what an app
resolved (a Plex stream, an IPTV channel), and handing the broker an arbitrary-URL
player is a far wider surface than transport control. Select the source instead.

## Diagnostics

The same device also carries what the box knows about itself: version, whether an
update is waiting or was rolled back, when it booted, its wifi link rate and
signal, temperature, free disk and memory. They are diagnostic entities, so they
sit under the device rather than in the room's card, and they are all fed by one
retained topic. What they are for, and a card that shows every box at once:
[fleet-view.md](fleet-view.md).

A box on a release older than the topic simply leaves them unavailable, rather
than showing a screenful of `unknown`.

The values come from the retained `diag` topic, but whether they are shown comes
from `status`: a retained payload outlives the box that published it, so an
unplugged box would otherwise display yesterday's temperature as if it were
current. The sensors go **unavailable** when the last will says `offline`, which
is the same rule the media player already follows.

## Automation examples

```yaml
automation:
  - alias: "Dim the lights when the TV plays"
    trigger:
      - platform: state
        entity_id: media_player.livingroom_tv
        to: "playing"
    action:
      - action: light.turn_on
        target: { entity_id: light.living_room }
        data: { brightness_pct: 30 }

  - alias: "Everything off at bedtime"
    trigger:
      - platform: time
        at: "23:30:00"
    action:
      - action: media_player.turn_off # CEC standby
        target: { entity_id: media_player.livingroom_tv }
```

Switching what is on the TV by voice, once the entity is exposed to your
assistant:

```yaml
action: media_player.select_source
target: { entity_id: media_player.livingroom_tv }
data: { source: Spotify }
```

## Troubleshooting

- **No discovered box.** Check the box is on the broker at all:
  `mosquitto_sub -h <broker> -u <user> -P <pass> -t 'tvbox/#' -v`. You should see a
  retained `status`, `announce` and `state`. If `announce` is missing, the box is
  on a release from before this feature - add it manually.
- **The entity exists but is unavailable.** That is the `status` topic saying
  `offline`: the box's shell is not running, or its last will fired.
  `journalctl --user` on the box, or the boot-partition report
  ([diagnostics.md](diagnostics.md)).
- **Everything else works but the progress bar does not move.** Only mpv playback
  has a position. An app playing its own audio (Spotify via librespot) reports
  none, and the entity says so rather than inventing one.
- **Two boxes fighting over one entity.** They share an MQTT device id. See
  [updates-and-backup.md](updates-and-backup.md#setting-up-a-second-box-from-this-one) -
  a clone restore re-derives it, and Settings → Network → MQTT shows what each box
  is actually using.
