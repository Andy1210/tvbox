#!/usr/bin/env python3
"""tvbox remote input bridge - per-device button remap for BT/USB remotes.

The launcher receives input as ordinary keyboard events, and a "standard" remote
(arrows / Enter / Back / Home / media) already works. This daemon adds a
PER-DEVICE remap so a user can teach the box any remote's buttons - and remapping
one remote never touches another (the renderer can't tell devices apart; only
here, at /dev/input, is there a device identity).

How it works, mirroring the CEC bridge (systemd USER unit, no root - /dev/input
read comes from `input` group, /dev/uinput write from the udev grant provision
sets up):

  * It EVIOCGRABs every remote/keyboard input device (so the raw key doesn't ALSO
    reach the compositor and fire twice) and re-emits keys through ONE uinput
    device. Unmapped buttons pass straight through, so with no config the box
    behaves exactly as before. If this process dies the kernel releases every
    grab, so a crash degrades to the remote's raw (un-remapped) keys - never a
    dead remote.
  * A per-device override maps one of the device's button codes to an ACTION; the
    action is emitted as its canonical key (KEY_UP/ENTER/BACKSPACE/HOMEPAGE/media).
    SPECIAL actions emit no key at all: "power" runs the Power-button policy (CEC
    TV toggle) and "settings" opens the launcher's Settings - so a remote without
    a (working) power button can borrow any spare button for them.
  * Volume keys are special when an IR blaster is configured (config.ir): they
    are swallowed and forwarded to the shell (/tvbox/api/ir/send), which relays
    them to the TV over IR - see shell/ir.js. Without IR config they pass through.
  * Learn mode (driven by the shell over a FIFO): the next button pressed on the
    chosen device is reported to a file the shell reads, and swallowed.

Files (all under ~/.tvbox):
  config.json         read   - remote.devices[<id>].keymap = { action: [codes] }
  remote-devices.json write  - [{ id, name }] currently-managed remotes (for the UI)
  remote-learned.json write  - { id, code, name } last button captured in learn mode
/tmp/tvbox-remote-cmd  FIFO  - commands from the shell: reload | learn <id> | learn-off
"""
import json
import os
import queue
import re
import select
import stat
import subprocess
import sys
import threading
import time
import urllib.request

from evdev import InputDevice, UInput, ecodes as e, list_devices

HOME = os.path.expanduser("~")
TVBOX = os.path.join(HOME, ".tvbox")
CONFIG = os.path.join(TVBOX, "config.json")
DEVICES_OUT = os.path.join(TVBOX, "remote-devices.json")
LEARNED_OUT = os.path.join(TVBOX, "remote-learned.json")
CMD_FIFO = "/tmp/tvbox-remote-cmd"
# The CEC bridge's command FIFO - we drop "standby 0" here to turn the TV off.
CEC_CMD_FIFO = "/tmp/tvbox-cec-cmd"

OUT_NAME = "tvbox-remote-bridge"

# What the remote's Power button does (config.remote.power). The button always
# reaches us over BT as KEY_POWER; we never pass it to the system (logind would
# power off the box). Default: turn the TV off over CEC only.
POWER_TV = "tv"  # CEC standby to the TV, box stays on (default)
POWER_TV_AND_BOX = "tv_and_box"  # TV off + power the box off (needs manual power-on)
POWER_IGNORE = "ignore"  # do nothing
POWER_VALUES = (POWER_TV, POWER_TV_AND_BOX, POWER_IGNORE)

# Action -> the canonical key we emit for it. Unmapped buttons pass through
# unchanged, so this only governs buttons the user explicitly remapped. back is
# KEY_BACKSPACE to match the CEC bridge (the launcher's primary Back key); a Fire
# TV's native Back (KEY_BACK) still passes through and is handled too.
ACTION_KEY = {
    "up": e.KEY_UP,
    "down": e.KEY_DOWN,
    "left": e.KEY_LEFT,
    "right": e.KEY_RIGHT,
    "ok": e.KEY_ENTER,
    "back": e.KEY_BACKSPACE,
    "home": e.KEY_HOMEPAGE,
    "playpause": e.KEY_PLAYPAUSE,
    "stop": e.KEY_STOP,
    "rewind": e.KEY_REWIND,
    "fastforward": e.KEY_FASTFORWARD,
    "prev": e.KEY_PREVIOUSSONG,
    "next": e.KEY_NEXTSONG,
    "volume_up": e.KEY_VOLUMEUP,
    "volume_down": e.KEY_VOLUMEDOWN,
    "mute": e.KEY_MUTE,
}

