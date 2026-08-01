"""Shared constants for the tvbox integration.

The topic layout is the box's, not ours - shell/mqtt.js owns it. Everything under
``tvbox/<device_id>/``:

    status      retained LWT, "online" / "offline"
    announce    retained {id, base, name, hostname, version, commands}
    state       retained player state (shell/mediastate.js composes it)
    nowplaying  retained, the older metadata-only topic (the voice assistant reads it)
    cmd         commands in
"""

DOMAIN = "tvbox"

CONF_DEVICE_ID = "device_id"

TOPIC_ANNOUNCE = "tvbox/+/announce"


def base_topic(device_id: str) -> str:
    """The box's topic root. One place, so a typo cannot half-work."""
    return f"tvbox/{device_id}"
