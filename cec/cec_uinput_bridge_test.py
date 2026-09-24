#!/usr/bin/env python3
"""Offline unit tests for how cec_uinput_bridge.py turns CEC key messages into
uinput key events (run: python3 cec/cec_uinput_bridge_test.py).

`evdev` is not installed on a CI runner, so a stub with the kernel's real code
values is injected before the import, the same way the remote bridge's tests do.

What matters here is the difference between a press and a hold. A TV that
repeats <User Control Pressed> while a button is held must produce ONE key that
stays down, not a fresh press per repeat: a fresh keydown is what a
press-twice confirm counts as the second press.
"""
import os
import sys
import types

ec = types.ModuleType("evdev.ecodes")
CODES = {
    "EV_KEY": 0x01,
    "KEY_ENTER": 28,
    "KEY_UP": 103,
    "KEY_DOWN": 108,
    "KEY_LEFT": 105,
    "KEY_RIGHT": 106,
    "KEY_CHANNELUP": 402,
    "KEY_CHANNELDOWN": 403,
    "KEY_PLAYPAUSE": 164,
    "KEY_STOP": 128,
    "KEY_REWIND": 168,
    "KEY_FASTFORWARD": 208,
    "KEY_NEXTSONG": 163,
    "KEY_PREVIOUSSONG": 165,
    "KEY_BACKSPACE": 14,
    "KEY_HOMEPAGE": 172,
}
for _n, _v in CODES.items():
    setattr(ec, _n, _v)
evdev = types.ModuleType("evdev")
evdev.ecodes = ec
evdev.UInput = object
sys.modules["evdev"] = evdev
sys.modules["evdev.ecodes"] = ec

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cec_uinput_bridge as cub  # noqa: E402

FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append(name)
        print("FAIL %s\n  got  %r\n  want %r" % (name, got, want))
        return
    print("ok", name)


class FakeUI:
    def __init__(self):
        self.events = []

    def write(self, _type, key, value):
        self.events.append((key, value))

    def syn(self):
        pass


class FakeTimer:
    """A timer the test fires by hand, so no test waits on a clock."""

    armed = []

    def __init__(self, delay, fn):
        self.fn = fn
        self.cancelled = False
        self.daemon = False

    def start(self):
        FakeTimer.armed.append(self)

    def cancel(self):
        self.cancelled = True

    def fire(self):
        if not self.cancelled:
            self.fn()


def bridge(sends_release=True):
    now = [100.0]
    FakeTimer.armed = []
    b = cub.Bridge(FakeUI(), clock=lambda: now[0], timer=FakeTimer)
    if sends_release:
        b.on_release()  # the TV has shown it sends the release message
    return b, now


def last_timer():
    return FakeTimer.armed[-1]


ENTER = CODES["KEY_ENTER"]
UP = CODES["KEY_UP"]

# A spec TV: press, repeats while held, then the release message.
b, now = bridge()
b.on_press(0x00)
for _ in range(4):
    now[0] += 0.45
    b.on_press(0x00)
b.on_release()
check("a held OK is one keydown and one keyup", b.ui.events, [(ENTER, 1), (ENTER, 0)])

# A TV that sends press+release for every press (an LG): each is its own press.
b, now = bridge()
b.on_press(0x00)
b.on_release()
now[0] += 0.3
b.on_press(0x00)
b.on_release()
check("two presses with a release between are two", b.ui.events, [(ENTER, 1), (ENTER, 0), (ENTER, 1), (ENTER, 0)])

# No release message and no repeat: the button is let go after the gap.
b, now = bridge()
b.on_press(0x01)
check("still down before the gap runs out", b.ui.events, [(UP, 1)])
last_timer().fire()
check("released when it does", b.ui.events, [(UP, 1), (UP, 0)])
now[0] += 1.0
b.on_press(0x01)
check("and a later press is a new one", b.ui.events, [(UP, 1), (UP, 0), (UP, 1)])

# A different button while one is held lets the first go.
b, now = bridge()
b.on_press(0x01)
now[0] += 0.2
b.on_press(0x00)
check("another button releases the held one", b.ui.events, [(UP, 1), (UP, 0), (ENTER, 1)])

# A stale timer that fires after a repeat re-armed must not release the key.
b, now = bridge()
b.on_press(0x00)
first = last_timer()
now[0] += 0.45
b.on_press(0x00)
first.fn()  # fired anyway, as a timer already running cannot be cancelled
check("a stale timer does not let go of a held button", b.ui.events, [(ENTER, 1)])

# Holding Back is one Back, never the double tap that means Home.
b, now = bridge()
b.on_press(cub.BACK_CODE)
now[0] += 0.3
b.on_press(cub.BACK_CODE)
check(
    "a held Back is one Back",
    b.ui.events,
    [(CODES["KEY_BACKSPACE"], 1), (CODES["KEY_BACKSPACE"], 0)],
)

# A TV that never sends the release message keeps the old behaviour: every
# press is a tap, so two quick Backs are still the double tap that means Home.
b, now = bridge(sends_release=False)
b.on_press(cub.BACK_CODE)
now[0] += 0.3
b.on_press(cub.BACK_CODE)
BS, HOME = CODES["KEY_BACKSPACE"], CODES["KEY_HOMEPAGE"]
check("without release messages, a Back double tap is Home", b.ui.events, [(BS, 1), (BS, 0), (BS, 1), (BS, 0), (HOME, 1), (HOME, 0)])
b, now = bridge(sends_release=False)
b.on_press(0x00)
check("and a press is a whole tap", b.ui.events, [(ENTER, 1), (ENTER, 0)])

check("the release message is recognised", bool(cub.RX_RELEASE.search(">> 04:45")), True)
check("and a Stop press is not it", bool(cub.RX_RELEASE.search(">> 04:44:45")), False)

if FAILED:
    print("\n%d failed" % len(FAILED))
    sys.exit(1)
print("\nall passed")
