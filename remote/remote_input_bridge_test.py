#!/usr/bin/env python3
"""Offline unit tests for the hidraw button decode in remote_input_bridge.py
(run: python3 remote/remote_input_bridge_test.py).

`evdev` isn't installed on a CI runner and needs a real /dev/input to be useful,
so a stub module with the REAL kernel code values is injected before the import.
A name the bridge starts using and this dict lacks fails the import loudly,
which is the point - the numbers must be the kernel's, not invented.

The reports below are captured off real remotes: an AFTKA-era "AR" (PID 0x0414)
and a Remote Pro (PID 0x0425). What the decode has to get right is that these
are HID ARRAY reports whose usages are 16 bits wide on the consumer page - the
Remote Pro puts its two customizable buttons and its headphone button above
0xFF, where a byte-wide read cannot see them at all.
"""
import os
import sys
import types

# ---- evdev stub -------------------------------------------------------------
ec = types.ModuleType("evdev.ecodes")
CODES = {  # linux/input-event-codes.h
    "EV_KEY": 0x01,
    "EV_REL": 0x02,
    "EV_ABS": 0x03,
    "KEY_ENTER": 28,
    "KEY_KPENTER": 96,
    "KEY_UP": 103,
    "KEY_LEFT": 105,
    "KEY_RIGHT": 106,
    "KEY_DOWN": 108,
    "KEY_MUTE": 113,
    "KEY_VOLUMEDOWN": 114,
    "KEY_VOLUMEUP": 115,
    "KEY_POWER": 116,
    "KEY_BACKSPACE": 14,
    "KEY_STOP": 128,
    "KEY_NEXTSONG": 163,
    "KEY_PLAYPAUSE": 164,
    "KEY_PREVIOUSSONG": 165,
    "KEY_REWIND": 168,
    "KEY_HOMEPAGE": 172,
    "KEY_FASTFORWARD": 208,
    "KEY_UNKNOWN": 240,
    "KEY_OK": 0x160,
    "KEY_SELECT": 0x161,
}
for _n, _v in CODES.items():
    setattr(ec, _n, _v)

evdev = types.ModuleType("evdev")
evdev.ecodes = ec
evdev.InputDevice = object
evdev.UInput = object
evdev.list_devices = lambda: []
sys.modules["evdev"] = evdev
sys.modules["evdev.ecodes"] = ec

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import remote_input_bridge as rib  # noqa: E402

MAC = "aa:bb:cc:dd:ee:ff"
FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append(name)
        print("FAIL %s\n  got  %r\n  want %r" % (name, got, want))
        return
    print("ok", name)


class FakeBridge:
    """Just enough of Bridge for handle_hidraw. drop_hidraw is the REAL one, so
    the release-what-was-held path is exercised rather than stubbed out."""

    def __init__(self, fd):
        self.hidraws = {fd: {"path": "/dev/hidrawX", "mac": MAC, "down": set(), "out_of_band": set()}}
        self.events = []
        self.dropped = []

    def dispatch(self, did, code, value):
        self.events.append((code, value))

    def drop_hidraw(self, fd):
        self.dropped.append(fd)
        rib.Bridge.drop_hidraw(self, fd)


class Remote:
    """A pipe standing in for the remote's hidraw node."""

    def __init__(self):
        self.r, self.w = os.pipe()
        self.bridge = FakeBridge(self.r)

    def send(self, report):
        os.write(self.w, bytes(report))
        rib.Bridge.handle_hidraw(self.bridge, self.r)

    def eof(self):
        os.close(self.w)
        self.w = None
        rib.Bridge.handle_hidraw(self.bridge, self.r)

    def read_error(self):
        os.close(self.r)  # a closed fd makes os.read raise, as a vanished node does
        rib.Bridge.handle_hidraw(self.bridge, self.r)
        self.r = None

    def close(self):
        for fd in (self.r, self.w):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass

    @property
    def events(self):
        return self.bridge.events

    @property
    def held(self):
        h = self.bridge.hidraws.get(self.r)
        return set(h["down"]) if h else None  # None = the node was dropped

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def feed(reports):
    """Push raw reports through handle_hidraw and return the (code, value) list."""
    with Remote() as rem:
        for rep in reports:
            rem.send(rep)
        return rem.events


# ---- Remote Pro: the three buttons that a byte-wide read cannot reach --------
# Captured on a Remote Pro (PID 0x0425): consumer usages 0x27E/0x27F/0x280,
# which its Fire OS keylayout calls CUSTOMIZABLE BUTTON 1 / 2 / HEADSET.
for usage, label in ((0x27E, "customizable 1"), (0x27F, "customizable 2"), (0x280, "headphone")):
    with Remote() as rem:
        rem.send([0x02, usage & 0xFF, usage >> 8, 0, 0])
        rem.send([0x02, 0, 0, 0, 0])
        check("Remote Pro %s presses and releases" % label, rem.events, [(0x400 + usage, 1), (0x400 + usage, 0)])
        check("Remote Pro %s leaves nothing held" % label, rem.held, set())

# ---- the shell's 2048 code cap, at the edge that decides it -----------------
# A code the UI can learn but config.js sanitizeDevices then drops is a button
# that appears to bind and silently does nothing, so test the band's last usage
# and the first one past it - not a comfortable value in the middle.
check("the band's last usage is still under the cap", feed([[0x02, 0xFF, 0x03, 0, 0]]), [(2047, 1)])
check("a usage past the band is refused", feed([[0x02, 0x00, 0x04, 0, 0]]), [])

