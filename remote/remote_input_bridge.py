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
SPECIAL_ACTIONS = ("power", "settings")
APP_ACTION_RE = re.compile(r"^app:[a-z0-9_-]{1,32}$")
NAV_URL = "http://127.0.0.1:8097/tvbox/api/nav"

# Only manage things that are actually remotes/keyboards: they must expose at
# least one of these navigation/select keys. This skips pure pointers, the HDMI
# CEC receivers, audio jacks, etc.
NAV_KEYS = {e.KEY_ENTER, e.KEY_KPENTER, e.KEY_OK, e.KEY_SELECT, e.KEY_UP, e.KEY_LEFT, e.KEY_RIGHT, e.KEY_DOWN}
# Never grab these (built-ins + our own / the CEC bridge's virtual keyboards).
EXCLUDE_EXACT = {OUT_NAME, "tvbox-cec-remote", "pwr_button"}


def log(*a):
    print("[remote-bridge]", *a, file=sys.stderr, flush=True)


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
        self.keymaps = load_keymaps()
        self.power = load_power()
        self.ir_actions = load_ir_actions()
        # Shell HTTP calls (IR sends, Settings nav) leave the event loop
        # immediately (a slow shell/blaster must never stall key handling): a
        # tiny queue + one worker preserves order; a full queue just drops the
        # press (the user can press again).
        self.post_q = queue.Queue(maxsize=8)
        self._ir_last = 0.0  # last IR enqueue, for the autorepeat throttle
        self._power_last = 0.0  # last power action, for the debounce
        threading.Thread(target=self._post_worker, daemon=True).start()
        self.ui = None
        self.ui_keys = set()
        self.learning = None  # device_id we're capturing a button for
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
        seen = set()
        for path in list_devices():
            try:
                dev = InputDevice(path)
            except Exception:
                continue
            # Every InputDevice() opens an fd; close the ones we don't keep
            # (not a remote, already managed, or grab failed) instead of leaving
            # them to CPython refcount GC - rescan runs every 2s.
            if not manageable(dev):
                dev.close()
                continue
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
        self.ensure_uinput()
        self.write_devices()

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
        code2action = self.keymaps.get(did, {})
        for ev in events:
            if ev.type != e.EV_KEY:
                continue  # only remap keys; pointer/misc are grabbed away (remotes don't use them)
            if self.learning and did == self.learning and ev.value == 1:
                self.capture(did, dev, ev.code)
                continue  # swallow the learned press
            action = code2action.get(ev.code)
            if action and (action in SPECIAL_ACTIONS or action.startswith("app:")):
                # box behavior instead of a key (TV power toggle / open
                # Settings / launch app): fire on press, swallow press+repeat+release
                if ev.value == 1:
                    self.do_special(action)
                continue
            out_code = ACTION_KEY[action] if action else ev.code
            if IR_KEY_ACTION.get(out_code) in self.ir_actions:
                # volume key (native or remapped) -> TV volume over the IR
                # blaster; swallowed like KEY_POWER, never reaches the OS
                self.ir_press(IR_KEY_ACTION[out_code], ev.value)
                continue
            if action:
                self.emit(out_code, ev.value)  # remapped -> canonical key
                continue
            if ev.code == e.KEY_POWER:
                # The remote's Power button reaches us over BT as KEY_POWER; never
                # pass it to the system (logind would power the box off). Act per
                # the configured policy and swallow it.
                if ev.value == 1:
                    self.do_power()
                continue
            self.emit(ev.code, ev.value)  # unmapped -> pass through unchanged

    def emit(self, code, value):
        try:
            self.ui.write(e.EV_KEY, code, value)
            self.ui.syn()
        except Exception as ex:
            log("emit failed", code, ex)

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

    def capture(self, did, dev, code):
        name = next((n for n, c in vars(e).items() if n.startswith("KEY_") and c == code), str(code))
        tmp = LEARNED_OUT + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"id": did, "code": code, "name": name, "ts": int(time.time())}, f)
        os.replace(tmp, LEARNED_OUT)
        self.learning = None
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
            log("config reloaded (power=%s, ir=%s)" % (self.power, sorted(self.ir_actions) or "off"))
        elif line.startswith("learn ") and len(line) > 6:
            self.learning = line[6:].strip()
            try:
                os.remove(LEARNED_OUT)
            except OSError:
                pass
            log("learn mode:", self.learning)
        elif line == "learn-off":
            self.learning = None


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
        fds = [d.fd for d in bridge.devices.values()] + [fifo]
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
            else:
                dev = next((d for d in bridge.devices.values() if d.fd == fd), None)
                if dev:
                    bridge.handle(dev)
        # Periodic rescan catches BT remotes sleeping/waking (connect/disconnect).
        if time.time() - last_rescan > 2.0:
            bridge.rescan()
            last_rescan = time.time()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