# TV volume over the IR blaster (shell ir.js). When config.ir maps one of these
# actions, the matching volume key (native OR remapped) is swallowed here and
# POSTed to the shell instead of reaching the compositor - the remote drives
# the TV's speakers, not the box. With no IR config they pass through unchanged.
IR_KEY_ACTION = {
    e.KEY_VOLUMEUP: "volume_up",
    e.KEY_VOLUMEDOWN: "volume_down",
    e.KEY_MUTE: "mute",
}
IR_SEND_URL = "http://127.0.0.1:8097/tvbox/api/ir/send"
IR_REPEAT_S = 0.3  # min gap between sends while a volume key autorepeats

# Remap actions that do NOT emit a key: they trigger box behavior instead.
#   power    - TV on/off toggle via the CEC bridge (per the config.remote.power
#              policy, same as a real KEY_POWER) - for remotes whose own power
#              button never reaches us (e.g. Fire TV remotes send it IR-only)
#   settings - open the launcher's Settings screen (shell /tvbox/api/nav)
#   app:<id> - launch that app (a remote's dedicated app button -> any tile)
#   appswitcher - cycle through the RUNNING (background) apps, FireTV-style
SPECIAL_ACTIONS = ("power", "settings", "appswitcher")
APP_ACTION_RE = re.compile(r"^app:[a-z0-9_-]{1,32}$")
NAV_URL = "http://127.0.0.1:8097/tvbox/api/nav"
RESET_URL = "http://127.0.0.1:8097/tvbox/api/remote/reset"

# Learn mode arms in reaction to a UI press (Enter on the learn row), over
# HTTP + FIFO - so the tail of that same interaction (a fast double-press, a
# late autorepeat) can still be in flight when we arm. Captures inside this
# window would bind the wrong button, so they are swallowed but NOT captured.
LEARN_ARM_DELAY_S = 0.3
# Safety net: learn mode swallows the whole remote, and after a capture it
# stays armed until the shell's learn-off. If the shell dies mid-learn that
# learn-off never comes - auto-disarm so a remote can never stay eaten. Longer
# than the UI's own 10s learn timeout.
LEARN_TIMEOUT_S = 15.0

# Panic recovery: if a remote gets remapped so badly the user can't navigate the
# menu to fix it, hammering the SAME physical button PANIC_TAPS times (each tap
# within PANIC_GAP_S of the previous) resets THAT remote's remapping. Detected
# on the RAW incoming code, but only for codes that ARE remapped on that device
# (an unmapped button already works) AND whose action isn't one that normal use
# legitimately hammers - volume pumping, tap-scrolling a list, seek-stepping,
# app-cycling must never wipe a config. A stuck remote virtually always has a
# non-repeat-prone action (ok/back/home/settings/...) remapped somewhere to
# hammer; failing that, the TV's CEC remote and the on-screen reset remain.
PANIC_TAPS = 8
PANIC_GAP_S = 0.4
PANIC_EXEMPT_ACTIONS = frozenset(
    ("up", "down", "left", "right", "volume_up", "volume_down",
     "rewind", "fastforward", "prev", "next", "appswitcher")
)

# Fire TV / Alexa remotes send several buttons as HID reports that a generic
# kernel maps to no usable key, so they never reach evdev (or only as the
# indistinguishable KEY_UNKNOWN, which handle() drops) - the button test can't
# see them. We read them straight from the remote's hidraw node and inject a
# VIRTUAL keycode: a per-report-id base + the raw code byte, bands above
# KEY_MAX (0x2ff) that can never collide with a real evdev key yet stay under
# the shell config's 2048 code cap. So EVERY such button, whatever byte it
# sends, flows through the SAME per-device remap/learn pipeline (nothing is
# hardcoded per button; the set varies by remote generation). Virtual codes
# are never written to uinput: unmapped ones do nothing (exactly as without
# the bridge), mapped ones emit their action's canonical key.
#
# Report ids (observed on an AFTKA-era "AR" remote):
#   0xEF - vendor app buttons (Netflix / Prime / Disney+ / Music): byte[1] =
#          button code (0xA1..), 0x00 = release
#   0x02 - consumer-control report carrying the hamburger / app-switcher
#          style buttons (evdev shows them only as KEY_UNKNOWN): byte[1] =
#          code (e.g. 0x33 hamburger, 0x02 app switcher), 0x00 = release
#   0x01 - mirrors the ordinary keyboard keys evdev already delivers: MUST
#          stay ignored or every arrow press would fire twice
#
# Reading hidraw needs the udev grant provision.sh adds for Amazon-VID
# (0x0171) remotes; without it the feature is simply inert (the open fails
# and is skipped).
APP_BTN_REPORTS = {0xEF: 0x300, 0x02: 0x400}  # report id -> virtual code base
APP_BTN_VIRT_BASE = 0x300  # floor of the virtual bands


