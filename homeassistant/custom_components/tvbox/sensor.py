"""The diagnostic half of a tvbox: what it is running, and how it is doing.

Every value here comes from ONE retained topic, ``tvbox/<id>/diag``, which the box
publishes at boot and every five minutes (shell/diag.js). That shape is deliberate:

* **Retained** means a dashboard opened at nine in the morning still shows the
  rollback that happened at three, which is the whole point - the reason for a
  rolled-back update is usually gone by the time anyone looks
  (docs/updates-and-backup.md).
* **One topic, many sensors** means the box does not have to know what a dashboard
  wants. It publishes the same object either way, and a sensor here is a field
  selector plus a unit.

The entities attach to the SAME device as the media player (identifiers
``(DOMAIN, device_id)``), so a box is one thing in Home Assistant with its player
and its diagnostics under it, not two.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import logging
from typing import Any

from homeassistant.components import mqtt
from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    SIGNAL_STRENGTH_DECIBELS_MILLIWATT,
    EntityCategory,
    UnitOfDataRate,
    UnitOfInformation,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_DEVICE_ID, DOMAIN, base_topic

_LOGGER = logging.getLogger(__name__)


def _get(data: dict[str, Any], path: str) -> Any:
    """A dotted lookup that answers None rather than raising.

    A box on an older release simply has no such field, and a missing key must
    make one sensor unknown, never take the platform down.
    """
    node: Any = data
    for part in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


def _timestamp(value: Any) -> datetime | None:
    """An ISO string from the box into an aware datetime, or None.

    Home Assistant rejects a naive datetime on a timestamp sensor, and the box
    always sends UTC with a Z suffix, which older Python parsers will not take.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _boot_time(data: dict[str, Any]) -> datetime | None:
    """When the box came up.

    Reported as a timestamp rather than a growing "uptime" number: a sensor whose
    value changes every second writes a state every second, and the question people
    ask ("has this box rebooted?") is answered by the moment, not the duration.
    """
    booted = _timestamp(_get(data, "bootedAt"))
    if booted:
        return booted
    uptime = _get(data, "uptimeSec")
    if not isinstance(uptime, (int, float)):
        return None
    return datetime.now(timezone.utc) - timedelta(seconds=float(uptime))


def _bytes_to_gb(value: Any) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    return round(float(value) / 1e9, 1)


def _update_state(data: dict[str, Any]) -> str | None:
    """What this box would do about updates, in one word.

    Deliberately not just the latest version: a box that CAN see an update it can
    never install (an unmet requirement, e.g. a release that needs the compositor)
    reads as "up to date" otherwise, which is the exact confusion the feed's
    ``requires`` field exists to remove.
    """
    upd = _get(data, "update")
    if not isinstance(upd, dict):
        return None
    if upd.get("unmet"):
        return "blocked"
    if upd.get("available"):
        latest = upd.get("latest")
        return str(latest) if latest else "available"
    return "up to date"


@dataclass(frozen=True, kw_only=True)
class TvboxSensorDescription(SensorEntityDescription):
    """A sensor is a field of the diag payload plus how to read it."""

    value: Callable[[dict[str, Any]], Any]
    attributes: Callable[[dict[str, Any]], dict[str, Any]] | None = None


