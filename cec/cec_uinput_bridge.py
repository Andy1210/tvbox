#!/usr/bin/env python3
"""tvbox - CEC -> uinput bridge.

On this Pi 5 (vc4_hdmi) the kernel CEC->rc->input path does NOT deliver remote
keys to Wayland/Chromium, but libcec receives them as raw 'User Control Pressed'
messages (opcode 0x44). So we bridge:

    TV remote --CEC--> libcec (cec-client) --parse--> uinput key --> labwc --> Chromium

The TV forwards keys only to the *active source*, so we assert active-source on
startup and periodically (keep_active_source) - but ONLY while the TV is powered
on. We track the TV's CEC power state and pause the assertion when it goes to
standby, otherwise we'd immediately power the TV back on every time the user
turns it off.

This LG TV quirks (discovered empirically):
  - Back and Exit send the SAME code (0x0d).
  - Colored / Home / Menu buttons are NOT forwarded at all.
  - Every press emits press+release within ~70 ms regardless of how long it is
    physically held -> long-press is undetectable.
So Home is derived from a DOUBLE TAP of Back: single tap = Back (Esc), two taps
within 0.4 s = Home (the first tap's Back is harmless wherever it lands).

Vendor identity (LG SIMPLINK et al.): some TVs key protocol features on the
CEC vendor ID of the device. LG SIMPLINK only forwards remote keys to
devices whose vendor reads LG (0x00e091), and the TV queries it ~200 ms
after a device appears - before libcec's own LG masquerade handler is
installed, so the TV records libcec's hardcoded Pulse-Eight identity and
blacklists the box (worked by boot-timing luck on kernels <= 6.12; kernel
6.18's later logical-address claim loses the race deterministically). Fix:
cec_vendor_shim.c, an LD_PRELOAD for cec-client that rewrites the announced
vendor at the ioctl boundary ($CEC_SHIM_VENDOR_ID selects the vendor, so the
mechanism is not LG-specific). On libcec >= 8 the shim is skipped entirely -
cec-client takes `--vendor-id` natively (scripts/install-libcec8.sh builds it;
no distro packages 8.x yet). Policy lives here, keyed by `cec.vendorShim`
in ~/.tvbox/config.json:
  "auto" (default) - masquerade as LG, only when the TV's vendor broadcast
          says LG (the only brand this is tested against; remembered in
          ~/.tvbox/cec_tv_vendor across restarts). Non-LG TVs run bit-for-bit
          stock libcec.
  "tv"    - masquerade as whatever vendor the TV announces (untested outside
          LG; for experimenting with other brands' vendor-locked features).
  "<6 hex digits>" - always masquerade as this vendor.
  false   - never.
In the detecting modes the first contact persists the TV vendor and exits so
systemd restarts the bridge with the right identity (Restart=always). If the
remote is still dead right after first setup on an LG, toggle SIMPLINK
off/on in the TV settings once - the TV caches the vendor it saw first for a
few minutes.

Runs as the box user (systemd user unit `tvbox-cec`): /dev/uinput and /dev/cec*
access come from the udev rule + input/video group membership that
deploy/provision.sh sets up - no root anywhere.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import threading
import time
import urllib.request

from evdev import UInput, ecodes as e

# CEC user-control code (hex) -> Linux key, emitted immediately on press.
KEYMAP = {
    0x00: e.KEY_ENTER,          # Select / OK
    0x01: e.KEY_UP,
    0x02: e.KEY_DOWN,
    0x03: e.KEY_LEFT,
    0x04: e.KEY_RIGHT,
    0x30: e.KEY_CHANNELUP,
    0x31: e.KEY_CHANNELDOWN,
    0x44: e.KEY_PLAYPAUSE,      # Play
    0x46: e.KEY_PLAYPAUSE,      # Pause
    0x45: e.KEY_STOP,           # Stop (user-control code, not the release msg)
    0x48: e.KEY_REWIND,
    0x49: e.KEY_FASTFORWARD,
    0x4B: e.KEY_NEXTSONG,       # Skip forward
    0x4C: e.KEY_PREVIOUSSONG,   # Skip back
}

# Back/Exit special handling (both map to 0x0d on this TV)
BACK_CODE = 0x0D
BACK_KEY = e.KEY_BACKSPACE      # single tap -> Back (Plex maps Backspace to its "Back" action; Esc = exit)
HOME_KEY = e.KEY_HOMEPAGE       # double tap -> Home
DOUBLE_TAP_S = 0.4

# OSD name announced to the TV's CEC device list; override per box via TVBOX_CEC_OSD.
CEC_OSD_NAME = os.environ.get("TVBOX_CEC_OSD", "tvbox")
CEC_CLIENT = ["cec-client", "-t", "p", "-o", CEC_OSD_NAME, "-d", "8"]
RX_PRESS = re.compile(r">> [0-9a-f]{2}:44:([0-9a-f]{2})", re.IGNORECASE)
# TV vendor ID broadcast (<Device Vendor ID>, opcode 0x87). Trust only the TV:
# initiator 0 - or 14 ("free use"), which LG sets use for SIMPLINK chatter.
RX_TV_VENDOR = re.compile(r">> [0e]f:87:([0-9a-f]{2}):([0-9a-f]{2}):([0-9a-f]{2})", re.IGNORECASE)
LG_VENDOR = "00e091"
CONFIG_PATH = os.path.expanduser("~/.tvbox/config.json")
VENDOR_STATE = os.path.expanduser("~/.tvbox/cec_tv_vendor")   # last seen TV vendor (hex)
SHIM_SRC = os.path.expanduser("~/.tvbox/cec_vendor_shim.c")
SHIM_SO = os.path.expanduser("~/.tvbox/cec_vendor_shim.so")
# TV power state (logical address 0 = TV). Report Power Status (opcode 0x90):
# param 00=on, 01=standby, 02=transition->on, 03=transition->standby.
RX_PWR = re.compile(r">> 0[0-9a-f]:90:([0-9a-f]{2})", re.IGNORECASE)
RX_STANDBY = re.compile(r">> 0f:36", re.IGNORECASE)   # TV broadcasts <Standby> on power-off
# Routing. We must know whether the TV is actually showing US before asserting
# active-source again, or we yank the input back every cycle from whatever the
# user selected. Physical addresses are 2 bytes (e.g. "20:00" = HDMI2).
#   << x f:82 aa:bb  our own <Active Source> - tells us OUR physical address
#   >> x f:82 aa:bb  someone else took over
#   >> x f:86 aa:bb  <Set Stream Path>: routed to that address
#   >> x f:80 cc:dd:aa:bb  <Routing Change>: ... from cc:dd to aa:bb
#   >> x f:81 aa:bb  <Routing Information>: the path a switch now routes
# Any initiator, not just the TV (0): with an AVR or HDMI switch in the chain it
# is the switch that announces the change, and ignoring those would leave us
# re-asserting over the user's choice again.
RX_OUR_AS = re.compile(r"<< [0-9a-f]f:82:([0-9a-f]{2}):([0-9a-f]{2})", re.IGNORECASE)
RX_ACTIVE_SRC = re.compile(r">> [0-9a-f]f:82:([0-9a-f]{2}):([0-9a-f]{2})", re.IGNORECASE)
RX_STREAM_PATH = re.compile(r">> [0-9a-f]f:86:([0-9a-f]{2}):([0-9a-f]{2})", re.IGNORECASE)
RX_ROUTING_INFO = re.compile(r">> [0-9a-f]f:81:([0-9a-f]{2}):([0-9a-f]{2})", re.IGNORECASE)
RX_ROUTING = re.compile(
    r">> [0-9a-f]f:80:[0-9a-f]{2}:[0-9a-f]{2}:([0-9a-f]{2}):([0-9a-f]{2})", re.IGNORECASE)


def routes_to_us(addr: str, phys: str) -> bool:
    """Does a routed physical address mean US? Addresses are hierarchical, most
    significant nibble first, zero-padded: a box on HDMI1 behind a soundbar is
    "1100", and the TV selecting the soundbar routes to "1000" - an ANCESTOR of
    us, not somewhere else. Treating that as "not us" would make the remote go
    dead the moment an AVR sits in the chain, so a prefix match counts as ours;
    a sibling path ("2000") does not, and neither does "0000" (the TV itself)."""
    if addr == phys:
        return True
    depth = len(addr.rstrip("0"))
    return depth > 0 and addr[:depth] == phys[:depth]
# When the TV powers off, tell the shell to stop playback (so a stream doesn't
# keep running on a dark screen). Best-effort, fire-and-forget.
STANDBY_URL = "http://127.0.0.1:8097/tvbox/api/tv/standby"
# Where Home goes while a native app (RetroArch et al) owns the screen: such an app
# holds keyboard focus, so no renderer of ours can turn the key into "go home".
NAV_URL = "http://127.0.0.1:8097/tvbox/api/nav"

# We own the (single) cec-client and its stdin, so the shell can't run its own
# to send CEC. Instead it drops a whitelisted command into this FIFO and we
# forward it to cec-client's stdin - how "turn the TV on/off" (voice / HA) works.
# Bridge and shell run as the same user, so the FIFO is private (0600).
CEC_CMD_FIFO = "/tmp/tvbox-cec-cmd"
# Only TV (logical addr 0) power; nothing else. "toggle 0" resolves to on/standby
# from the tracked TV power state (the remote bridge's Power action uses it, so
# one button both wakes and sleeps the TV - like a TV remote's own power key).
CEC_CMD_ALLOW = {"on 0", "standby 0", "toggle 0"}
# Shell-only commands handled here instead of being forwarded to cec-client.
NATIVE_CMDS = {"native on", "native off"}
STDIN_LOCK = threading.Lock()          # keep_active_source + cmd_reader both write proc.stdin


def shim_mode() -> object:
    """cec.vendorShim from config.json: "auto" (default) | "tv" | hex | False."""
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f).get("cec", {}).get("vendorShim", "auto")
    except Exception:
        return "auto"


def resolve_shim_target(mode: object, tv_vendor: str) -> str | None:
    """The vendor ID to masquerade as (6 hex digits), or None for stock libcec."""
    if mode == "auto":
        return LG_VENDOR if tv_vendor == LG_VENDOR else None
    if mode == "tv" or mode is True:
        return tv_vendor or None
    if isinstance(mode, str) and re.fullmatch(r"[0-9a-fA-F]{6}", mode):
        return mode.lower()
    return None


def stored_tv_vendor() -> str:
    try:
        with open(VENDOR_STATE) as f:
            return f.read().strip().lower()
    except OSError:
        return ""


def store_tv_vendor(vendor: str) -> None:
    try:
        with open(VENDOR_STATE, "w") as f:
            f.write(vendor + "\n")
    except OSError as ex:
        print(f"cec_tv_vendor not saved: {ex}", flush=True)


def cec_client_has_vendor_id() -> bool:
    """Does the cec-client on PATH support --vendor-id (libcec >= 8)?
    Feature-detected from --help, which exits instantly without touching the CEC
    adapter - there is no --version flag (it is parsed as a serial port), and the
    v8 binary is statically linked so its soname can't be read either."""
    try:
        out = subprocess.run(
            ["cec-client", "--help"], capture_output=True, text=True, timeout=10
        )
        return "--vendor-id" in (out.stdout + out.stderr)
    except Exception:
        return False