# ---- the vendor app-button report is 8-bit and must keep working ------------
check("Netflix app button", feed([[0xEF, 0xA2, 0, 0, 0], [0xEF, 0, 0, 0, 0]]), [(0x300 + 0xA2, 1), (0x300 + 0xA2, 0)])

# The AR remote's other documented reports, which existing keymaps store by
# NUMBER: these codes may never shift.
check("hamburger keeps its code", feed([[0x02, 0x33, 0, 0, 0]]), [(0x433, 1)])
check("app switcher keeps its code", feed([[0x02, 0x02, 0, 0, 0]]), [(0x402, 1)])
check("same code on different reports differs", feed([[0xEF, 0x33, 0, 0, 0]]), [(0x333, 1)])

# ---- the report is longer than the descriptor declares ----------------------
# These remotes pad: a 0xEF report reads 5 bytes for 3 declared slots. Decoding
# the padding invents a button that no release ever clears.
with Remote() as rem:
    rem.send([0xEF, 0xA2, 0, 0, 0x5A])
    check("padding past the declared slots is not a button", rem.events, [(0x3A2, 1)])
    check("and nothing phantom is left held", rem.held, {0x3A2})

# A slot count one too small loses a simultaneous button, so fill all three.
check(
    "the last declared slot is still decoded",
    feed([[0xEF, 0xA1, 0xA2, 0xA3, 0]]),
    [(0x3A1, 1), (0x3A2, 1), (0x3A3, 1)],
)

# The consumer report has 2 slots; a longer read must not decode a third.
check(
    "a third consumer slot is not decoded",
    feed([[0x02, 0x7E, 0x02, 0, 0, 0x5A, 0x00]]),
    [(0x67E, 1)],
)

# ---- an array report carries more than one button ---------------------------
check(
    "two app buttons held, released one at a time",
    feed([[0xEF, 0xA1, 0xA2, 0, 0], [0xEF, 0xA1, 0, 0, 0], [0xEF, 0, 0, 0, 0]]),
    [(0x3A1, 1), (0x3A2, 1), (0x3A2, 0), (0x3A1, 0)],
)

# ---- one report id must never release the other's buttons -------------------
# Both bands share one held set, so only the band filter keeps them apart.
with Remote() as rem:
    rem.send([0xEF, 0xA1, 0, 0, 0])
    rem.send([0x02, 0x7E, 0x02, 0, 0])
    rem.send([0xEF, 0, 0, 0, 0])
    check("bands are released independently", rem.events, [(0x3A1, 1), (0x67E, 1), (0x3A1, 0)])
    check("the other band's button is still held", rem.held, {0x67E})

# ---- a report repeated while held is not a second press ---------------------
# It reaches panic_tap otherwise, and eight of those wipe the remote's keymap.
check(
    "held button repeats without re-pressing",
    feed([[0x02, 0x7E, 0x02, 0, 0], [0x02, 0x7E, 0x02, 0, 0], [0x02, 0, 0, 0, 0]]),
    [(0x67E, 1), (0x67E, 0)],
)

# ---- reports we must not act on ---------------------------------------------
# 0x01 mirrors keys evdev already delivers; decoding it would double every arrow.
check("keyboard report is ignored", feed([[0x01, 0x4F, 0, 0, 0, 0, 0, 0, 0]]), [])

# A read short of the declared slots cannot say which buttons went up, so it
# must say nothing - whether it is short by part of a slot or by a whole one.
for short, label in (([0x02, 0x7E], "part of a slot"), ([0x02, 0x33, 0x00, 0x7E], "a whole slot")):
    with Remote() as rem:
        rem.send([0x02, 0x7E, 0x02, 0, 0])
        rem.send(short)
        check("a read short by %s releases nothing" % label, rem.events, [(0x67E, 1)])
        check("and the button stays held (%s)" % label, rem.held, {0x67E})

with Remote() as rem:
    rem.send([0xEF, 0xA1, 0xA2, 0xA3, 0])
    rem.send([0xEF, 0xA1])  # short by two whole slots
    check("a short app report releases nothing", rem.held, {0x3A1, 0x3A2, 0x3A3})

# ---- the BLE link dropping mid-press ----------------------------------------
# This box's link drops constantly. A held button that is never released leaves
# the compositor auto-repeating it forever, so the drop has to close it out.
with Remote() as rem:
    rem.send([0xEF, 0xA1, 0, 0, 0])
    rem.read_error()
    check("a vanished node releases what it held", rem.events, [(0x3A1, 1), (0x3A1, 0)])
    check("and the node is dropped once", len(rem.bridge.dropped), 1)

with Remote() as rem:
    rem.send([0xEF, 0xA1, 0, 0, 0])
    rem.eof()
    check("EOF releases what it held", rem.events, [(0x3A1, 1), (0x3A1, 0)])
    check("and EOF drops the node rather than spinning select", rem.held, None)

# ---- names shown in the button test -----------------------------------------
check("consumer usage name", rib.key_name(0x400 + 0x27E), "CC_027E")
check("app button name", rib.key_name(0x300 + 0xA2), "APP_A2")

if FAILED:
    print("\n%d FAILED: %s" % (len(FAILED), ", ".join(FAILED)))
    sys.exit(1)
print("\nall remote_input_bridge tests passed")
