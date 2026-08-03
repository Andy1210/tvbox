#!/usr/bin/env python3
"""tvbox cursor idle-hide.

On a TV box driven by a remote, the wireless remote often also presents a mouse
endpoint (e.g. a Telink combo receiver), so labwc draws a pointer that just sits
on screen and never moves. Hide it when the pointer is idle by parking it far
off-screen with wlrctl, and let it reappear the instant a real mouse moves, so a
mouse the owner actually uses still works.

A box with NO pointer device at all still gets a drawn cursor - the compositor
has one whether or not anything can move it - and that one is the worst case,
because nothing will ever move it off the picture again. So the park does not
wait for a pointer device to have been found: idle is idle.

Launched from ~/.config/labwc/autostart, where it inherits the session's
WAYLAND_DISPLAY (wlrctl needs it). Best-effort: with no evdev or no wlrctl, it
does nothing.
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
# Park again this often while still idle. Parking ONCE is not enough: the pointer
# comes back on its own - the compositor repositions it when the output mode
# changes, which on this box happens every time a video claims or releases a mode -
# and that motion is not something an evdev watcher can see, so nothing would ever
# ask for another park. Cheap enough to just keep doing it.
PARK_REPEAT_SEC = 10.0

_last = 0.0  # monotonic time of last pointer motion (0 = park ASAP on start)
_parked = 0.0  # monotonic time of the last park (0 = never)
_lock = threading.Lock()
_watched = set()  # device paths with a live reader thread


# Enough to cross any panel we will meet (a 4K output is 3840x2160) from wherever
# the pointer happens to be, and small enough to survive the wire: Wayland carries
# coordinates as 24.8 fixed point, so anything past ~32767 overflows and comes back
# NEGATIVE - which is how a "park" ended up dragging the cursor to the top of the
# screen instead of the corner.
PARK_DELTA = "8000"


def _park():
    # Move the pointer into the bottom-right corner (the compositor clamps it to
    # the output edge) so it leaves the picture. Uses the wlroots virtual-pointer
    # protocol, so it does NOT count as physical motion and cannot re-trigger our
    # own watchers.
    try:
        subprocess.run(
            ["wlrctl", "pointer", "move", PARK_DELTA, PARK_DELTA],
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
    global _last
    try:
        for ev in dev.read_loop():
            if ev.type in (ecodes.EV_REL, ecodes.EV_ABS):
                with _lock:
                    _last = time.monotonic()
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
    global _parked
    while True:
        _scan()  # pick up (re)connected wireless mice
        time.sleep(1.0)
        with _lock:
            now = time.monotonic()
            if now - _last >= IDLE_SEC and now - _parked >= PARK_REPEAT_SEC:
                _parked = now
                _park()


if __name__ == "__main__":
    main()
