#!/usr/bin/env python3
"""Offline unit tests for gamepad_shim.py (run: python3 gamepad/gamepad_shim_test.py).

`evdev` isn't installed on a CI runner (and needs a real /dev/input to be useful),
so a stub module with the REAL kernel code values is injected before the import.
The values below are from linux/input-event-codes.h - the pair resolution and the
axis scaling are exactly the logic that decides whether a pad feels right, so the
test has to use the same numbers the kernel does.
"""
import os
import sys
import types

# ---- evdev stub -------------------------------------------------------------
ec = types.ModuleType("evdev.ecodes")
CODES = {
    "EV_SYN": 0x00,
    "EV_KEY": 0x01,
    "EV_REL": 0x02,
    "EV_ABS": 0x03,
    "ABS_X": 0x00,
    "ABS_Y": 0x01,
    "ABS_Z": 0x02,
    "ABS_RX": 0x03,
    "ABS_RY": 0x04,
    "ABS_RZ": 0x05,
    "ABS_THROTTLE": 0x06,
    "ABS_RUDDER": 0x07,
    "ABS_WHEEL": 0x08,
    "ABS_GAS": 0x09,
    "ABS_BRAKE": 0x0A,
    "ABS_HAT0X": 0x10,
    "ABS_HAT0Y": 0x11,
    "ABS_HAT2X": 0x14,
    "ABS_HAT2Y": 0x15,
    "BTN_SOUTH": 0x130,
    "BTN_A": 0x130,
    "BTN_EAST": 0x131,
    "BTN_B": 0x131,
    "BTN_C": 0x132,
    "BTN_NORTH": 0x133,
    "BTN_X": 0x133,
    "BTN_WEST": 0x134,
    "BTN_Y": 0x134,
    "BTN_Z": 0x135,
    "BTN_TL": 0x136,
    "BTN_TR": 0x137,
    "BTN_TL2": 0x138,
    "BTN_TR2": 0x139,
    "BTN_SELECT": 0x13A,
    "BTN_START": 0x13B,
    "BTN_MODE": 0x13C,
    "BTN_THUMBL": 0x13D,
    "BTN_THUMBR": 0x13E,
    "BTN_TOUCH": 0x14A,
    "BTN_DPAD_UP": 0x220,
    "BTN_DPAD_DOWN": 0x221,
    "BTN_DPAD_LEFT": 0x222,
    "BTN_DPAD_RIGHT": 0x223,
    "KEY_ENTER": 28,
}
for name, value in CODES.items():
    setattr(ec, name, value)
ec.ABS = {v: k for k, v in CODES.items() if k.startswith("ABS_")}


class AbsInfo:
    def __init__(self, value=0, min=0, max=0, fuzz=0, flat=0, resolution=0):
        self.value, self.min, self.max = value, min, max
        self.fuzz, self.flat, self.resolution = fuzz, flat, resolution


class _Info:
    def __init__(self, vendor=0, product=0):
        self.bustype, self.vendor, self.product, self.version = 3, vendor, product, 0


class InputDevice:  # only ever constructed by the tests here
    def __init__(self, name="", caps=None, vendor=0, product=0, path="/dev/input/eventX"):
        self.name, self._caps, self.path = name, caps or {}, path
        self.info = _Info(vendor, product)
        self.grabbed = False

    def capabilities(self):
        return self._caps

    def grab(self):
        self.grabbed = True

    def close(self):
        pass


class UInput:  # never instantiated by the tests
    def __init__(self, *a, **kw):
        raise AssertionError("the tests must not open uinput")


evdev = types.ModuleType("evdev")
evdev.AbsInfo = AbsInfo
evdev.InputDevice = InputDevice
evdev.UInput = UInput
evdev.list_devices = lambda: []
evdev.ecodes = ec
sys.modules["evdev"] = evdev
sys.modules["evdev.ecodes"] = ec

sys.path.insert(0, os.path.dirname(__file__))
import gamepad_shim as gs  # noqa: E402

e = ec
fails = []


def check(label, got, want):
    if got != want:
        fails.append(f"{label}: got {got!r}, want {want!r}")


def dev(name, axes, keys, vendor=0x1234, product=0x0001, ranges=None, rest=None):
    """A fake pad. `ranges` overrides the default 0..255 per axis; `rest` the value an
    axis sits at when untouched - which is how a stick is told from a trigger."""
    ranges = ranges or {}
    rest = rest or {}
    abs_caps = []
    for a in axes:
        lo, hi = ranges.get(a, (0, 255))
        # Default: sticks/hats rest centred, everything else at its minimum - the
        # shim reads this exactly as the kernel reports it.
        # X/Y/RX/RY are sticks by convention; Z/RZ are triggers on an Xbox-style pad
        # and the RIGHT STICK on an Android-style one, so those tests say where it rests.
        default = (lo + hi) // 2 if a in (e.ABS_X, e.ABS_Y, e.ABS_RX, e.ABS_RY) else lo
        abs_caps.append((a, AbsInfo(value=rest.get(a, default), min=lo, max=hi)))
    return InputDevice(name=name, caps={e.EV_KEY: list(keys), e.EV_ABS: abs_caps}, vendor=vendor, product=product)