def ensure_vendor_shim() -> str | None:
    """Build cec_vendor_shim.so from the shipped source if missing/stale.
    Returns the .so path, or None (missing gcc / compile error) - the bridge
    then runs stock libcec, which on an LG TV may lose the vendor race."""
    if not os.path.exists(SHIM_SRC):
        print("cec_vendor_shim.c missing - running without the vendor shim", flush=True)
        return None
    try:
        if not os.path.exists(SHIM_SO) or os.path.getmtime(SHIM_SO) < os.path.getmtime(SHIM_SRC):
            subprocess.run(
                ["gcc", "-shared", "-fPIC", "-O2", "-o", SHIM_SO, SHIM_SRC],
                check=True, capture_output=True, text=True,
            )
            print("built cec_vendor_shim.so", flush=True)
        return SHIM_SO
    except FileNotFoundError:
        print("gcc not found - vendor shim unavailable (apt install gcc libc6-dev)", flush=True)
    except subprocess.CalledProcessError as ex:
        print(f"cec_vendor_shim build failed: {ex.stderr}", flush=True)
    return None


def notify_standby() -> None:
    def go() -> None:
        try:
            urllib.request.urlopen(STANDBY_URL, timeout=2).read()
        except Exception:
            pass
    threading.Thread(target=go, daemon=True).start()


