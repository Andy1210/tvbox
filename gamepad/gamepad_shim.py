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

That resolution asks the pad's SHAPE first and its resting values only as a last
resort (`plan_axes`), because a resting value is worth nothing until the pad has
actually reported one: a pad grabbed the instant Bluetooth registers it has every
axis sitting at the zero the kernel created it with, and a right stick that reads
zero looks exactly like a pair of released triggers.

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

# A pedal axis is never a stick, so a pad that reports one has told us where its
# triggers are without us reading a single value. Left trigger first in each pair:
# BRAKE/GAS is the Android convention (brake = left) and is what the Nacon MG-X PRO
# reports; the picked pair is logged, so a swap is one line.
PEDAL_PAIRS = [
    (e.ABS_BRAKE, e.ABS_GAS),
    (e.ABS_THROTTLE, e.ABS_GAS),
    (e.ABS_THROTTLE, e.ABS_RUDDER),
]
# The pair no name can settle: Z/RZ is the right STICK on an Android-style pad and
# the TRIGGERS on an Xbox-style one.
ZRZ = (e.ABS_Z, e.ABS_RZ)
# Some HID pads report their triggers on the second hat, and some report a hat.
HAT2 = (e.ABS_HAT2Y, e.ABS_HAT2X)
# How long a pad may stay unmapped while we wait for it to report a resting value.
PLAN_SETTLE_SEC = 5.0


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


def values_reported(absinfo):
    """Do this pad's resting values mean anything yet? A device grabbed the moment it
    appears has every axis at the zero the kernel created it with, and zero is a
    perfectly plausible resting value for a trigger - so the values say nothing until
    the pad has spoken.

    A centred axis is NOT that evidence: on a signed range (-32768..32767, which is
    most pads) the centre IS zero, so the left stick reads centred before any report
    arrives. An axis resting at anything else is a value only the device could have
    put there - which is what an Android-style 0..255 stick resting at ~128 gives us,
    and it is why such a pad still settles immediately. Everything else waits for a
    real event (Pad.reported) or for the deadline."""
    return any(info and info.value != 0 for info in absinfo.values())


def plan_axes(axes, keys, absinfo, reported=False, force=False):
    """Which source axes are the right stick, and which are the triggers.

    Shape decides wherever it can, and resting values only settle what is left -
    `decided` comes back False when that remainder needs values the pad has not
    reported yet, and the caller retries instead of guessing. Both wrong answers
    are actively broken, not merely wrong: a stick taken for triggers holds them
    half-pressed for as long as it rests centred, and triggers taken for a stick
    pin it into a corner. `force` spends the wait and takes what is there.
    """
    right = (e.ABS_RX, e.ABS_RY) if set((e.ABS_RX, e.ABS_RY)) <= axes else None
    pedals = next((p for p in PEDAL_PAIRS if set(p) <= axes), None)
    has_zrz = set(ZRZ) <= axes
    triggers = None
    # A pad has one right stick and one trigger pair, so whatever names either of
    # them has answered for Z/RZ as well.
    if right:
        triggers = ZRZ if has_zrz else pedals  # the Xbox convention, in full
    elif pedals:
        triggers = pedals
        right = ZRZ if has_zrz else None  # Android-style: the stick is what is left
    elif has_zrz:
        # BOTH digital triggers, not either: a pad with one digital shoulder and an
        # analog Z/RZ trigger pair would otherwise have its triggers taken for the
        # right stick, which pins that stick into a corner.
        if {e.BTN_TL2, e.BTN_TR2} <= keys:
            right = ZRZ  # digital L2/R2 ARE the triggers
        elif not reported and not force:
            return None, None, False
        elif centred(absinfo.get(e.ABS_Z)) and centred(absinfo.get(e.ABS_RZ)):
            right = ZRZ
        else:
            triggers = ZRZ
    if triggers is None and set(HAT2) <= axes:
        if not reported and not force:
            return right, None, False
        # A second hat rests centred; a trigger pair rests at its ends.
        if not (centred(absinfo.get(HAT2[0])) or centred(absinfo.get(HAT2[1]))):
            triggers = HAT2
    return right, triggers, True