SENSORS: tuple[TvboxSensorDescription, ...] = (
    TvboxSensorDescription(
        key="version",
        name="Version",
        icon="mdi:package-variant",
        value=lambda d: _get(d, "version"),
        attributes=lambda d: {
            # A box with no release came from deploy.sh rather than an OTA update, and
            # a dev deploy also removes the rollback net - so the absence is the
            # interesting part, and it has to survive the drop-empty-attributes filter.
            "release": _get(d, "release") or "dev",
            "compositor": _get(d, "compositor"),
            "model": _get(d, "model"),
            "hostname": _get(d, "hostname"),
            "ip": _get(d, "ip"),
        },
    ),
    TvboxSensorDescription(
        key="update",
        name="Update",
        icon="mdi:update",
        value=_update_state,
        attributes=lambda d: {
            "auto": _get(d, "update.auto"),
            "unmet": _get(d, "update.unmet"),
            "last_check": _get(d, "update.lastCheckAt"),
            # Nothing on the box ever reboots itself, by design, so a box that took
            # OS updates waits for a person. On one box Settings says so; on three,
            # this is the only place it is visible.
            "reboot_required": _get(d, "update.os.rebootRequired"),
            "reboot_for": _get(d, "update.os.packages"),
        },
    ),
    TvboxSensorDescription(
        key="rollback",
        name="Last rollback",
        icon="mdi:backup-restore",
        device_class=SensorDeviceClass.TIMESTAMP,
        value=lambda d: _timestamp(_get(d, "update.rollback.at")),
        attributes=lambda d: {
            "failed_version": _get(d, "update.rollback.from"),
            "rolled_back_to": _get(d, "update.rollback.to"),
        },
    ),
    TvboxSensorDescription(
        key="booted",
        name="Booted",
        icon="mdi:clock-start",
        device_class=SensorDeviceClass.TIMESTAMP,
        value=_boot_time,
    ),
    TvboxSensorDescription(
        key="link_rate",
        name="Link rate",
        icon="mdi:wifi-arrow-up-down",
        device_class=SensorDeviceClass.DATA_RATE,
        native_unit_of_measurement=UnitOfDataRate.MEGABITS_PER_SECOND,
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: _get(d, "net.rateMbps"),
        attributes=lambda d: {
            "kind": _get(d, "net.kind"),
            "device": _get(d, "net.device"),
            "ssid": _get(d, "net.ssid"),
        },
    ),
    TvboxSensorDescription(
        key="signal",
        name="Signal",
        device_class=SensorDeviceClass.SIGNAL_STRENGTH,
        native_unit_of_measurement=SIGNAL_STRENGTH_DECIBELS_MILLIWATT,
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: _get(d, "net.signalDbm"),
    ),
    TvboxSensorDescription(
        key="cpu_temp",
        name="CPU temperature",
        device_class=SensorDeviceClass.TEMPERATURE,
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: _get(d, "cpuTempC"),
    ),
    TvboxSensorDescription(
        key="disk_free",
        name="Disk free",
        device_class=SensorDeviceClass.DATA_SIZE,
        native_unit_of_measurement=UnitOfInformation.GIGABYTES,
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: _bytes_to_gb(_get(d, "disk.freeBytes")),
        attributes=lambda d: {"total_gb": _bytes_to_gb(_get(d, "disk.totalBytes"))},
    ),
    TvboxSensorDescription(
        key="memory_free",
        name="Memory free",
        device_class=SensorDeviceClass.DATA_SIZE,
        native_unit_of_measurement=UnitOfInformation.MEGABYTES,
        state_class=SensorStateClass.MEASUREMENT,
        # MemAvailable, which is the free that matters: "free" alone reads as nearly
        # nothing on a box that is using its RAM as cache, exactly as it should.
        value=lambda d: (
            round(_get(d, "mem.availableKb") / 1024)
            if isinstance(_get(d, "mem.availableKb"), (int, float))
            else None
        ),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Add one set of diagnostics per box, once MQTT is up.

    Same retry as the media player: a Home Assistant start where the MQTT entry has
    not come up yet must be retried, not left with no entities.
    """
    if not await mqtt.async_wait_for_mqtt_client(hass):
        raise ConfigEntryNotReady("the MQTT integration is not available yet")
    feed = TvboxDiagFeed(entry)
    async_add_entities([TvboxSensor(entry, feed, desc) for desc in SENSORS])


class TvboxDiagFeed:
    """One subscription to ``diag`` and ``status``, shared by every sensor.

    Nine entities subscribing to the same two topics would work, and would also ask
    the broker for the same payload nine times on every publish. The feed subscribes
    when the first sensor is added and drops the subscription with the last.
    """

    def __init__(self, entry: ConfigEntry) -> None:
        self._base = base_topic(entry.data[CONF_DEVICE_ID])
        self._listeners: list[Callable[[], None]] = []
        self._unsubscribe: list[Callable[[], None]] = []
        self.data: dict[str, Any] = {}
        self.online = False

    async def async_add_listener(self, hass: HomeAssistant, listener: Callable[[], None]) -> None:
        self._listeners.append(listener)
        if len(self._listeners) > 1:
            return
        self._unsubscribe.append(await mqtt.async_subscribe(hass, f"{self._base}/diag", self._on_diag))
        self._unsubscribe.append(await mqtt.async_subscribe(hass, f"{self._base}/status", self._on_status))

    def async_remove_listener(self, listener: Callable[[], None]) -> None:
        if listener in self._listeners:
            self._listeners.remove(listener)
        if self._listeners:
            return
        while self._unsubscribe:
            self._unsubscribe.pop()()

    @callback
    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()

    @callback
    def _on_diag(self, msg: mqtt.ReceiveMessage) -> None:
        try:
            data = json.loads(msg.payload)
        except ValueError:
            _LOGGER.debug("tvbox: unreadable diag payload on %s", msg.topic)
            return
        if not isinstance(data, dict):
            return
        self.data = data
        self._notify()

    @callback
    def _on_status(self, msg: mqtt.ReceiveMessage) -> None:
        self.online = msg.payload == "online"
        self._notify()


class TvboxSensor(SensorEntity):
    """One field of the box's diag payload."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    entity_description: TvboxSensorDescription

    def __init__(self, entry: ConfigEntry, feed: TvboxDiagFeed, description: TvboxSensorDescription) -> None:
        self.entity_description = description
        self._feed = feed
        device_id = entry.data[CONF_DEVICE_ID]
        self._attr_unique_id = f"{DOMAIN}_{device_id}_{description.key}"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, device_id)})

    async def async_added_to_hass(self) -> None:
        await self._feed.async_add_listener(self.hass, self._on_feed)
        self.async_on_remove(lambda: self._feed.async_remove_listener(self._on_feed))

    @callback
    def _on_feed(self) -> None:
        self.async_write_ha_state()

    @property
    def available(self) -> bool:
        """Available means the box is up AND has said something.

        A box that has never published diag (an older release) leaves its
        diagnostics unavailable rather than showing a screenful of "unknown".
        """
        return self._feed.online and bool(self._feed.data)

    @property
    def native_value(self) -> Any:
        try:
            return self.entity_description.value(self._feed.data)
        except (TypeError, ValueError):  # a field that is not the shape we expected
            return None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        builder = self.entity_description.attributes
        if not builder:
            return None
        try:
            attrs = builder(self._feed.data)
        except (TypeError, ValueError):
            return None
        return {k: v for k, v in attrs.items() if v is not None}