def nav_home() -> None:
    """Ask the shell to leave whatever is in front and show the launcher.
    Best-effort, fire-and-forget, off the key path so a slow reply never stalls
    the next button press."""
    def go() -> None:
        try:
            req = urllib.request.Request(
                NAV_URL,
                data=json.dumps({"dest": "home"}).encode(),
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=5).read()
        except Exception as ex:
            print(f"nav home failed: {ex}", flush=True)
    threading.Thread(target=go, daemon=True).start()

ALL_KEYS = sorted(set(KEYMAP.values()) | {BACK_KEY, HOME_KEY})


# After WE command a power change, distrust contradicting power reports this
# long (the LG this was tuned on keeps answering 'pow' with "on" ~15s into its
# shutdown). Doubles as the "press again to undo" window for toggle.
CMD_GRACE_S = 25.0


class TVState:
    """Shared TV power flag; set by the stdout parser, read by the asserter.

    cmd/cmd_ts remember the last power direction WE sent: an LG answers an
    in-flight 'pow' query with the pre-command state for several seconds while
    it transitions, and letting that stale report flip the flag back makes the
    next toggle repeat the same direction instead of undoing it."""
    def __init__(self) -> None:
        # Start as OFF: an ON TV answers the first 'pow' poll within seconds and
        # corrects this, while a deep-standby LG never answers at all - so True
        # here would stick forever and send the first toggle the wrong way.
        self.on = False
        self.cmd = None      # True=on / False=standby we last commanded, None = never
        self.cmd_ts = 0.0    # monotonic timestamp of that command
        # Is the TV routed to US? Starts True so the box grabs the input once at
        # startup (One Touch Play, like any media player). Cleared the moment the
        # user selects another input, and set again when the TV routes back.
        self.active = True
        self.phys = None     # our own physical address, learned from our <Active Source>


