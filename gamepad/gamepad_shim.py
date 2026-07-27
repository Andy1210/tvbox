#!/usr/bin/env python3
"""tvbox gamepad shim - make ANY controller look like a standard one.

Chromium decides a pad's `Gamepad.mapping` from its USB/BT vendor:product id
against a built-in table. A pad that isn't in that table is handed to pages in
raw HID order with `mapping: ""`, and an app that needs to know which button is
A/B/X/Y then refuses it - Xbox Cloud Gaming reports "no controller connected"
even though the kernel, /dev/input/js0 and Chromium itself all see the device
(measured with a Nacon MG-X PRO: mapping="" buttons=15 axes=8).

So: EVIOCGRAB the unrecognised pad and re-emit it through a uinput device that
identifies as an Xbox 360 pad (045e:028e), which every browser maps as standard.
The grab is what keeps exactly ONE pad visible - a kernel grab is device-wide, so
the raw pad's js node goes quiet too instead of showing up as a second
controller.

The translation is mostly identity because the kernel has already done the hard
part: hid-generic gives HID gamepads semantic BTN_A/BTN_B/... codes rather than
raw button numbers. What differs between pads is where the RIGHT STICK and the
TRIGGERS live - Xbox-style pads use RX/RY + Z/RZ, Android-style ones (most phone
controllers, including the Nacon) use Z/RZ for the stick and BRAKE/GAS or
THROTTLE/RUDDER for the triggers - so those are resolved per device and logged.

No root: /dev/input comes from the `input` group, /dev/uinput from the udev rule
provision.sh installs (same as the CEC and remote bridges).
"""

import os
import select
import sys
import time

from evdev import AbsInfo, InputDevice, UInput, ecodes as e, list_devices

OUT_NAME = "Microsoft X-Box 360 pad"  # what Chromium will map as "standard"
OUT_VENDOR = 0x045E
OUT_PRODUCT = 0x028E
OUT_VERSION = 0x0110
RESCAN_SEC = 2.0

# Vendors whose pads Chromium already recognises - shimming them would only add a
# hop (and risk fighting a working mapping). Everything else is fair game.
KNOWN_MAPPED_VENDORS = {
    0x045E,  # Microsoft (Xbox 360 / One / Series)
    0x054C,  # Sony (DualShock 3/4, DualSense 054c:0ce6 - verified on this box)
    0x057E,  # Nintendo
    0x28DE,  # Valve
    0x046D,  # Logitech (F310/F710 in XInput mode)
    0x2DC8,  # 8BitDo
}

# The xpad button set, in the order Chromium's xbox360 mapping expects. These are
# the SAME codes on the source pad (BTN_A == BTN_SOUTH == 0x130), so the mapping
# is a pass-through of whatever the source actually has.
OUT_KEYS = [
    e.BTN_A,
    e.BTN_B,
    e.BTN_X,
    e.BTN_Y,
    e.BTN_TL,
    e.BTN_TR,
    e.BTN_SELECT,
    e.BTN_START,
    e.BTN_MODE,
    e.BTN_THUMBL,
    e.BTN_THUMBR,
]
STICK = AbsInfo(value=0, min=-32768, max=32767, fuzz=16, flat=128, resolution=0)
TRIGGER = AbsInfo(value=0, min=0, max=255, fuzz=0, flat=0, resolution=0)
HAT = AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)
OUT_ABS = [
    (e.ABS_X, STICK),
    (e.ABS_Y, STICK),
    (e.ABS_RX, STICK),
    (e.ABS_RY, STICK),
    (e.ABS_Z, TRIGGER),
    (e.ABS_RZ, TRIGGER),
    (e.ABS_HAT0X, HAT),
    (e.ABS_HAT0Y, HAT),
]

# Candidate source pairs, most specific first. A pad that has RX/RY uses the Xbox
# convention (Z/RZ are then the triggers); one without it is Android-style, where
# Z/RZ IS the right stick and the triggers are analog pedals.
RIGHT_STICK_PAIRS = [(e.ABS_RX, e.ABS_RY), (e.ABS_Z, e.ABS_RZ)]
# Left trigger first in each pair. BRAKE/GAS is the Android convention (brake =
# left); THROTTLE/GAS is what the Nacon MG-X PRO reports and the left/right
# assignment there is a guess - the picked pair is logged, so a swap is one line.
TRIGGER_PAIRS = [
    (e.ABS_Z, e.ABS_RZ),
    (e.ABS_BRAKE, e.ABS_GAS),
    (e.ABS_THROTTLE, e.ABS_GAS),
    (e.ABS_THROTTLE, e.ABS_RUDDER),
    (e.ABS_HAT2Y, e.ABS_HAT2X),  # some HID pads report triggers on hat2
]


def log(*a):
    print("[gamepad-shim]", *a, flush=True)


def shim_enabled():
    """config.gamepad.shim: "auto" (default) or "off" - same shape as cec.vendorShim."""
    try:
        import json

        with open(os.path.expanduser("~/.tvbox/config.json"), "r", encoding="utf-8") as f:
            cfg = json.load(f)
        mode = str((cfg.get("gamepad") or {}).get("shim", "auto")).lower()
        return mode not in ("off", "false", "no")
    except Exception:
        return True