PAD_KEYS = [e.BTN_A, e.BTN_B, e.BTN_X, e.BTN_Y, e.BTN_TL, e.BTN_TR, e.BTN_SELECT, e.BTN_START, e.BTN_MODE]

# ---- detection --------------------------------------------------------------
pad = dev("Some Pad", [e.ABS_X, e.ABS_Y], PAD_KEYS)
check("is_gamepad(pad)", gs.is_gamepad(pad), True)
kbd = InputDevice(name="Remote", caps={e.EV_KEY: [e.KEY_ENTER]})
check("is_gamepad(keyboard)", gs.is_gamepad(kbd), False)
# A DualSense's touchpad node has ABS axes but no face button - shimming it would
# publish a phantom pad.
touch = InputDevice(name="Pad Touchpad", caps={e.EV_KEY: [e.BTN_TOUCH], e.EV_ABS: [(e.ABS_X, AbsInfo(max=1920))]})
check("is_gamepad(touchpad)", gs.is_gamepad(touch), False)

# ---- which pads get shimmed -------------------------------------------------
check("needs_shim(unknown vendor)", gs.needs_shim(pad), True)
check("needs_shim(Sony DualSense)", gs.needs_shim(dev("DualSense", [e.ABS_X, e.ABS_Y], PAD_KEYS, vendor=0x054C)), False)
check("needs_shim(Microsoft)", gs.needs_shim(dev("Xbox pad", [e.ABS_X, e.ABS_Y], PAD_KEYS, vendor=0x045E)), False)
own = InputDevice(name=gs.OUT_NAME, caps={}, vendor=gs.OUT_VENDOR, product=gs.OUT_PRODUCT)
check("needs_shim(our own virtual pad)", gs.needs_shim(own), False)  # no feedback loop

# ---- axis plan: Android-style pad (the Nacon MG-X PRO shape) ----------------
nacon = dev(
    "Nacon MG-X PRO",
    [e.ABS_X, e.ABS_Y, e.ABS_Z, e.ABS_RZ, e.ABS_BRAKE, e.ABS_GAS, e.ABS_HAT0X, e.ABS_HAT0Y],
    PAD_KEYS + [e.BTN_THUMBL, e.BTN_THUMBR],
    vendor=0x3285,
    product=0x0312,
    # The real device: Z/RZ are the right STICK (they rest centred) and BRAKE/GAS are
    # the triggers (they rest at zero). This is what tells the two apart.
    rest={e.ABS_Z: 128, e.ABS_RZ: 128},
)
p = gs.Pad(nacon)
check("nacon right stick X -> RX", p.axis_map[e.ABS_Z], (e.ABS_RX, False))
check("nacon right stick Y -> RY", p.axis_map[e.ABS_RZ], (e.ABS_RY, False))
check("nacon left trigger -> Z", p.axis_map[e.ABS_BRAKE], (e.ABS_Z, True))
check("nacon right trigger -> RZ", p.axis_map[e.ABS_GAS], (e.ABS_RZ, True))
check("nacon hat passes through", p.axis_map[e.ABS_HAT0X], (e.ABS_HAT0X, False))

# ---- axis plan: Xbox-style pad (RX/RY present -> Z/RZ are the triggers) -----
xstyle = dev(
    "Generic X-style",
    [e.ABS_X, e.ABS_Y, e.ABS_RX, e.ABS_RY, e.ABS_Z, e.ABS_RZ, e.ABS_HAT0X, e.ABS_HAT0Y],
    PAD_KEYS,
)
px = gs.Pad(xstyle)
check("x-style right stick", (px.axis_map[e.ABS_RX], px.axis_map[e.ABS_RY]), ((e.ABS_RX, False), (e.ABS_RY, False)))
check("x-style triggers", (px.axis_map[e.ABS_Z], px.axis_map[e.ABS_RZ]), ((e.ABS_Z, True), (e.ABS_RZ, True)))

# ---- scaling ----------------------------------------------------------------
# Sticks: source range -> full signed 16-bit, centred at 0.
check("stick min", p.scale(e.ABS_X, 0), (e.ABS_X, -32768))
check("stick max", p.scale(e.ABS_X, 255), (e.ABS_X, 32767))
mid = p.scale(e.ABS_X, 128)[1]
check("stick centre is near zero", abs(mid) <= 200, True)
# Triggers: 0..255 regardless of what the source used.
wide = dev("Wide", [e.ABS_X, e.ABS_Y, e.ABS_BRAKE, e.ABS_GAS], PAD_KEYS, ranges={e.ABS_BRAKE: (0, 1023)})
pw = gs.Pad(wide)
check("trigger min", pw.scale(e.ABS_BRAKE, 0), (e.ABS_Z, 0))
check("trigger max", pw.scale(e.ABS_BRAKE, 1023), (e.ABS_Z, 255))
check("trigger half", pw.scale(e.ABS_BRAKE, 512)[1] in (127, 128), True)
# Hat: clamped to -1..1 even if the source reports a wider range.
check("hat clamps", p.scale(e.ABS_HAT0X, 7), (e.ABS_HAT0X, 1))
check("hat clamps negative", p.scale(e.ABS_HAT0X, -7), (e.ABS_HAT0X, -1))
# A degenerate axis (min == max) must not divide by zero.
flat = dev("Flat", [e.ABS_X, e.ABS_Y], PAD_KEYS, ranges={e.ABS_X: (0, 0)})
check("degenerate axis", gs.Pad(flat).scale(e.ABS_X, 0), (e.ABS_X, 0))


