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


# Buttons that aren't in the xpad set but mean something we CAN express: a D-pad
# reported as buttons becomes the hat, and digital shoulder triggers become full-scale
# analog ones. Without this a pad whose D-pad is BTN_DPAD_* lost it completely, because
# the grab hides the raw device.
DPAD_TO_HAT = {
    e.BTN_DPAD_UP: (e.ABS_HAT0Y, -1),
    e.BTN_DPAD_DOWN: (e.ABS_HAT0Y, 1),
    e.BTN_DPAD_LEFT: (e.ABS_HAT0X, -1),
    e.BTN_DPAD_RIGHT: (e.ABS_HAT0X, 1),
}
DIGITAL_TRIGGERS = {e.BTN_TL2: e.ABS_Z, e.BTN_TR2: e.ABS_RZ}


def release_virtual(ui):
    """Neutralise and remove the virtual pad. Both halves matter: uinput remembers the
    last state, so a pad that disconnected mid-direction would leave the UI repeating
    that arrow forever, and a device left registered means the browser never reports
    the last gamepad gone (the launcher's polling loop would never stop)."""
    try:
        for code, info in OUT_ABS:
            ui.write(e.EV_ABS, code, 0 if info is not STICK else 0)
        for code in OUT_KEYS:
            ui.write(e.EV_KEY, code, 0)
        ui.syn()
    except Exception:
        pass
    try:
        ui.close()
    except Exception:
        pass
    log("virtual pad removed (no shimmed pads left)")
    return None


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


def centred(info):
    """Does this axis rest near the middle of its range (a stick) or at its end (a
    trigger)? evdev gives us the current value, which is the only reliable signal -
    an Android pad's right stick is Z/RZ over 0..255 resting at ~128, and a trigger
    is 0..255 resting at 0, so the CODE says nothing."""
    if not info or info.max == info.min:
        return False
    mid = (info.min + info.max) / 2.0
    return abs(info.value - mid) < (info.max - info.min) * 0.25


def pick_pair(axes, candidates, used, absinfo=None, want=None):
    for lo, hi in candidates:
        if lo in axes and hi in axes and lo not in used and hi not in used:
            if want == "stick" and absinfo and not (centred(absinfo[lo]) and centred(absinfo[hi])):
                continue  # a pair resting at its ends is a trigger pair, not a stick
            if want == "trigger" and absinfo and (centred(absinfo[lo]) or centred(absinfo[hi])):
                continue  # a pair resting mid-range is a stick (or a hat), not a trigger
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
        right = pick_pair(axes, RIGHT_STICK_PAIRS, used, self.absinfo, "stick")
        if right:
            used |= set(right)
        triggers = pick_pair(axes, TRIGGER_PAIRS, used, self.absinfo, "trigger")
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
        self.has_hat = e.ABS_HAT0X in axes or e.ABS_HAT0Y in axes
        self.has_analog_triggers = triggers is not None
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
        frac = 0.0 if frac < 0 else 1.0 if frac > 1 else frac
        if is_trigger:
            return target, int(round(frac * 255))
        return target, int(round(frac * 65535)) - 32768

    def translate(self, ev):
        if ev.type == e.EV_KEY:
            if ev.code in OUT_KEYS:
                return (e.EV_KEY, ev.code, ev.value)
            # A button-reported D-pad becomes the hat axis (press -> ±1, release -> 0).
            if ev.code in DPAD_TO_HAT and not self.has_hat:
                axis, dir = DPAD_TO_HAT[ev.code]
                return (e.EV_ABS, axis, dir if ev.value else 0)
            # Digital shoulder triggers, when the pad has no analog ones.
            if ev.code in DIGITAL_TRIGGERS and not self.has_analog_triggers:
                return (e.EV_ABS, DIGITAL_TRIGGERS[ev.code], 255 if ev.value else 0)
            return None
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
                    try:
                        ui = UInput(
                            {e.EV_KEY: OUT_KEYS, e.EV_ABS: OUT_ABS},
                            name=OUT_NAME,
                            vendor=OUT_VENDOR,
                            product=OUT_PRODUCT,
                            version=OUT_VERSION,
                        )
                    except Exception as ex:
                        # No /dev/uinput, or the input-group grant isn't live yet (a
                        # fresh provision before reboot). Give the pad back and let it
                        # work unshimmed rather than exiting into a restart loop that
                        # flaps the grab every few seconds.
                        log("cannot open uinput -", ex, "- leaving", dev.name, "unshimmed")
                        try:
                            dev.ungrab()
                        except Exception:
                            pass
                        dev.close()
                        continue
                    log("virtual pad up:", OUT_NAME, f"{OUT_VENDOR:04x}:{OUT_PRODUCT:04x}")
                pads[path] = Pad(dev)
        if not pads:
            time.sleep(max(0.05, next_scan - time.monotonic()))  # nothing to read until the next scan
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
                if not pads and ui is not None:
                    ui = release_virtual(ui)
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