def is_gamepad(dev):
    caps = dev.capabilities()
    keys = set(caps.get(e.EV_KEY, []))
    axes = {a for a, _ in caps.get(e.EV_ABS, [])}
    # A gamepad has the south face button and two stick axes. Keyboards/remotes
    # have neither, and a mouse has EV_REL instead.
    return e.BTN_SOUTH in keys and e.ABS_X in axes and e.ABS_Y in axes


def needs_shim(dev):
    if dev.name == OUT_NAME:
        return False  # our own virtual pad
    try:
        vendor = dev.info.vendor
    except Exception:
        vendor = 0
    return vendor not in KNOWN_MAPPED_VENDORS


def pick_pair(axes, candidates, used):
    for lo, hi in candidates:
        if lo in axes and hi in axes and lo not in used and hi not in used:
            return lo, hi
    return None


class Pad:
    """One grabbed source pad and the axis plan worked out for it."""

    def __init__(self, dev):
        self.dev = dev
        caps = dev.capabilities()
        self.absinfo = {a: info for a, info in caps.get(e.EV_ABS, [])}
        axes = set(self.absinfo)
        used = {e.ABS_X, e.ABS_Y}
        right = pick_pair(axes, RIGHT_STICK_PAIRS, used)
        if right:
            used |= set(right)
        triggers = pick_pair(axes, TRIGGER_PAIRS, used)
        if triggers:
            used |= set(triggers)
        # source code -> (target code, is_trigger)
        self.axis_map = {e.ABS_X: (e.ABS_X, False), e.ABS_Y: (e.ABS_Y, False)}
        if right:
            self.axis_map[right[0]] = (e.ABS_RX, False)
            self.axis_map[right[1]] = (e.ABS_RY, False)
        if triggers:
            self.axis_map[triggers[0]] = (e.ABS_Z, True)
            self.axis_map[triggers[1]] = (e.ABS_RZ, True)
        if e.ABS_HAT0X in axes:
            self.axis_map[e.ABS_HAT0X] = (e.ABS_HAT0X, False)
        if e.ABS_HAT0Y in axes:
            self.axis_map[e.ABS_HAT0Y] = (e.ABS_HAT0Y, False)
        self.keys = set(caps.get(e.EV_KEY, []))
        log(
            f"{dev.name!r} vendor={dev.info.vendor:04x}:{dev.info.product:04x}",
            "right-stick=" + (self.name_pair(right) if right else "none"),
            "triggers=" + (self.name_pair(triggers) if triggers else "none"),
        )

    @staticmethod
    def name_pair(pair):
        names = []
        for code in pair:
            n = e.ABS[code]
            names.append(n if isinstance(n, str) else n[0])
        return "/".join(names)

    def scale(self, code, value):
        """Source range -> the xpad range Chromium expects."""
        target, is_trigger = self.axis_map[code]
        info = self.absinfo.get(code)
        if target in (e.ABS_HAT0X, e.ABS_HAT0Y):
            return target, max(-1, min(1, value))
        if not info or info.max == info.min:
            return target, 0
        frac = (value - info.min) / (info.max - info.min)  # 0..1
        if is_trigger:
            return target, int(round(frac * 255))
        return target, int(round(frac * 65535)) - 32768

    def translate(self, ev):
        if ev.type == e.EV_KEY:
            return (e.EV_KEY, ev.code, ev.value) if ev.code in OUT_KEYS else None
        if ev.type == e.EV_ABS and ev.code in self.axis_map:
            target, value = self.scale(ev.code, ev.value)
            return (e.EV_ABS, target, value)
        return None


def main():
    if not shim_enabled():
        log("disabled by config.gamepad.shim - exiting")
        return 0
    ui = None
    pads = {}  # path -> Pad
    next_scan = 0.0
    while True:
        now = time.monotonic()
        if now >= next_scan:
            next_scan = now + RESCAN_SEC
            for path in list_devices():
                if path in pads:
                    continue
                try:
                    dev = InputDevice(path)
                except Exception:
                    continue
                if not (is_gamepad(dev) and needs_shim(dev)):
                    dev.close()
                    continue
                try:
                    dev.grab()
                except Exception as ex:
                    log("grab failed for", dev.name, ex)
                    dev.close()
                    continue
                if ui is None:
                    # Created lazily, so a box with no odd pad never publishes a
                    # phantom Xbox controller to every app.
                    ui = UInput(
                        {e.EV_KEY: OUT_KEYS, e.EV_ABS: OUT_ABS},
                        name=OUT_NAME,
                        vendor=OUT_VENDOR,
                        product=OUT_PRODUCT,
                        version=OUT_VERSION,
                    )
                    log("virtual pad up:", OUT_NAME, f"{OUT_VENDOR:04x}:{OUT_PRODUCT:04x}")
                pads[path] = Pad(dev)
        if not pads:
            time.sleep(0.2)
            continue
        # Read whatever is ready. A pad that disappears (BT off, unplug) raises on
        # read and is dropped; the virtual pad stays up for the others.
        r, _, _ = select.select([p.dev.fd for p in pads.values()], [], [], 0.2)
        for fd in r:
            pad = next((p for p in pads.values() if p.dev.fd == fd), None)
            if pad is None:
                continue
            try:
                events = list(pad.dev.read())
            except Exception:
                log("lost", pad.dev.name)
                try:
                    pad.dev.close()
                except Exception:
                    pass
                pads.pop(pad.dev.path, None)
                continue
            wrote = False
            for ev in events:
                out = pad.translate(ev)
                if out:
                    ui.write(*out)
                    wrote = True
            if wrote:
                ui.syn()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pass
