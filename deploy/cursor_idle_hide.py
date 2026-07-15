#!/usr/bin/env python3
"""tvbox cursor idle-hide.

On a TV box driven by a remote, the wireless remote often also presents a mouse
endpoint (e.g. a Telink combo receiver), so labwc draws a pointer that just sits
on screen and never moves. Hide it when the pointer is idle by parking it far
off-screen with wlrctl, and let it reappear the instant a real mouse moves, so a
mouse the owner actually uses still works.

Launched from ~/.config/labwc/autostart, where it inherits the session's
WAYLAND_DISPLAY (wlrctl needs it). Best-effort: with no pointer device, or no
evdev/wlrctl, it does nothing.
"""
import os
import subprocess
import threading
import time

try:
    from evdev import InputDevice, list_devices, ecodes
except Exception:
    raise SystemExit(0)  # no python-evdev -> nothing to do

IDLE_SEC = 4.0  # hide after this many seconds without pointer motion

_last = 0.0  # monotonic time of last pointer motion (0 = park ASAP on start)
_hidden = False
_lock = threading.Lock()
_watched = set()  # device paths with a live reader thread


def _park():
    # Move the pointer far into the bottom-right corner (the compositor clamps
    # it to the screen edge) so it leaves the visible UI. Uses the wlroots
    # virtual-pointer protocol, so it does NOT count as physical motion and
    # cannot re-trigger our own watchers.
    try:
        subprocess.run(
            ["wlrctl", "pointer", "move", "100000", "100000"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
    except Exception:
        pass


def _is_pointer(dev):
    caps = dev.capabilities()
    return ecodes.EV_REL in caps or ecodes.EV_ABS in caps


def _watch(dev):
    global _last, _hidden
    try:
        for ev in dev.read_loop():
            if ev.type in (ecodes.EV_REL, ecodes.EV_ABS):
                with _lock:
                    _last = time.monotonic()
                    _hidden = False
    except Exception:
        pass  # device went away (wireless sleep/unplug); _scan re-adds it
    finally:
        _watched.discard(dev.path)


def _scan():
    for path in list_devices():
        if path in _watched:
            continue
        try:
            dev = InputDevice(path)
            if _is_pointer(dev):
                _watched.add(path)
                threading.Thread(target=_watch, args=(dev,), daemon=True).start()
        except Exception:
            pass


def main():
    global _hidden
    while True:
        _scan()  # pick up (re)connected wireless mice
        time.sleep(1.0)
        with _lock:
            idle = time.monotonic() - _last
            if idle >= IDLE_SEC and not _hidden and _watched:
                _hidden = True
                _park()


if __name__ == "__main__":
    main()