class Bridge:
    def __init__(self, ui: UInput) -> None:
        self.ui = ui
        self.last_back_ts = 0.0
        # Set from the shell over CEC_CMD_FIFO while a native app is in front: Home
        # then becomes an HTTP request instead of a key (see tap()).
        self.native = False

    def tap(self, key: int) -> None:
        if self.native and key == HOME_KEY:
            # Nothing of ours has keyboard focus while a native app runs, so the
            # key would land in that app (which does not know about HOME) and the
            # user would be stuck. Route it to the shell instead.
            nav_home()
            return
        self.ui.write(e.EV_KEY, key, 1)
        self.ui.syn()
        self.ui.write(e.EV_KEY, key, 0)
        self.ui.syn()

    def on_press(self, code: int) -> None:
        if code == BACK_CODE:
            now = time.monotonic()
            self.tap(BACK_KEY)                       # always Back, immediately
            if now - self.last_back_ts <= DOUBLE_TAP_S:
                print("double-tap Back -> HOME", flush=True)
                self.tap(HOME_KEY)
                self.last_back_ts = 0.0              # avoid triple-trigger
            else:
                self.last_back_ts = now
            return
        key = KEYMAP.get(code)
        if key is not None:
            self.tap(key)


def keep_active_source(proc: subprocess.Popen, tv: TVState) -> None:
    """Assert active-source so the TV forwards remote keys to us - but ONLY while
    the TV is on, so we don't power it back on after the user turns it off.

    Each cycle we query the TV power status ('pow 0' - a CEC query that does NOT
    wake the TV) and only send active-source ('as') if it reports on. The stdout
    parser flips tv.on (immediately on a <Standby> broadcast, and from the power
    report), so a TV turned off stays off and one turned back on is re-grabbed.

    Right after WE command a standby, the TV can still report "on" for a few
    seconds (an LG does this for ~15s into shutdown); asserting 'as' then would
    re-wake it. So we suppress 'as' for CMD_GRACE_S after a standby command,
    regardless of the (stale) reported state - by then the TV reports off.

    And it only re-asserts while the TV is actually routed to US (tv.active).
    Re-asserting unconditionally stole the input back within ~17s of the user
    selecting any other source on the TV; the parser clears tv.active as soon as
    something else becomes the active source and sets it again when the TV routes
    back to us, so the periodic assert only ever refreshes a route we already own
    (which is what keeps LG forwarding remote keys).
    """
    time.sleep(2)
    while proc.poll() is None:
        try:
            with STDIN_LOCK:
                proc.stdin.write("pow 0\n")   # refresh TV power state (does not wake it)
                proc.stdin.flush()
            time.sleep(2.5)                   # let the Report Power Status arrive + parser update
            recently_off_cmd = tv.cmd is False and time.monotonic() - tv.cmd_ts < CMD_GRACE_S
            if tv.on and tv.active and not recently_off_cmd:
                with STDIN_LOCK:
                    proc.stdin.write("as\n")
                    proc.stdin.flush()
        except (BrokenPipeError, ValueError):
            return
        time.sleep(15)