class Pad:
    """One grabbed source pad and the axis plan worked out for it."""

    def __init__(self, dev):
        self.dev = dev
        caps = dev.capabilities()
        self.absinfo = {a: info for a, info in caps.get(e.EV_ABS, [])}
        self.keys = set(caps.get(e.EV_KEY, []))
        self.has_hat = e.ABS_HAT0X in self.absinfo or e.ABS_HAT0Y in self.absinfo
        # source code -> (target code, is_trigger). Empty until the plan settles,
        # so an axis is silent rather than wrong; buttons pass through either way.
        self.axis_map = {}
        self.has_analog_triggers = False
        self.decided = False
        # An EV_ABS event actually seen from this device. The read loop sets it, and
        # it is the only unambiguous proof that the resting values are the pad's own.
        self.reported = False
        self.deadline = time.monotonic() + PLAN_SETTLE_SEC
        self.replan()
        if not self.decided:
            log(f"{dev.name!r} axes idle at zero - waiting for its first report")

    def replan(self, force=False):
        """Settle the axis plan against the kernel's CURRENT resting values. Called
        again after every batch of events until it succeeds, because the pad's first
        report is what makes those values mean anything."""
        if self.decided:
            return
        caps = self.dev.capabilities()  # re-reads absinfo from the device
        self.absinfo = {a: info for a, info in caps.get(e.EV_ABS, [])}
        axes = set(self.absinfo)
        reported = self.reported or values_reported(self.absinfo)
        right, triggers, decided = plan_axes(axes, self.keys, self.absinfo, reported, force)
        if not decided:
            return
        self.axis_map = {e.ABS_X: (e.ABS_X, False), e.ABS_Y: (e.ABS_Y, False)}
        if right:
            self.axis_map[right[0]] = (e.ABS_RX, False)
            self.axis_map[right[1]] = (e.ABS_RY, False)
        if triggers:
            self.axis_map[triggers[0]] = (e.ABS_Z, True)
            self.axis_map[triggers[1]] = (e.ABS_RZ, True)
        for hat in (e.ABS_HAT0X, e.ABS_HAT0Y):
            if hat in axes:
                self.axis_map[hat] = (hat, False)
        self.has_analog_triggers = triggers is not None
        self.decided = True
        dev = self.dev
        guessed = " (guessed - no report came)" if force else ""
        log(
            f"{dev.name!r} vendor={dev.info.vendor:04x}:{dev.info.product:04x}",
            "right-stick=" + (self.name_pair(right) if right else "none"),
            "triggers=" + (self.name_pair(triggers) if triggers else "none") + guessed,
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


def replan(pad, pads, force=False):
    """Settle one pad's plan, and survive a pad that goes away while doing it.

    replan() re-reads the device's capabilities, which raises if it disappeared
    between the select and the read (Bluetooth drops, a stick pulled). Unhandled
    that ends the daemon, and with it EVERY pad's input until systemd restarts it -
    so the pad is dropped the same way a failed read drops one. Returns False when
    the pad is gone."""
    try:
        pad.replan(force=force)
        return True
    except Exception as ex:
        log("lost", pad.dev.name, "while mapping it -", ex)
        try:
            pad.dev.close()
        except Exception:
            pass
        pads.pop(pad.dev.path, None)
        return False


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
                try:
                    pads[path] = Pad(dev)
                except Exception as ex:
                    # Never take the daemon down over one odd device: hand it back and
                    # let it work unshimmed.
                    log("cannot map", dev.name, "-", ex)
                    try:
                        dev.ungrab()
                    except Exception:
                        pass
                    dev.close()
        # A pad that reports nothing at all still has to end up mapped. Checked every
        # pass rather than inside the rescan branch above: tied to the rescan, a quiet
        # pad would sit unmapped for up to RESCAN_SEC past its own deadline.
        now = time.monotonic()
        for pad in list(pads.values()):
            if not pad.decided and now >= pad.deadline:
                if not replan(pad, pads, force=True):
                    if not pads and ui is not None:
                        ui = release_virtual(ui)
        if not pads:
            time.sleep(max(0.05, next_scan - time.monotonic()))  # nothing to read until the next scan
            continue
        # Read whatever is ready. A pad that disappears (BT off, unplug) raises on
        # read and is dropped; the virtual pad stays up for the others.
        #
        # The wait ends at the nearest pending deadline as well, so a pad that never
        # reports is forced on time instead of at the next rescan.
        waits = [p.deadline - now for p in pads.values() if not p.decided]
        timeout = max(0.01, min([0.2] + [w for w in waits if w > 0])) if waits else 0.2
        r, _, _ = select.select([p.dev.fd for p in pads.values()], [], [], timeout)
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
            # These events are the report the plan was waiting for, and the kernel has
            # already applied them - so settle it BEFORE translating them.
            if not pad.decided:
                if any(ev.type == e.EV_ABS for ev in events):
                    pad.reported = True  # the pad's resting values are its own now
                if not replan(pad, pads, force=time.monotonic() >= pad.deadline):
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
