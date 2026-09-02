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
import json
import os
import sys
import tempfile
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

# ---- ir:<action>: a blast on a button the remote has no key of its own for ----
# The Remote Pro's headphone button is consumer usage 0x0280, i.e. virtual code
# 0x480 here - a button the remote's own IR keymap cannot reach, because the
# keymap binds SCAN IDS and only the four keys Fire OS programs have one. A blast
# is bound to no key at all, so the box can fire any code the plan carries when it
# sees the press.


def keymaps_with(keymap):
    """load_keymaps() reads the box config; point it at a temp file."""
    d = tempfile.mkdtemp()
    path = os.path.join(d, "config.json")
    with open(path, "w") as f:
        json.dump({"remote": {"devices": {MAC: {"keymap": keymap}}}}, f)
    old = rib.CONFIG
    rib.CONFIG = path
    try:
        return rib.load_keymaps().get(MAC, {})
    finally:
        rib.CONFIG = old


check(
    "an ir: binding survives the keymap loader",
    keymaps_with({"ir:soundbar_power": [0x480], "settings": [643]}),
    {0x480: "ir:soundbar_power", 643: "settings"},
)
# The charset is the charset: these would each reach the shell as an action name.
check(
    "a malformed ir: binding is dropped",
    keymaps_with({"ir:BAD NAME": [1], "ir:": [2], "ir:x/../y": [3], "ir:" + "a" * 33: [4]}),
    {},
)


def ir_actions_for(ir):
    """load_ir_actions() against a real config file - which is the point.

    The first cut of these tests built FakeIr with the action set passed in, and so
    stubbed out the one function that was broken: `ready` had no arm for the firetv
    backend, and the set was filtered through IR_KEY_ACTION, so it could only ever
    hold the three volume actions however the box was configured. Every `ir:<name>`
    binding was refused at press time and nothing said why.
    """
    d = tempfile.mkdtemp()
    path = os.path.join(d, "config.json")
    with open(path, "w") as f:
        json.dump({"ir": ir}, f)
    old = rib.CONFIG
    rib.CONFIG = path
    try:
        return rib.load_ir_actions()
    finally:
        rib.CONFIG = old


ALL = {"volume_up": "Signal0", "input_hdmi2": "tv:HDMI2", "soundbar_power": "audio:Power"}
check(
    "esphome offers every mapped action, not just volume",
    ir_actions_for({"backend": "esphome", "esphome": {"host": "ir.local", "actions": ALL}}),
    {"volume_up", "input_hdmi2", "soundbar_power"},
)
# A MAC that is not one reads as "the blaster is configured" and diverts the remote's
# own volume keys to something that can never answer. The shell holds this to MAC_RE on
# save AND on read, so a restored or hand-edited config.json is how one arrives here.
for mac, name in (
    ("not-a-mac", "a hand-edited MAC leaves IR off"),
    ("7C:ED:C6:12:E6", "so does a truncated one"),
    ("7C-ED-C6-12-E6-3C", "so does the wrong separator"),
    ("", "and so does an empty one"),
):
    check(name, ir_actions_for({"backend": "firetv", "firetv": {"mac": mac, "actions": ALL}}), set())

check(
    "firetv is a MAC, not a url and a token",
    ir_actions_for({"backend": "firetv", "firetv": {"mac": "7C:ED:C6:12:E6:3C", "actions": ALL}}),
    {"volume_up", "input_hdmi2", "soundbar_power"},
)
check(
    "home assistant still needs both halves",
    ir_actions_for({"backend": "homeassistant", "homeassistant": {"url": "http://ha", "actions": ALL}}),
    set(),
)
check(
    "a backend with nothing behind it is IR off",
    ir_actions_for({"backend": "firetv", "firetv": {"actions": ALL}}),
    set(),
)
check("no ir section at all", ir_actions_for(None), set())
# The shell owns the real vocabulary and refuses an action it does not know; what is
# held here is only the charset, so a mangled config cannot put anything else on a wire.
check(
    "a name outside the charset is dropped",
    ir_actions_for({"backend": "esphome", "esphome": {"host": "h", "actions": {"in put": "x", "OK": "y", "": "z"}}}),
    set(),
)


class FakeIr:
    """Just enough of Bridge for do_special / press_action."""

    def __init__(self, actions):
        self.ir_actions = set(actions)
        self.blasts = []
        self.posts = []

    def ir_press(self, action, value):
        self.blasts.append((action, value))

    def shell_post(self, url, payload):
        self.posts.append((url, payload))

    def do_power(self):
        self.posts.append(("power", None))

    # The real one, so press_action's route through it is exercised rather than stubbed.
    def do_special(self, action):
        rib.Bridge.do_special(self, action)


fb = FakeIr(["soundbar_power"])
rib.Bridge.do_special(fb, "ir:soundbar_power")
# value 1 = one press. A blast is a single command - a power toggle sent twice undoes
# itself - and on the firetv backend each one is its own BLE connect, so an autorepeat
# would queue seconds of work per held second. handle() sends only value==1 here, the
# same branch the other box behaviours take.
check("a mapped ir action blasts once", fb.blasts, [("soundbar_power", 1)])
check("and nothing else is posted", fb.posts, [])

fb = FakeIr([])
logged = []
real_log = rib.log
rib.log = lambda *a: logged.append(" ".join(str(x) for x in a))
try:
    rib.Bridge.do_special(fb, "ir:soundbar_power")
finally:
    rib.log = real_log
# The blaster's action map and the button binding are edited on different screens, so
# this state is reachable. Emitting some key instead would act on the BOX when the user
# asked for the television, so it does nothing - and says so, or the press leaves no
# trace anywhere.
check("an unmapped ir action does nothing", fb.blasts, [])
check("and is logged", [l for l in logged if "soundbar_power" in l] != [], True)

fb = FakeIr(["input_hdmi2"])
check("the phone remote can send one too", rib.Bridge.press_action(fb, "ir:input_hdmi2"), True)
check("and it is the same single blast", fb.blasts, [("input_hdmi2", 1)])

# Hammering an ir: button must not wipe the remote's keymap. Stepping the TV's input
# means pressing until the right one appears, and a blast that fails is silent from the
# sofa - so pressing again is exactly what a person does, and the gesture would delete a
# binding no screen can recreate.
km = {"ir:input_next": [0x480], "back": [158]}
fb = FakeIr([])
fb.keymaps = {MAC: {0x480: "ir:input_next", 158: "back"}}
fb.learning = None
fb._panic = {}
fired = [rib.Bridge.panic_tap(fb, MAC, 0x480) for _ in range(rib.PANIC_TAPS + 2)]
check("hammering an ir: button never panics", any(fired), False)
# ...while an ordinary remapped button still can, or the recovery gesture is gone.
fb._panic = {}
fired = [rib.Bridge.panic_tap(fb, MAC, 158) for _ in range(rib.PANIC_TAPS)]
check("hammering a remapped key still panics", fired[-1], True)

# A remote whose config names an action the blaster does not have is not a reason to
# treat the binding as a KEY: press_action must not fall through to emitting one.
fb = FakeIr([])
real_log = rib.log
rib.log = lambda *a: None
try:
    check("an unmapped one is still handled, not emitted as a key", rib.Bridge.press_action(fb, "ir:nope"), True)
finally:
    rib.log = real_log

if FAILED:
    print("\n%d FAILED: %s" % (len(FAILED), ", ".join(FAILED)))
    sys.exit(1)
print("\nall remote_input_bridge tests passed")
