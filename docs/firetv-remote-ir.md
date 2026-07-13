# Fire TV remote: TV IR from the remote + app buttons

A Fire TV / Alexa Voice Remote is more than a plain BLE keyboard. Two Amazon-only
behaviours normally need a Fire TV to set up; this box does both without one.

1. **The remote's own IR blaster** — its Volume ± / Mute / Power keys blast IR
   straight at the TV (the remote has the IR LED, the Fire TV Stick doesn't). A
   Fire TV programs a key→IR "keymap" into the remote over a custom BLE service
   during "Equipment Control". We speak that same service from the box.
2. **The app buttons** (Netflix / Prime Video / Disney+ / Amazon Music / Alexa)
   transmit as **vendor-defined HID usages** that Fire OS decodes via bundled
   keylayouts. A stock Pi kernel doesn't, so they look dead — we remap them so
   they become ordinary buttons you can bind to any app or action.

Protocol notes / reverse-engineering: the assistant-stack repo
`firetv-re/FINDINGS.md` (from Fire OS 7.7.1.3, Fire TV Stick 4K Max / AFTKA).

All tools ship into `~/.tvbox/`. Run them on the box over SSH. The remote must be
BLE-**paired/bonded** to the box (as you already do for HID) — the keymap
characteristics need an encrypted link, but there is **no** Amazon signature or
auth on the keymap itself (only a SHA-256 integrity hash), so a bonded box may
write it.

---

## 1. TV volume / power / mute from the remote's IR blaster

### The easy way: Settings → Peripherals → "Fire TV remote → TV IR"

The guided on-TV flow does all of the below for you, no SSH:

1. **Install Bluetooth support** — one tap creates a user-space venv at
   `~/.tvbox/pyenv` and installs `bleak` (+ `dbus-fast`) into it (needs internet;
   `python3-venv`/`pip` come from `provision.sh`). No root, nothing global.
2. **Pick the remote** — any BLE-paired remote (it needs a MAC to reach over
   BLE; pair it under Bluetooth first).
3. **Pick your TV brand + codeset** — pulled live from the community **irdb**
   database ([github.com/probonopd/irdb](https://github.com/probonopd/irdb),
   cached ~30 days under `~/.tvbox/cache/`). tvbox converts the irdb
   `(protocol, device, subdevice, function)` row into raw IR timings on the box
   (`remote/ir_protocols.py`: NEC/NECx/RC5/RC6/Sony SIRC/Panasonic; anything
   else is greyed out honestly instead of blasting garbage).
4. **Test** — a per-key InstantFire blast (nothing saved yet); point the remote
   at the TV and confirm it reacts, brand codesets vary.
5. **Save to the remote** — programs the keymap; then tvbox sets
   `remote.devices[<mac>].irPassthrough = true` so the bridge stops diverting
   that remote's BT volume keys to the box's own IR blaster (no double volume).

irdb attribution: the verbatim notice its license requires (LICENSE.md clause
2, "Contains/accesses irdb by Simon Peter and contributors, used under
permission. …") is shown in **Settings → About → Open source**, and the flow
footer credits it too. Note the license's **clause 1**: before shipping a
product that uses irdb you must announce it by opening an issue at
github.com/probonopd/irdb/issues (a one-time step for whoever distributes a
build — not a runtime concern).

### The manual way (SSH)

`~/.tvbox/firetv_remote_ir.py` (with `~/.tvbox/keymap_compile.py` +
`~/.tvbox/ir_protocols.py`). Needs `bleak` — either the venv the UI made
(`~/.tvbox/pyenv/bin/python3`) or a plain `python3 -m pip install bleak`.

Codes live in `~/.tvbox/firetv_tv_codes.json` — copy the shipped
`firetv_tv_codes.example.json` (preset for **LG**, NEC, address `0x04`) and edit:

```json
{
  "keys": {
    "VolumeUp": { "nec": { "address": 4, "command": 2 } },
    "VolumeDown": { "nec": { "address": 4, "command": 3 } },
    "Mute": { "nec": { "address": 4, "command": 9 } },
    "Power": { "nec": { "address": 4, "command": 8 }, "optional": true, "post_delay": 1000 }
  }
}
```

Per key, one of: `{"irdb":{"protocol":"NEC1","device":4,"subdevice":-1,"function":2}}`
(an irdb row — what the UI writes), `{"nec":{"address":N,"command":M}}` (LG and
most TVs), `{"pronto":"0000 006D ..."}` (a Pronto/CCF code), or
`{"raw":[...],"frequency":38000}` (on/off durations in **10 µs** units).

```sh
python3 ~/.tvbox/firetv_remote_ir.py scan                      # find the remote's MAC
python3 ~/.tvbox/firetv_remote_ir.py info    <mac>             # confirm VID 0x0171 + keymap service
python3 ~/.tvbox/firetv_remote_ir.py blast   <mac> --key VolumeUp   # fire once, NON-persistent (bring-up)
python3 ~/.tvbox/firetv_remote_ir.py program <mac>             # bind codes to the physical keys
python3 ~/.tvbox/firetv_remote_ir.py erase   <mac>             # remove
python3 ~/.tvbox/firetv_remote_ir.py program --dry-run         # compile + print bytes, no BLE
```

Start with `blast`: it uses Fire OS's _InstantFire_ path to emit a code on the
spot without touching the physical keys — point the remote at the TV; if it
reacts, your code + timing are right. Then `program` makes it stick.

To check on the real remote: BlueZ usually negotiates a large ATT MTU (needed for
the 200-byte chunk writes) automatically; whether the keymap survives the
remote's deep sleep / re-pairing is remote-firmware-dependent — verify.

Shell plumbing for the UI flow is `shell/firetvir.js` (venv + irdb fetch/cache +
BLE tool runner); endpoints under `/tvbox/api/firetvir/*`.

## 2. App buttons → apps (or anything)

The app buttons send vendor HID usages the Pi kernel maps to `KEY_UNKNOWN` (all
alike) or nothing, so they can't be told apart. Fix in three steps:

**a. See what they emit** (member of `input` group, no root):

```sh
python3 ~/.tvbox/firetv_hid_probe.py     # press each app button; note scancodes + hwdb lines
```

It prints the remote's input nodes and, per button, the raw HID `scancode` and
the key code the kernel produced, plus ready-to-paste `hwdb` lines.

**b. Remap the scancodes to distinct keys** — install the printed block as
`/etc/udev/hwdb.d/70-tvbox-firetv-remote.hwdb`, then:

```sh
sudo systemd-hwdb update && sudo udevadm trigger
```

(One-time root setup, like `provision.sh`; not a runtime path. OTA boxes without
SSH can't do this — it needs a provisioned/dev box.)

**c. Grab the app-button node + map it.** App buttons usually sit on a separate
HID "Consumer Control" node that has no nav keys, so the remote bridge ignores it
by default. Turn on capture of a managed remote's other nodes — in
`~/.tvbox/config.json`:

```json
{ "remote": { "captureAllNodes": true } }
```

then `echo reload > /tmp/tvbox-remote-cmd` (or restart `tvbox-remote`). Now the
app buttons flow through the normal per-device pipeline: **Settings → Peripherals
→ (remote) → learn a button → pick an action** — including "launch <app>" for any
installed app, `settings`, `appswitcher`, `power`, or any nav/media key. Off by
default so existing remotes are untouched; pointer/trackpad nodes are never
grabbed.

If a button still shows nothing in the probe, stop the bridge first
(`systemctl --user stop tvbox-remote`) so its grab doesn't hide it, then re-probe.