# ---- event translation ------------------------------------------------------
class Ev:
    def __init__(self, type, code, value):
        self.type, self.code, self.value = type, code, value


check("BTN_A passes through", p.translate(Ev(e.EV_KEY, e.BTN_A, 1)), (e.EV_KEY, e.BTN_A, 1))
check("BTN_C is dropped", p.translate(Ev(e.EV_KEY, e.BTN_C, 1)), None)  # not in the xpad set
check("unmapped axis dropped", p.translate(Ev(e.EV_ABS, e.ABS_WHEEL, 5)), None)
check("mapped axis translated", p.translate(Ev(e.EV_ABS, e.ABS_Z, 255)), (e.EV_ABS, e.ABS_RX, 32767))
check("syn dropped", p.translate(Ev(e.EV_SYN, 0, 0)), None)

if fails:
    print("FAIL")
    for f in fails:
        print(" -", f)
    sys.exit(1)
print("gamepad_shim: all checks passed")

# ---- a trigger pair must never be adopted as the right stick --------------------
# The bug this pins: RIGHT_STICK_PAIRS falls back to Z/RZ whenever RX/RY are absent,
# so a pad whose Z/RZ are TRIGGERS (resting at 0) had them mapped to the right stick -
# and scale() then reported that stick pinned hard up+left forever.
trigpad = dev("Triggers on Z/RZ", [e.ABS_X, e.ABS_Y, e.ABS_Z, e.ABS_RZ, e.ABS_HAT0X, e.ABS_HAT0Y], PAD_KEYS)
pt = gs.Pad(trigpad)
check("Z/RZ resting at zero are triggers", pt.axis_map.get(e.ABS_Z), (e.ABS_Z, True))
check("…and not the right stick", pt.axis_map.get(e.ABS_Z) != (e.ABS_RX, False), True)
check("a trigger at rest reads 0, not -32768", pt.scale(e.ABS_Z, 0), (e.ABS_Z, 0))

# ---- a hat pair resting at 0 must not be adopted as triggers -------------------
hat2 = dev(
    "Second hat",
    [e.ABS_X, e.ABS_Y, e.ABS_HAT2X, e.ABS_HAT2Y],
    PAD_KEYS,
    ranges={e.ABS_HAT2X: (-1, 1), e.ABS_HAT2Y: (-1, 1)},
    rest={e.ABS_HAT2X: 0, e.ABS_HAT2Y: 0},
)
check("a centred hat is not a trigger", gs.Pad(hat2).axis_map.get(e.ABS_HAT2Y), None)

# ---- a button-only D-pad survives the shim ------------------------------------
dpad = dev("Buttons-only dpad", [e.ABS_X, e.ABS_Y], PAD_KEYS + [e.BTN_DPAD_UP, e.BTN_DPAD_LEFT])
pd = gs.Pad(dpad)
check("dpad button -> hat press", pd.translate(Ev(e.EV_KEY, e.BTN_DPAD_UP, 1)), (e.EV_ABS, e.ABS_HAT0Y, -1))
check("dpad button -> hat release", pd.translate(Ev(e.EV_KEY, e.BTN_DPAD_LEFT, 0)), (e.EV_ABS, e.ABS_HAT0X, 0))
check("a pad WITH a hat keeps its hat", gs.Pad(nacon).translate(Ev(e.EV_KEY, e.BTN_DPAD_UP, 1)), None)

# ---- digital shoulder triggers when there are no analog ones -------------------
digi = dev("Digital LT/RT", [e.ABS_X, e.ABS_Y], PAD_KEYS + [e.BTN_TL2, e.BTN_TR2])
check("BTN_TL2 -> full-scale Z", gs.Pad(digi).translate(Ev(e.EV_KEY, e.BTN_TL2, 1)), (e.EV_ABS, e.ABS_Z, 255))

# ---- out-of-range values are clamped ------------------------------------------
check("over-range stick clamps", p.scale(e.ABS_X, 9999), (e.ABS_X, 32767))
check("under-range trigger clamps", pw.scale(e.ABS_BRAKE, -50), (e.ABS_Z, 0))

if fails:
    print("FAIL")
    for f in fails:
        print(" -", f)
    sys.exit(1)
print("gamepad_shim: all checks passed (extended)")