def cmd_reader(proc: subprocess.Popen, tv: TVState, bridge: Bridge) -> None:
    """Handle what the shell writes to CEC_CMD_FIFO: whitelisted CEC power commands
    are forwarded to cec-client's stdin, and `native on/off` is consumed here to
    flip how Home is delivered. The FIFO is opened O_RDWR so it never hits EOF (stays
    writable for the shell). Bridge and shell run as the same user, so it's
    private (0600); a stale FIFO from an old root install is replaced (best
    effort - /tmp's sticky bit blocks unlinking root's, but provision.sh removes
    that one and a reboot clears /tmp anyway)."""
    try:
        st = None
        try:
            st = os.stat(CEC_CMD_FIFO)
        except FileNotFoundError:
            pass
        if st is not None and (not stat.S_ISFIFO(st.st_mode) or st.st_uid != os.getuid()):
            os.unlink(CEC_CMD_FIFO)
            st = None
        if st is None:
            os.mkfifo(CEC_CMD_FIFO, 0o600)
        os.chmod(CEC_CMD_FIFO, 0o600)
    except OSError as ex:
        print(f"cec cmd fifo setup failed: {ex}", flush=True)
        return
    try:
        with os.fdopen(os.open(CEC_CMD_FIFO, os.O_RDWR), "r") as fifo:
            for line in fifo:
                cmd = line.strip()
                if cmd in NATIVE_CMDS:
                    bridge.native = cmd.endswith("on")
                    print(f"native app owns the screen: {bridge.native}", flush=True)
                    continue
                if cmd not in CEC_CMD_ALLOW:
                    if cmd:
                        print(f"cec cmd ignored: {cmd!r}", flush=True)
                    continue
                if cmd == "toggle 0":
                    now = time.monotonic()
                    if tv.cmd is not None and now - tv.cmd_ts < CMD_GRACE_S:
                        target_on = not tv.cmd  # quick re-press = undo the last command
                    else:
                        target_on = not tv.on
                    cmd = "on 0" if target_on else "standby 0"
                    print(f"cec toggle -> {cmd}", flush=True)
                # Record the commanded direction + time (drives toggle "undo"
                # within CMD_GRACE_S and the asserter's re-wake guard). We do NOT
                # set tv.on here: tv.on stays observation-driven so the parser's
                # standby handler still fires notify_standby() (stop playback)
                # when the TV actually goes off - setting it optimistically
                # swallowed that signal.
                tv.cmd = cmd == "on 0"
                tv.cmd_ts = time.monotonic()
                try:
                    with STDIN_LOCK:
                        proc.stdin.write(cmd + "\n")
                        proc.stdin.flush()
                    print(f"cec cmd -> {cmd}", flush=True)
                except (BrokenPipeError, ValueError):
                    return
    except OSError as ex:
        print(f"cec cmd reader stopped: {ex}", flush=True)


