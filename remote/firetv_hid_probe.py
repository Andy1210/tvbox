#!/usr/bin/env python3
"""Probe a Fire TV / Amazon remote's HID buttons on the box, to enable the app
buttons (Netflix / Prime / Disney+ / Music / Alexa / ...).

Why this exists: those buttons DO transmit over BLE-HID, but as vendor-defined
HID usages. Fire OS ships keylayouts that decode them; a stock Pi kernel usually
maps them to KEY_UNKNOWN (all the same code) or nothing - so they can't be told
apart or remapped. This tool shows, per button, the raw HID scancode (MSC_SCAN)
and the key code the kernel produced, and prints ready-to-install udev `hwdb`
lines that remap each scancode to a distinct KEY_* code. After installing those,
the remote bridge sees them as normal keys and Settings -> Peripherals can bind
them to apps (or anything) like any other button.

Run it ON THE BOX (member of the `input` group - no root needed to read):
    python3 ~/.tvbox/firetv_hid_probe.py

The remote-input bridge only grabs a remote's *keyboard* node, so app buttons on
a separate "Consumer Control" node are visible even while it runs. If a button
shows nothing, stop the bridge first:  systemctl --user stop tvbox-remote
"""
import sys
import select

from evdev import InputDevice, categorize, ecodes as e, list_devices

AMAZON_VID = 0x0171

# scancode -> a spare KEY_* to remap it to (distinct, unlikely to collide). These
# are what the hwdb suggestions cycle through; rename freely.
SUGGEST_KEYS = ["KEY_PROG1", "KEY_PROG2", "KEY_PROG3", "KEY_PROG4",
                "KEY_RED", "KEY_GREEN", "KEY_YELLOW", "KEY_BLUE",
                "KEY_F13", "KEY_F14", "KEY_F15", "KEY_F16"]


def info(dev):
    i = dev.info  # bustype, vendor, product, version
    return i.vendor, i.product, i.version


def keyname(code):
    for n, c in vars(e).items():
        if n.startswith("KEY_") and c == code:
            return n
    return f"code:{code}"


def main():
    paths = list_devices()
    remotes, others = [], []
    for p in paths:
        try:
            d = InputDevice(p)
        except Exception:
            continue
        vid, pid, ver = info(d)
        (remotes if vid == AMAZON_VID else others).append((d, vid, pid, ver))

    if not remotes:
        print("No Amazon remote (VID 0x0171) found among input devices.")
        print("Is the remote BLE-paired to the box? Other input devices seen:")
        for d, vid, pid, ver in others:
            print(f"  {d.path}  {d.name!r}  VID=0x{vid:04X} PID=0x{pid:04X}")
        return

    print("Amazon remote input nodes:")
    for d, vid, pid, ver in remotes:
        keys = sorted(d.capabilities().get(e.EV_KEY, []))
        print(f"  {d.path}  {d.name!r}  PID=0x{pid:04X} ver=0x{ver:04X}  "
              f"({len(keys)} keys)")
    pid = remotes[0][2]
    print(f"\nhwdb match line for this remote (bus 0005 = Bluetooth):")
    print(f"  evdev:input:b0005v{AMAZON_VID:04X}p{pid:04X}*")
    print("\nPress each button (esp. Netflix / Prime / Disney+ / Music / Alexa).")
    print("Ctrl-C when done. Suggested hwdb lines print as scancodes appear.\n")

    devs = {d.fd: d for d, *_ in remotes}
    seen = {}  # scancode -> keyname (kernel's)
    idx = 0
    last_scan = {}  # fd -> pending scancode (per node: interleaved reads must not cross)
    try:
        while True:
            r, _, _ = select.select(list(devs), [], [], 1.0)
            for fd in r:
                for ev in devs[fd].read():
                    if ev.type == e.EV_MSC and ev.code == e.MSC_SCAN:
                        last_scan[fd] = ev.value
                    elif ev.type == e.EV_KEY and ev.value == 1:  # key down
                        scan = last_scan.get(fd)
                        kn = keyname(ev.code)
                        tag = ""
                        if scan is not None and scan not in seen:
                            seen[scan] = kn
                            key = SUGGEST_KEYS[idx % len(SUGGEST_KEYS)]; idx += 1
                            tag = f"   hwdb:  KEYBOARD_KEY_{scan:x}={key[4:].lower()}"
                        sc = f"0x{scan:x}" if scan is not None else "(none)"
                        print(f"node={devs[fd].path}  scancode={sc}  key={kn}{tag}")
                        last_scan.pop(fd, None)
    except KeyboardInterrupt:
        pass

    if seen:
        print("\n--- /etc/udev/hwdb.d/70-tvbox-firetv-remote.hwdb ---")
        print(f"evdev:input:b0005v{AMAZON_VID:04X}p{pid:04X}*")
        i = 0
        for scan, kn in seen.items():
            key = SUGGEST_KEYS[i % len(SUGGEST_KEYS)]; i += 1
            print(f" KEYBOARD_KEY_{scan:x}={key[4:].lower()}    # was {kn}")
        print("---")
        print("Install:  sudo cp the block above into that file, then")
        print("          sudo systemd-hwdb update && sudo udevadm trigger")
        print("Then reconnect the remote and use Settings -> Peripherals to map the keys.")


if __name__ == "__main__":
    main()
