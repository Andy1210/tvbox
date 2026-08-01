"""Adding a box: either it announced itself, or its id is typed in.

The box publishes a RETAINED announce on ``tvbox/<id>/announce``, and the manifest
declares that topic, so Home Assistant hands us the payload as an MQTT discovery
step - including for a box that came online before Home Assistant did, which is the
whole reason the announce is retained. The manual step exists for a broker that
strips retained messages, or a box whose MQTT was configured after the fact.
"""

from __future__ import annotations

import json
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.service_info.mqtt import MqttServiceInfo

from .const import CONF_DEVICE_ID, DOMAIN


def _device_id_from_topic(topic: str) -> str | None:
    """``tvbox/<id>/announce`` -> ``<id>``. Refuses anything else."""
    parts = topic.split("/")
    if len(parts) != 3 or parts[0] != "tvbox" or parts[2] != "announce":
        return None
    return parts[1] or None


class TvboxConfigFlow(ConfigFlow, domain=DOMAIN):
    """One config entry per box."""

    VERSION = 1

    def __init__(self) -> None:
        self._device_id: str | None = None
        self._name: str | None = None

    async def async_step_mqtt(self, discovery_info: MqttServiceInfo) -> ConfigFlowResult:
        """A box announced itself on the broker."""
        device_id = _device_id_from_topic(discovery_info.topic)
        if not device_id:
            return self.async_abort(reason="invalid_discovery_info")

        # The announce carries the box's own name. It is not trusted for anything
        # but a label - the device id comes from the TOPIC, which the broker's ACLs
        # govern, not from the payload.
        name = device_id
        try:
            payload = json.loads(discovery_info.payload or "{}")
            if isinstance(payload, dict) and isinstance(payload.get("name"), str):
                name = payload["name"][:60] or device_id
        except ValueError:
            pass

        await self.async_set_unique_id(device_id)
        self._abort_if_unique_id_configured()
        self._device_id = device_id
        self._name = name
        # Named in the discovered list rather than added silently: a box is a device
        # in someone's living room, and it should be their decision.
        self.context["title_placeholders"] = {"name": name}
        return await self.async_step_confirm()

    async def async_step_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Confirm the discovered box."""
        if user_input is not None:
            return self.async_create_entry(
                title=self._name or self._device_id,
                data={CONF_DEVICE_ID: self._device_id},
            )
        self._set_confirm_only()
        return self.async_show_form(
            step_id="confirm",
            description_placeholders={"name": self._name or self._device_id or ""},
        )

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Add a box by its MQTT device id (Settings, Network on the box)."""
        errors: dict[str, str] = {}
        if user_input is not None:
            device_id = user_input[CONF_DEVICE_ID].strip()
            # The id becomes a topic segment; the box sanitises it to this same
            # character class (shell/identity.js safeId), so anything else here
            # would only ever subscribe to a topic no box publishes on.
            if not device_id or not all(c.isalnum() or c in "_-" for c in device_id):
                errors[CONF_DEVICE_ID] = "invalid_device_id"
            else:
                await self.async_set_unique_id(device_id)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title=device_id, data={CONF_DEVICE_ID: device_id})
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_DEVICE_ID): str}),
            errors=errors,
        )