def hidraw_nodes_for(remote_ids):
    """{ /dev/hidrawN: canonical_id } for hidraw nodes whose remote (sysfs
    HID_UNIQ) is a currently-managed remote. `remote_ids` maps lowercased id ->
    the CANONICAL evdev id: the match is case-insensitive (BlueZ formats BLE
    uniq case differently across stacks) but dispatch must use the exact same
    id as the evdev path, or learn/keymap lookups silently never match. Only
    Amazon-VID nodes are actually openable (the provision udev grant), so
    other remotes are skipped naturally."""
    out = {}
    try:
        names = os.listdir("/sys/class/hidraw")
    except OSError:
        return out
    for name in names:
        try:
            with open("/sys/class/hidraw/%s/device/uevent" % name) as f:
                info = dict(l.split("=", 1) for l in f.read().splitlines() if "=" in l)
        except OSError:
            continue
        mac = (info.get("HID_UNIQ") or "").strip().lower()
        if mac and mac in remote_ids:
            out["/dev/" + name] = remote_ids[mac]
    return out

# Only manage things that are actually remotes/keyboards: they must expose at
# least one of these navigation/select keys. This skips pure pointers, the HDMI
# CEC receivers, audio jacks, etc.
NAV_KEYS = {e.KEY_ENTER, e.KEY_KPENTER, e.KEY_OK, e.KEY_SELECT, e.KEY_UP, e.KEY_LEFT, e.KEY_RIGHT, e.KEY_DOWN}
# Never grab these (built-ins + our own / the CEC bridge's virtual keyboards).
EXCLUDE_EXACT = {OUT_NAME, "tvbox-cec-remote", "pwr_button"}


def log(*a):
    print("[remote-bridge]", *a, file=sys.stderr, flush=True)


# TVBOX_HIDRAW_DEBUG=1 (service drop-in / env): log EVERY raw input the bridge
# receives - each evdev key event (incl. the KEY_UNKNOWNs we drop) and each raw
# hidraw report, before any filtering. This is THE tool to find out what a
# stubborn button actually sends (or that it sends nothing at all).
INPUT_DEBUG = bool(os.environ.get("TVBOX_HIDRAW_DEBUG"))


def key_name(code):
    if code >= 0x400:
        return "CC_%02X" % (code - 0x400)  # hidraw consumer-report button (virtual code)
    if code >= APP_BTN_VIRT_BASE:
        return "APP_%02X" % (code - APP_BTN_VIRT_BASE)  # hidraw app button (virtual code)
    return next((n for n, c in vars(e).items() if n.startswith("KEY_") and c == code), str(code))


# The kernel splits a composite HID remote into one input node per collection
# and appends the collection type to the name ("<name> Keyboard", "<name>
# Consumer Control", …). Strip that so one physical remote reads as one friendly
# name ("AR", "Telink Wireless Receiver") instead of a technical node name.
NAME_SUFFIXES = (" Consumer Control", " System Control", " Keyboard", " Mouse", " Touchpad", " Gamepad", " Pointer")


def dev_key(dev):
    # One id per PHYSICAL remote, stable across reconnects: the BT MAC (uniq) when
    # present, else the USB device path (phys minus the per-interface "/inputN"
    # tail) so a composite device's nodes group into a single id.
    if dev.uniq:
        return dev.uniq.strip()
    if dev.phys:
        return dev.phys.split("/input")[0].strip()
    return (dev.name or dev.path).strip()


def friendly_name(dev):
    name = (dev.name or "").strip()
    for s in NAME_SUFFIXES:
        if name.endswith(s):
            return name[: -len(s)].strip() or name
    return name


def excluded(name):
    if name in EXCLUDE_EXACT:
        return True
    return name.startswith("vc4-hdmi") or "HDMI Jack" in name


def manageable(dev):
    if excluded(dev.name):
        return False
    keys = set(dev.capabilities().get(e.EV_KEY, []))
    return bool(keys & NAV_KEYS)


def is_pointer(dev):
    # A remote's trackpad/pointer node - grabbing it would swallow motion. We only
    # ever want key nodes, so never grab these even in capture-all-nodes mode.
    caps = dev.capabilities()
    return bool(caps.get(e.EV_REL) or caps.get(e.EV_ABS))