def main() -> None:
    mode = shim_mode()
    tv_vendor = stored_tv_vendor()
    target = resolve_shim_target(mode, tv_vendor)
    env = None
    client = list(CEC_CLIENT)
    # libcec >= 8 can announce the vendor itself (--vendor-id), which is what the
    # LD_PRELOAD shim was faking - it sets cec_log_addrs.vendor_id on the same
    # ioctl the shim intercepted, so the vendor query race is won without us.
    # Older libcec (Debian/RPi still ship 7.x) keeps the shim.
    if target is not None and cec_client_has_vendor_id():
        client += ["--vendor-id", target.upper()]
        print(
            f"vendor shim: not needed - libcec --vendor-id {target} "
            f"(mode={mode}, tv_vendor={tv_vendor or 'unknown'})",
            flush=True,
        )
    elif target is not None:
        so = ensure_vendor_shim()
        if so:
            env = {**os.environ, "LD_PRELOAD": so, "CEC_SHIM_VENDOR_ID": target}
        else:
            target = None
        print(f"vendor shim: {target or 'off'} (mode={mode}, tv_vendor={tv_vendor or 'unknown'})", flush=True)
    else:
        print(f"vendor shim: off (mode={mode}, tv_vendor={tv_vendor or 'unknown'})", flush=True)

    ui = UInput({e.EV_KEY: ALL_KEYS}, name="tvbox-cec-remote")
    print("uinput device created: tvbox-cec-remote", flush=True)
    # cec-client is a C program: with its stdout on a pipe (not a TTY) glibc
    # block-buffers it, so at -d 8 the key frames leave in ~4 KB lumps and the UI
    # catches up in bursts under rapid presses - "the remote piles up / jams"
    # while a keyboard (which never goes through this pipe) stays smooth. stdbuf
    # forces line buffering so each frame is delivered the instant cec-client
    # logs it. stdbuf appends libstdbuf.so to LD_PRELOAD, so the LG vendor shim
    # (also LD_PRELOAD, via env) still loads alongside it.
    launch = ["stdbuf", "-oL", *client] if shutil.which("stdbuf") else client
    proc = subprocess.Popen(
        launch,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    tv = TVState()
    bridge = Bridge(ui)
    threading.Thread(target=keep_active_source, args=(proc, tv), daemon=True).start()
    threading.Thread(target=cmd_reader, args=(proc, tv, bridge), daemon=True).start()
    print("bridging keys (tap Back=Backspace, double-tap Back=Home)", flush=True)

    try:
        for line in proc.stdout:
            mp = RX_PRESS.search(line)
            if mp:
                bridge.on_press(int(mp.group(1), 16))
                continue
            mv = RX_TV_VENDOR.search(line)
            if mv:
                vendor = "".join(mv.groups()).lower()
                if vendor != tv_vendor:
                    store_tv_vendor(vendor)
                    tv_vendor = vendor
                    if resolve_shim_target(mode, vendor) != target:
                        # Identity must change (e.g. LG detected -> shim on) ->
                        # exit; systemd (Restart=always) brings the bridge back
                        # up with the right cec-client identity.
                        print(f"TV vendor {vendor} changes shim target - restarting", flush=True)
                        return
                continue
            # --- routing: is the TV actually showing US? ----------------------
            mo = RX_OUR_AS.search(line)
            if mo:
                addr = "".join(mo.groups()).lower()      # our own address, from our own broadcast
                if addr != tv.phys:
                    print(f"our physical address is {addr}", flush=True)
                tv.phys = addr
                tv.active = True
                continue
            routed = next(
                ((("".join(m.groups()).lower()), why)
                 for rx, why in ((RX_STREAM_PATH, "stream path"), (RX_ROUTING, "routing change"),
                                 (RX_ROUTING_INFO, "routing info"), (RX_ACTIVE_SRC, "active source"))
                 for m in [rx.search(line)] if m),
                None,
            )
            if routed:
                addr, why = routed
                # Until our first <Active Source> has taught us our own address we
                # cannot tell "us" from "them" - staying put beats latching
                # inactive forever and never asserting (which would never teach us).
                if tv.phys is not None:
                    mine = routes_to_us(addr, tv.phys)
                    if mine != tv.active:
                        print(f"TV routed to {addr} ({why}) -> "
                              f"{'ours again' if mine else 'another input, backing off'}", flush=True)
                    tv.active = mine
                continue

            if RX_STANDBY.search(line):
                if tv.on:
                    print("TV -> standby; pausing active-source + stopping playback", flush=True)
                    notify_standby()
                tv.on = False
                continue
            mpw = RX_PWR.search(line)
            if mpw:
                on = mpw.group(1) in ("00", "02")  # on / transitioning to on
                if tv.cmd is not None and on != tv.cmd and time.monotonic() - tv.cmd_ts < CMD_GRACE_S:
                    continue  # stale answer from before our own power command - ignore
                if on != tv.on:
                    print(f"TV power -> {'on' if on else 'standby'}", flush=True)
                    if not on:
                        notify_standby()
                tv.on = on
    finally:
        proc.terminate()
        ui.close()


if __name__ == "__main__":
    main()
