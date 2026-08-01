"""The box as a media_player entity.

State comes off three retained topics, so the entity is right the moment it is
created rather than after the next event:

    <base>/status   "online" / "offline"  -> availability
    <base>/announce {name, version, commands} -> device info + supported_features
    <base>/state    the composed player state (shell/mediastate.js)

Commands go out on ``<base>/cmd`` as the same JSON the box already answers for the
voice assistant - this adds no second control protocol.

What the entity deliberately does NOT do:

* ``play_media`` - the box plays what an APP resolved (a Plex stream, an IPTV
  channel), and handing the broker an arbitrary-URL player would be a new and much
  wider surface than transport control. Launch the app instead (source select).
* poll - everything is push, and the box republishes its state on a slow tick of
  its own.
* seek on an app that plays its own audio - librespot has no position the box can
  move, so ``seekable`` says false and the feature is withheld.
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any

from homeassistant.components import mqtt
from homeassistant.components.media_player import (
    MediaPlayerDeviceClass,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import CONF_DEVICE_ID, DOMAIN, base_topic

_LOGGER = logging.getLogger(__name__)

# What each command the box advertises buys the entity. The box sends its own
# vocabulary in the announce, so a box on an older release never shows a control
# that would go nowhere - and a box that grows a command needs no change here
# beyond a row.
_FEATURE_FOR_COMMAND = {
    "play": MediaPlayerEntityFeature.PLAY,
    "pause": MediaPlayerEntityFeature.PAUSE,
    "stop": MediaPlayerEntityFeature.STOP,
    "next": MediaPlayerEntityFeature.NEXT_TRACK,
    "previous": MediaPlayerEntityFeature.PREVIOUS_TRACK,
    "volume_set": MediaPlayerEntityFeature.VOLUME_SET,
    "volume_mute": MediaPlayerEntityFeature.VOLUME_MUTE,
    "volume_up": MediaPlayerEntityFeature.VOLUME_STEP,
    "volume_down": MediaPlayerEntityFeature.VOLUME_STEP,
    "tv_on": MediaPlayerEntityFeature.TURN_ON,
    "tv_off": MediaPlayerEntityFeature.TURN_OFF,
    "launch": MediaPlayerEntityFeature.SELECT_SOURCE,
}

# A box that predates the announce (no `commands` in the payload) still answered all
# of these, so assume them rather than showing an entity with no controls at all.
_LEGACY_COMMANDS = ("play", "pause", "stop", "next", "previous", "volume_up", "volume_down", "tv_on", "tv_off", "launch")

_STATES = {
    "playing": MediaPlayerState.PLAYING,
    "paused": MediaPlayerState.PAUSED,
    "idle": MediaPlayerState.IDLE,
}

# A box offers a handful of apps. The cap is not about the box - it is about a
# payload from the broker becoming an oversized entity attribute in the recorder.
_MAX_SOURCES = 64


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """One entity per box, once the MQTT client is actually up.

    Subscribing is the entity's whole connection to the box, so a Home Assistant
    start where the MQTT entry has not come up yet must be retried rather than
    raising out of async_added_to_hass with no entity to show for it.
    """
    if not await mqtt.async_wait_for_mqtt_client(hass):
        raise ConfigEntryNotReady("the MQTT integration is not available yet")
    async_add_entities([TvboxMediaPlayer(entry)])


class TvboxMediaPlayer(MediaPlayerEntity):
    """A tvbox, driven over its own MQTT topics."""

    _attr_has_entity_name = True
    _attr_name = None  # the device IS the player; no "tvbox Media player"
    _attr_device_class = MediaPlayerDeviceClass.TV
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry) -> None:
        self._device_id: str = entry.data[CONF_DEVICE_ID]
        self._base = base_topic(self._device_id)
        self._attr_unique_id = f"{DOMAIN}_{self._device_id}"
        self._attr_available = False
        self._attr_state = MediaPlayerState.IDLE
        self._attr_supported_features = _features(_LEGACY_COMMANDS)
        self._sources: dict[str, str] = {}  # display name -> app id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, self._device_id)},
            name=entry.title,
            manufacturer="tvbox",
            model="Raspberry Pi TV box",
        )

    async def async_added_to_hass(self) -> None:
        """Subscribe to the box's three topics. All retained: no first-event wait."""
        for topic, handler in (
            (f"{self._base}/status", self._on_status),
            (f"{self._base}/announce", self._on_announce),
            (f"{self._base}/state", self._on_state),
        ):
            self.async_on_remove(await mqtt.async_subscribe(self.hass, topic, handler))

    # ---- incoming ----

    @callback
    def _on_status(self, msg: mqtt.ReceiveMessage) -> None:
        self._attr_available = msg.payload == "online"
        self.async_write_ha_state()

    @callback
    def _on_announce(self, msg: mqtt.ReceiveMessage) -> None:
        data = _json(msg.payload)
        if not data:
            return
        commands = data.get("commands")
        if isinstance(commands, list):
            self._attr_supported_features = _features(commands)
        # The box's version is in the announce payload but deliberately not pushed
        # into the device registry here: device_info is read once, when the entity is
        # added, so assigning to it later is a no-op that only looks like it works.
        self.async_write_ha_state()

    @callback
    def _on_state(self, msg: mqtt.ReceiveMessage) -> None:
        data = _json(msg.payload)
        if not data:
            return
        self._attr_state = _STATES.get(data.get("state"), MediaPlayerState.IDLE)
        self._attr_media_title = _text(data.get("title"))
        self._attr_media_artist = _text(data.get("artist"))
        self._attr_media_album_name = _text(data.get("album"))
        self._attr_media_image_url = _text(data.get("image"))
        self._attr_media_duration = _int(data.get("duration"))
        position = _int(data.get("position"))
        self._attr_media_position = position
        # Home Assistant extrapolates the progress bar from this, and it must be OUR
        # clock: the box's is a different machine's and may be minutes off.
        self._attr_media_position_updated_at = dt_util.utcnow() if position is not None else None

        # The source list is names for the UI, ids for the wire.
        sources = data.get("sourceList")
        if isinstance(sources, list):
            self._sources = {
                str(s["name"])[:60]: str(s["id"])[:60]
                for s in sources[:_MAX_SOURCES]
                if isinstance(s, dict) and s.get("id") and s.get("name")
            }
            self._attr_source_list = sorted(self._sources)
        source_id = _text(data.get("source"))
        self._attr_source = next((n for n, i in self._sources.items() if i == source_id), source_id)

        self._attr_volume_level = _volume(data.get("volume"))
        self._attr_is_volume_muted = bool(data.get("muted"))

        # Seeking is offered only while the box holds the clock (its own mpv); an app
        # playing its own audio has no position for it to move.
        feature = MediaPlayerEntityFeature.SEEK
        if data.get("seekable"):
            self._attr_supported_features |= feature
        else:
            self._attr_supported_features &= ~feature
        self.async_write_ha_state()

    # ---- outgoing ----

    async def _send(self, action: str, **extra: Any) -> None:
        payload = {"action": action, **extra}
        await mqtt.async_publish(self.hass, f"{self._base}/cmd", json.dumps(payload))

    async def async_media_play(self) -> None:
        await self._send("play")

    async def async_media_pause(self) -> None:
        await self._send("pause")

    async def async_media_stop(self) -> None:
        await self._send("stop")

    async def async_media_next_track(self) -> None:
        await self._send("next")

    async def async_media_previous_track(self) -> None:
        await self._send("previous")

    async def async_media_seek(self, position: float) -> None:
        await self._send("seek", position=round(float(position), 3))

    async def async_set_volume_level(self, volume: float) -> None:
        await self._send("volume_set", volume=round(float(volume), 3))

    async def async_mute_volume(self, mute: bool) -> None:
        await self._send("volume_mute", mute=bool(mute))

    async def async_volume_up(self) -> None:
        # The TV's amplifier over the box's IR blaster, not the box's own sink: on a
        # TV whose CEC has no volume control that is the only thing that changes what
        # the room hears. (The slider - volume_set - is the box's own output.)
        await self._send("volume_up")

    async def async_volume_down(self) -> None:
        await self._send("volume_down")

    async def async_turn_on(self) -> None:
        # CEC: wake the TV. The box itself is always on - it has no soft power state.
        await self._send("tv_on")

    async def async_turn_off(self) -> None:
        await self._send("tv_off")

    async def async_select_source(self, source: str) -> None:
        app_id = self._sources.get(source, source)
        await self._send("launch", app=app_id)


def _features(commands: list[str] | tuple[str, ...]) -> MediaPlayerEntityFeature:
    """Fold the box's advertised command list into the entity's features."""
    out = MediaPlayerEntityFeature(0)
    for command in commands:
        out |= _FEATURE_FOR_COMMAND.get(str(command), MediaPlayerEntityFeature(0))
    return out


def _json(payload: Any) -> dict[str, Any] | None:
    """A payload from the broker is untrusted input: shape-check, never assume."""
    try:
        data = json.loads(payload or "{}")
    except (ValueError, TypeError):
        _LOGGER.debug("tvbox: ignoring a non-JSON payload")
        return None
    return data if isinstance(data, dict) else None


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


# json.loads accepts Infinity and NaN, so "is it a number" is not enough: int(inf)
# raises OverflowError, and raising out of an MQTT @callback would abandon the whole
# state update over one bad field.
def _int(value: Any) -> int | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return int(value)


def _volume(value: Any) -> float | None:
    """0..1, clamped - the slider must not be handed 500 or an infinity."""
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        return None
    return min(1.0, max(0.0, float(value)))