def load_keymaps():
    """{ device_id: { code(int): action } } inverted from config for fast lookup."""
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
    except Exception:
        return {}
    devices = (((cfg or {}).get("remote") or {}).get("devices")) or {}
    out = {}
    for did, entry in devices.items():
        km = (entry or {}).get("keymap") or {}
        code2action = {}
        for action, codes in km.items():
            known = action in ACTION_KEY or action in SPECIAL_ACTIONS or APP_ACTION_RE.match(action)
            if not known or not isinstance(codes, list):
                continue
            for c in codes:
                if isinstance(c, int):
                    code2action[c] = action
        if code2action:
            out[did] = code2action
    return out


def load_power():
    """config.remote.power: what the Power button does (POWER_VALUES; default tv)."""
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
    except Exception:
        return POWER_TV
    p = (((cfg or {}).get("remote") or {}).get("power")) or POWER_TV
    return p if p in POWER_VALUES else POWER_TV


def load_ir_actions():
    """Which IR actions the shell can send: the actions mapped under the SELECTED
    config.ir backend (mirrors config.js irConfigured/rawIr - only presence is
    checked here, the shell owns the real validation). Empty set = IR off,
    volume keys pass through like any other key. The whole read is fail-safe:
    a malformed (hand-edited/restored) config must degrade to "IR off", never
    crash-loop the bridge and take the remotes with it."""
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
        ir = (cfg or {}).get("ir") or {}
        backend = ir.get("backend") if ir.get("backend") in ("esphome", "homeassistant") else "esphome"
        block = ir.get(backend) or {}
        ready = bool(block.get("host")) if backend == "esphome" else bool(block.get("url") and block.get("token"))
        if not ready:
            return set()
        actions = block.get("actions") or {}
        return {a for a in IR_KEY_ACTION.values() if actions.get(a)}
    except Exception:
        return set()


def load_ir_passthrough():
    """Device ids with config.remote.devices[<id>].irPassthrough = true: their
    volume keys are NOT diverted to the IR blaster. Set after the Fire TV
    remote's own IR buttons are programmed (firetv_remote_ir.py) - the remote
    then blasts the TV itself, and diverting BT volume too would double every
    press. Fail-safe like the other loaders."""
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
        devices = (((cfg or {}).get("remote") or {}).get("devices")) or {}
        return {did for did, entry in devices.items() if isinstance(entry, dict) and entry.get("irPassthrough")}
    except Exception:
        return set()


def load_capture_all_nodes():
    """config.remote.captureAllNodes (default false). When true, we also grab the
    OTHER HID nodes of a remote we already manage - e.g. a Fire TV remote's
    "Consumer Control" node that carries the app buttons (Netflix/Prime/...),
    which has no nav keys and so isn't managed on its own. Off by default so
    existing setups are untouched; turn on to remap app buttons in the UI."""
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
        return bool((((cfg or {}).get("remote") or {}).get("captureAllNodes")))
    except Exception:
        return False


def cec_cmd(cmd):
    """Drop a TV power command into the CEC bridge's FIFO ("standby 0" = off,
    "toggle 0" = state-aware on/off, resolved by the CEC bridge)."""
    try:
        fd = os.open(CEC_CMD_FIFO, os.O_WRONLY | os.O_NONBLOCK)
        os.write(fd, cmd.encode() + b"\n")
        os.close(fd)
    except OSError as ex:
        log("cec command failed (bridge running?):", cmd, ex)


def poweroff_box():
    """Power the box off via logind (active-session polkit - no root/sudo)."""
    try:
        subprocess.Popen(["systemctl", "poweroff"])
    except Exception as ex:
        log("poweroff failed:", ex)


