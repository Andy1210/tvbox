"""tvbox as a Home Assistant device.

Why a custom integration and not MQTT discovery: Home Assistant's MQTT platform
has no ``media_player``. Every other entity type the box could want is available
over plain discovery, and the box publishes a now-playing SENSOR that way already
(shell/mqtt.js) - but the thing the box actually is, a media player with transport
controls, a source list and a volume, cannot be created from a discovery payload.

So this is a thin integration on top of the same MQTT connection Home Assistant
already has. It adds no polling, no HTTP, and no credentials of its own: the broker
is the only channel, and the box's retained topics mean an entity is correct the
moment it is created rather than after the next event.

Discovery still works, at the INTEGRATION level: the manifest declares the box's
retained ``announce`` topic, so Home Assistant offers a box that comes online
instead of asking anyone to type a device id.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

PLATFORMS: list[Platform] = [Platform.MEDIA_PLAYER]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up one box from a config entry."""
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear one box down. The MQTT subscriptions go with the entity."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Renaming a box changes its topic root, so the entity is rebuilt."""
    await hass.config_entries.async_reload(entry.entry_id)