class Bridge:
    def __init__(self):
        self.devices = {}  # path -> InputDevice (grabbed)
        self.hidraws = {}  # fd -> {path, mac, last} for Fire TV app-button reports
        self.keymaps = load_keymaps()
        self.power = load_power()
        self.ir_actions = load_ir_actions()
        self.ir_passthrough = load_ir_passthrough()
        self.capture_all_nodes = load_capture_all_nodes()
        # Shell HTTP calls (IR sends, Settings nav) leave the event loop
        # immediately (a slow shell/blaster must never stall key handling): a
        # tiny queue + one worker preserves order; a full queue just drops the
        # press (the user can press again).
        self.post_q = queue.Queue(maxsize=8)
        self._ir_last = 0.0  # last IR enqueue, for the autorepeat throttle
        self._power_last = 0.0  # last power action, for the debounce
        self._panic = {}  # did -> [code, count, first_ts] for the reset gesture
        threading.Thread(target=self._post_worker, daemon=True).start()
        self.ui = None
        self.ui_keys = set()
        self.learning = None  # device_id we're capturing a button for
        self.learning_since = 0.0  # when learn mode was armed (monotonic)
        self.captured = False  # a button was captured; keep swallowing until learn-off
        # (did, raw_code) -> out_code emitted at press time (None = press was
        # swallowed). Releases MUST mirror their press even into learn mode: the
        # Enter that STARTS a learn is pressed before we arm but released after,
        # and swallowing that release leaves the compositor with a stuck key -
        # Chromium then autorepeats Enter forever, "pressing" whatever gets
        # focus (this is exactly the bug that re-armed learn every 10s).
        self.held = {}
        # Last content written to remote-devices.json; seed from disk so a
        # restart with an unchanged device set writes nothing. write_devices()
        # (called from rescan() every 2s) only rewrites when this changes -
        # avoids ~43k idle SD-card writes/day.
        try:
            with open(DEVICES_OUT) as f:
                self._devices_json = f.read()
        except OSError:
            self._devices_json = None
        self.rescan()

    # ---- uinput output (declares the union of every managed device's keys) ----
    def ensure_uinput(self):
        keys = set(ACTION_KEY.values())
        for d in self.devices.values():
            keys |= set(d.capabilities().get(e.EV_KEY, []))
        if self.ui is not None and keys <= self.ui_keys:
            return
        if self.ui is not None:
            try:
                self.ui.close()
            except Exception:
                pass
        self.ui_keys = keys
        self.ui = UInput({e.EV_KEY: sorted(keys)}, name=OUT_NAME)
        log("uinput (re)created with", len(keys), "keys")

    # ---- device discovery / grab / drop ----
    def rescan(self):
        # Every InputDevice() opens an fd; we open all once, then close the ones we
        # don't keep (not a remote, already managed, or grab failed) instead of
        # leaving them to CPython refcount GC - rescan runs every 2s.
        opened = []
        for path in list_devices():
            try:
                opened.append(InputDevice(path))
            except Exception:
                continue
        # Physical remotes = anything with nav keys. In capture-all-nodes mode we
        # also keep the OTHER (non-pointer) HID nodes of those same remotes - e.g.
        # a Fire TV remote's Consumer Control node with the app buttons - so their
        # keys flow through the same per-device remap/learn pipeline.
        remote_ids = {dev_key(d) for d in opened if manageable(d)}
        seen = set()
        for dev in opened:
            keep = manageable(dev) or (
                self.capture_all_nodes
                and dev_key(dev) in remote_ids
                and not excluded(dev.name)
                and not is_pointer(dev)
            )
            if not keep:
                dev.close()
                continue
            path = dev.path
            seen.add(path)
            if path in self.devices:
                dev.close()  # already managing this path via the stored handle
                continue
            try:
                dev.grab()
            except Exception as ex:
                log("grab failed for", dev.name, ex)
                dev.close()
                continue
            self.devices[path] = dev
            log("managing", dev.name, "id=", dev_key(dev), path)
        for path in list(self.devices):
            if path not in seen:
                self.drop(path)
        # Fire TV app-button hidraw nodes: open the ones belonging to a managed
        # remote (Amazon-VID, so the udev grant lets us read), close the gone
        # ones. Failure to open (no grant / not Amazon) is silent - inert.
        want = hidraw_nodes_for({r.lower(): r for r in remote_ids})
        have = {h["path"] for h in self.hidraws.values()}
        for path, mac in want.items():
            if path in have:
                continue
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError:
                continue
            self.hidraws[fd] = {"path": path, "mac": mac, "down": set()}
            log("hidraw app-buttons on", path, "for", mac)
        for fd in list(self.hidraws):
            if self.hidraws[fd]["path"] not in want:
                self.drop_hidraw(fd)
        self.ensure_uinput()
        self.write_devices()

    def drop_hidraw(self, fd):
        h = self.hidraws.pop(fd, None)
        if not h:
            return
        try:
            os.close(fd)
        except OSError:
            pass
        for vk in sorted(h["down"]):  # never leave a vanished remote's button held
            self.dispatch(h["mac"], vk, 0)
        log("dropped hidraw", h["path"])

    def drop(self, path):
        dev = self.devices.pop(path, None)
        if not dev:
            return
        try:
            dev.ungrab()
        except Exception:
            pass
        try:
            dev.close()
        except Exception:
            pass
        # A remote that vanishes mid-press (BT sleep) never sends its release -
        # close out anything we still hold down for it, or the compositor keeps
        # autorepeating that key until the remote comes back.
        did = dev_key(dev)
        for k in [k for k in self.held if k[0] == did]:
            out = self.held.pop(k)
            if out is not None:
                self.emit(out, 0)
        log("dropped", path)

    def write_devices(self):
        seen, out = set(), []
        for d in self.devices.values():
            i = dev_key(d)
            if i in seen:
                continue
            seen.add(i)
            out.append({"id": i, "name": friendly_name(d)})
        data = json.dumps({"devices": out})
        if data == self._devices_json:
            return  # unchanged since the last write - skip the SD-card write
        tmp = DEVICES_OUT + ".tmp"
        with open(tmp, "w") as f:
            f.write(data)
        os.replace(tmp, DEVICES_OUT)  # still atomic when we DO write
        self._devices_json = data

    # ---- event handling ----
    def handle(self, dev):
        try:
            events = list(dev.read())
        except OSError:
            self.drop(dev.path)  # disconnected mid-read
            self.write_devices()
            return
        did = dev_key(dev)
        for ev in events:
            if ev.type != e.EV_KEY:
                continue  # only remap keys; pointer/misc are grabbed away (remotes don't use them)
            if INPUT_DEBUG:
                log("evdev", did, dev.name, key_name(ev.code), "code", ev.code, "value", ev.value)
            if ev.code == e.KEY_UNKNOWN:
                # A Fire TV remote's vendor app buttons ALSO surface on this
                # keyboard node as KEY_UNKNOWN (240) - the SAME code for all of
                # them, so it's useless (indistinguishable) and would race the
                # real per-button signal we read from hidraw (handle_hidraw).
                # Drop it: KEY_UNKNOWN is never a mappable key.
                continue
            self.dispatch(did, ev.code, ev.value)

    def handle_hidraw(self, fd):
        """A Fire TV remote's extra-button reports (APP_BTN_REPORTS): byte[1]
        is the button code, 0x00 is the release. ANY nonzero byte becomes a
        virtual keycode in the SAME remap pipeline, so every such button is
        learnable/mappable - no per-button hardcoding. Presses can overlap and
        a 0x00 report doesn't say which button it was, so it closes out ALL
        held ones from that report's band."""
        h = self.hidraws.get(fd)
        if not h:
            return
        try:
            data = os.read(fd, 64)
        except OSError:
            self.drop_hidraw(fd)  # disconnected mid-read
            return
        if not data:
            return
        if INPUT_DEBUG:
            log("hidraw", h["path"], "report", " ".join("%02x" % b for b in data))
        if len(data) < 2:
            return
        base = APP_BTN_REPORTS.get(data[0])
        if base is None:
            return
        code = data[1] | ((data[2] << 8) if len(data) > 2 else 0)
        if code == 0x00:
            for vk in sorted(vk for vk in h["down"] if base <= vk < base + 0x100):
                h["down"].discard(vk)
                self.dispatch(h["mac"], vk, 0)
            return
        if code > 0xFF:
            # a 16-bit code would collide across bytes when folded - surface it
            # instead of guessing (never seen; the debug flag shows the raw report)
            log("hidraw %02x: 16-bit code %04x ignored" % (data[0], code))
            return
        vk = base + code
        if vk in h["down"]:
            return  # repeated press report while held
        h["down"].add(vk)
        self.dispatch(h["mac"], vk, 1)

    def dispatch(self, did, code, value):
        """One remap decision for a (device, keycode, value), shared by the evdev
        and hidraw sources: learn-capture / special+app action / IR volume /
        remap-emit / power / pass-through."""
        if value != 1 and (did, code) in self.held:
            # A release/repeat always mirrors its press, no matter what mode we
            # are in NOW: if the press was emitted, emit the release (else the
            # compositor is left with a stuck, forever-autorepeating key) and
            # the repeats; if the press was swallowed (learn capture), swallow
            # them too - a held volume key must not keep ramping the TV over IR
            # after its press was captured.
            out = self.held.pop((did, code)) if value == 0 else self.held[(did, code)]
            if out is not None:
                self.emit(out, value)
            return
        if value == 1 and self.panic_tap(did, code):
            return  # the reset gesture completed - swallow this final tap
        code2action = self.keymaps.get(did, {})
        if self.learning and did == self.learning:
            # In learn mode for THIS remote every event is swallowed (press,
            # repeat AND release) so an already-mapped button can't fire its
            # action mid-learn. Only the FIRST press is captured - learn stays
            # armed (still swallowing) until the shell's learn-off, so the
            # user's "did it register?" second press can't drive the UI behind
            # the modal - and only after the arm dead-time, so the tail of the
            # UI interaction that STARTED the learn (a fast double-press of
            # Enter) can't self-bind.
            if value == 1:
                self.held[(did, code)] = None  # swallow this press's release too
                if not self.captured and time.monotonic() - self.learning_since >= LEARN_ARM_DELAY_S:
                    self.capture(did, code)
            return
        action = code2action.get(code)
        if action and (action in SPECIAL_ACTIONS or action.startswith("app:")):
            # box behavior instead of a key (TV power toggle / open Settings /
            # launch app / app switch): fire on press, swallow repeat+release
            if value == 1:
                self.do_special(action)
            return
        out_code = ACTION_KEY[action] if action else code
        if IR_KEY_ACTION.get(out_code) in self.ir_actions and did not in self.ir_passthrough:
            # volume key (native or remapped) -> TV volume over the IR blaster;
            # swallowed like KEY_POWER, never reaches the OS. (irPassthrough
            # devices blast the TV with their OWN IR - a programmed Fire TV
            # remote - so diverting too would double it.)
            self.ir_press(IR_KEY_ACTION[out_code], value)
            return
        if action:
            if value == 1:
                self.held[(did, code)] = out_code
            self.emit(out_code, value)  # remapped -> canonical key
            return
        if code == e.KEY_POWER:
            # The remote's Power button reaches us over BT as KEY_POWER; never
            # pass it to the system (logind would power the box off). Act per the
            # configured policy and swallow it.
            if value == 1:
                self.do_power()
            return
        if code >= APP_BTN_VIRT_BASE:
            return  # unmapped virtual app button - hidraw-only, nothing to emit
        if value == 1:
            self.held[(did, code)] = code
        self.emit(code, value)  # unmapped -> pass through unchanged

    def emit(self, code, value):
        try:
            self.ui.write(e.EV_KEY, code, value)
            self.ui.syn()
        except Exception as ex:
            log("emit failed", code, ex)

    def panic_tap(self, did, code):
        """Count deliberate hammering of the SAME raw button on one remote; on
        the PANIC_TAPS-th press (each within PANIC_GAP_S of the previous) reset
        that remote's remapping via the shell, so a user who remapped themselves
        into a corner can recover without navigating the menu. Only counts
        buttons that are remapped on this device (an unmapped one already
        works), never while this remote is being learned, and never for
        actions normal use legitimately hammers (PANIC_EXEMPT_ACTIONS).
        Returns True once it fires."""
        action = self.keymaps.get(did, {}).get(code)
        if (
            self.learning == did
            or action is None
            or action in PANIC_EXEMPT_ACTIONS
            or action.startswith("app:")
        ):
            self._panic.pop(did, None)
            return False
        now = time.monotonic()
        st = self._panic.get(did)  # [code, count, last_tap_ts]
        if st and st[0] == code and now - st[2] <= PANIC_GAP_S:
            st[1] += 1
            st[2] = now
        else:
            st = [code, 1, now]
            self._panic[did] = st
        if st[1] >= PANIC_TAPS:
            self._panic.pop(did, None)
            log("panic reset gesture on", did)
            self.shell_post(RESET_URL, {"id": did})
            return True
        return False

    def do_power(self):
        # Debounce: a TV takes seconds to visibly react to a power change, and a
        # "did it work?" double-press mid-transition would just queue an extra
        # confusing toggle.
        now = time.monotonic()
        if now - self._power_last < 2.0:
            return
        self._power_last = now
        p = self.power
        if p == POWER_TV:
            cec_cmd("toggle 0")  # one button both wakes and sleeps the TV
        elif p == POWER_TV_AND_BOX:
            cec_cmd("standby 0")  # the box is about to go down - never wake the TV
            poweroff_box()
        log("power button ->", p)

    # ---- remapped special actions (no key emitted) ----
    def do_special(self, action):
        if action == "power":
            self.do_power()  # same policy path as a real KEY_POWER
        elif action == "settings":
            self.shell_post(NAV_URL, {"dest": "settings"})
        elif action == "appswitcher":
            self.shell_post(NAV_URL, {"dest": "switch"})
        elif APP_ACTION_RE.match(action):  # config is sanitized, but stay strict
            self.shell_post(NAV_URL, {"dest": "app", "app": action[4:]})

    # ---- volume keys -> IR blaster (shell /tvbox/api/ir/send) ----
    def ir_press(self, action, value):
        # press (1) sends; autorepeat (2) sends throttled so holding the button
        # ramps the TV volume at a sane pace; release (0) is just swallowed.
        now = time.monotonic()
        if value == 1 or (value == 2 and now - self._ir_last >= IR_REPEAT_S):
            self._ir_last = now
            self.shell_post(IR_SEND_URL, {"action": action})

    def shell_post(self, url, payload):
        try:
            self.post_q.put_nowait((url, payload))
        except queue.Full:
            pass  # shell is behind; dropping a press is better than lagging keys

    def _post_worker(self):
        while True:
            url, payload = self.post_q.get()
            body = json.dumps(payload).encode()
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    out = json.loads(resp.read() or b"{}")
                if not out.get("ok"):
                    log("shell call failed:", url, payload, out.get("error", "unknown error"))
            except Exception as ex:  # shell down / blaster unreachable
                log("shell call failed:", url, payload, ex)

    def capture(self, did, code):
        name = key_name(code)
        tmp = LEARNED_OUT + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"id": did, "code": code, "name": name, "ts": int(time.time())}, f)
        os.replace(tmp, LEARNED_OUT)
        # learn stays ARMED (captured=True keeps further presses swallowed but
        # uncaptured) until the shell's learn-off / the safety timeout - the
        # remote must not drive the UI in the gap before the shell polls this.
        self.captured = True
        log("learned", did, code, name)

    # ---- control FIFO from the shell ----
    # "learn <id>" takes the rest of the line as the id (device names can contain
    # spaces), so match by prefix rather than splitting on whitespace.
    def command(self, line):
        line = line.strip()
        if line == "reload":
            self.keymaps = load_keymaps()
            self.power = load_power()
            self.ir_actions = load_ir_actions()
            self.ir_passthrough = load_ir_passthrough()
            prev_capture = self.capture_all_nodes
            self.capture_all_nodes = load_capture_all_nodes()
            if self.capture_all_nodes != prev_capture:
                self.rescan()  # grab/release sibling nodes to match the new setting
            log("config reloaded (power=%s, ir=%s, passthrough=%s, captureAllNodes=%s)"
                % (self.power, sorted(self.ir_actions) or "off",
                   sorted(self.ir_passthrough) or "-", self.capture_all_nodes))
        elif line.startswith("learn ") and len(line) > 6:
            self.learning = line[6:].strip()
            self.learning_since = time.monotonic()
            self.captured = False
            try:
                os.remove(LEARNED_OUT)
            except OSError:
                pass
            log("learn mode:", self.learning)
        elif line == "learn-off":
            self.learning = None
            self.captured = False


def open_fifo():
    # Mirror the CEC bridge (cec_uinput_bridge.py cmd_reader): a pre-existing
    # node must be a FIFO we own, else replace it; force 0600 (bridge and shell
    # run as the same user, so the command FIFO stays private).
    try:
        st = None
        try:
            st = os.stat(CMD_FIFO)
        except FileNotFoundError:
            pass
        if st is not None and (not stat.S_ISFIFO(st.st_mode) or st.st_uid != os.getuid()):
            os.unlink(CMD_FIFO)
            st = None
        if st is None:
            os.mkfifo(CMD_FIFO, 0o600)
        os.chmod(CMD_FIFO, 0o600)
    except OSError as ex:
        log("fifo:", ex)
    # O_RDWR keeps the fifo readable without blocking and without EOF churn.
    return os.open(CMD_FIFO, os.O_RDWR | os.O_NONBLOCK)


def main():
    bridge = Bridge()
    fifo = open_fifo()
    buf = b""
    last_rescan = time.time()
    while True:
        fds = [d.fd for d in bridge.devices.values()] + list(bridge.hidraws) + [fifo]
        r, _, _ = select.select(fds, [], [], 2.0)
        for fd in r:
            if fd == fifo:
                try:
                    buf += os.read(fifo, 4096)
                except OSError:
                    buf = b""
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    bridge.command(line.decode("utf-8", "replace"))
            elif fd in bridge.hidraws:
                bridge.handle_hidraw(fd)
            else:
                dev = next((d for d in bridge.devices.values() if d.fd == fd), None)
                if dev:
                    bridge.handle(dev)
        # Periodic rescan catches BT remotes sleeping/waking (connect/disconnect).
        if time.time() - last_rescan > 2.0:
            bridge.rescan()
            last_rescan = time.time()
        # Learn-mode safety timeout (see LEARN_TIMEOUT_S).
        if bridge.learning and time.monotonic() - bridge.learning_since > LEARN_TIMEOUT_S:
            bridge.learning = None
            bridge.captured = False
            log("learn mode timed out")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
