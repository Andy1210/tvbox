# Fire TV remote: TV IR from the remote + app buttons

A Fire TV / Alexa Voice Remote is more than a plain BLE keyboard. Two Amazon-only
behaviours normally need a Fire TV to set up; this box does both without one.

1. **The remote's own IR blaster** - its Volume ± / Mute / Power keys blast IR
   straight at the TV (the remote has the IR LED, the Fire TV Stick doesn't). A
   Fire TV programs a key→IR "keymap" into the remote over a custom BLE service
   during "Equipment Control". We speak that same service from the box.
2. **The app buttons** (Netflix / Prime Video / Disney+ / Amazon Music / Alexa)
   transmit as **vendor-defined HID usages** that Fire OS decodes via bundled
   keylayouts. A stock Pi kernel doesn't, so they look dead - we remap them so
   they become ordinary buttons you can bind to any app or action.

Protocol notes / reverse-engineering: the assistant-stack repo
`firetv-re/FINDINGS.md` (from Fire OS 7.7.1.3, Fire TV Stick 4K Max / AFTKA).

All tools ship into `~/.tvbox/`. Run them on the box over SSH. The remote must be
BLE-**paired/bonded** to the box (as you already do for HID) - the keymap
characteristics need an encrypted link, but there is **no** Amazon signature or
auth on the keymap itself (only a SHA-256 integrity hash), so a bonded box may
write it.

---

## 1. TV volume / power / mute from the remote's IR blaster

### The easy way: Settings → Peripherals → "Fire TV remote → TV IR"

The guided on-TV flow does all of the below for you, no SSH:

1. **Install Bluetooth support** - one tap creates a user-space venv at
   `~/.tvbox/pyenv` and installs `bleak` (+ `dbus-fast`) into it (needs internet;
   `python3-venv`/`pip` come from `provision.sh`). No root, nothing global.
2. **Pick the remote** - any BLE-paired remote (it needs a MAC to reach over
   BLE; pair it under Bluetooth first).
3. **Pick your TV brand + codeset** - pulled live from the community **irdb**
   database ([github.com/probonopd/irdb](https://github.com/probonopd/irdb),
   cached ~30 days under `~/.tvbox/cache/`). tvbox converts the irdb
   `(protocol, device, subdevice, function)` row into raw IR timings on the box
   (`remote/ir_protocols.py`: NEC/NECx/RC5/RC6/Sony SIRC/Panasonic; anything
   else is greyed out honestly instead of blasting garbage).
4. **Test** - a per-key InstantFire blast (nothing saved yet); point the remote
   at the TV and confirm it reacts, brand codesets vary.
5. **Save to the remote** - programs the keymap; then tvbox sets
   `remote.devices[<mac>].irPassthrough = true` so the bridge stops diverting
   that remote's BT volume keys to the box's own IR blaster (no double volume).

irdb attribution: the verbatim notice its license requires (LICENSE.md clause
2, "Contains/accesses irdb by Simon Peter and contributors, used under
permission. …") is shown in **Settings → About → Open source**, and the flow
footer credits it too. Note the license's **clause 1**: before shipping a
product that uses irdb you must announce it by opening an issue at
github.com/probonopd/irdb/issues (a one-time step for whoever distributes a
build - not a runtime concern).

### The manual way (SSH)

`~/.tvbox/firetv_remote_ir.py` (with `~/.tvbox/keymap_compile.py` +
`~/.tvbox/ir_protocols.py`). Needs `bleak` - either the venv the UI made
(`~/.tvbox/pyenv/bin/python3`) or a plain `python3 -m pip install bleak`.

Codes live in `~/.tvbox/firetv_tv_codes.json` - copy the shipped
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
(an irdb row - what the UI writes), `{"nec":{"address":N,"command":M}}` (LG and
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
spot without touching the physical keys - point the remote at the TV; if it
reacts, your code + timing are right. Then `program` makes it stick.

To check on the real remote: BlueZ usually negotiates a large ATT MTU (needed for
the 200-byte chunk writes) automatically; whether the keymap survives the
remote's deep sleep / re-pairing is remote-firmware-dependent - verify.

Shell plumbing for the UI flow is `shell/firetvir.js` (venv + irdb fetch/cache +
BLE tool runner); endpoints under `/tvbox/api/firetvir/*`.

## 2. App buttons (Netflix / Prime / …) → any action

The dedicated app buttons don't arrive as normal keys: they're an Amazon
**vendor HID report** the Linux kernel maps to no keycode at all, so they never
reach evdev (the button test / learn mode can't see them). The hamburger and
app-switcher style buttons are similar: their consumer-report usage reaches
evdev only as `KEY_UNKNOWN` (the same code 240 for all of them, useless). But
they all DO show up on the remote's **hidraw** node:

```
ef a1 00 00 00   # report 0xEF: vendor app buttons (byte[1] = code, 0x00 = release)
02 33 00 00 00   # report 0x02: consumer buttons (0x33 hamburger, 0x02 app switcher)
01 4f 00 00      # report 0x01: mirrors the NORMAL keys - ignored (evdev has them)
```

(Observed on an AFTKA-era remote: 0xA1..0xA4 for the four app buttons; other
generations use other bytes - the bridge doesn't care which.)

The remote bridge reads that hidraw node directly and injects a virtual
keycode (a per-report band + the raw byte: 0xEF at 0x300, 0x02 at 0x400, above
KEY_MAX so it can never collide with a real key) into the SAME per-device
remap pipeline, so EVERY such button, whatever byte it sends, becomes
learnable/mappable like any other button:
**Settings → Peripherals → (remote) → learn a button → pick an action** (launch
any installed app, `settings`, `appswitcher`, `power`, media/nav, …).

No hwdb, no `captureAllNodes`, no per-box setup: `provision.sh` grants the
`input` group read on Amazon-VID (0x0171) remotes' hidraw
(`SUBSYSTEM=="hidraw", KERNELS=="0005:0171:*"`), and the bridge auto-detects the
node by the remote's MAC. Without the grant the feature is simply inert.

Debug (see EVERYTHING the bridge receives, raw: every evdev key event incl.
dropped KEY_UNKNOWNs and every hidraw report before filtering): set
`TVBOX_HIDRAW_DEBUG=1` in the `tvbox-remote` service environment (drop-in:
`systemctl --user edit tvbox-remote`, `[Service]` /
`Environment=TVBOX_HIDRAW_DEBUG=1`) and watch `journalctl --user -u
tvbox-remote -f`. A button that logs nothing on either path doesn't reach the
box at all (IR-only key or a different BLE service). Ad-hoc (bridge stopped):
`sudo cat /dev/hidrawN | xxd`.

> Note: the older `firetv_hid_probe.py` (hwdb approach) and
> `config.remote.captureAllNodes` are kept for other remotes whose extra
> buttons DO reach evdev, but Amazon app buttons need the hidraw path above.

## 3. If a remap goes wrong

Remapping is per-device and only overrides the buttons you teach, but you can
still paint yourself into a corner (e.g. reassign the arrows). Recovery, in
order:

- The **TV's own remote over HDMI-CEC is never remapped** - it always drives
  the menu, so you can fix the BT remote from there.
- **Settings → Peripherals → (remote) → "Reset this remote's buttons"** clears
  all of that remote's remapping.
- **Panic gesture:** hammer the SAME (remapped) button 8 times rapidly (under
  0.4s between taps) on the misbehaving remote; the bridge detects the raw
  taps (before the remap) and resets that remote, even when every button is
  reassigned. Only buttons remapped to non-repeat-prone actions count (volume,
  arrows, seek, prev/next and app-cycling are exempt), so normal fast tapping
  can never wipe a config.

When learning, an already-assigned button prompts a confirm before it's
reassigned, and the learn modal auto-cancels after 10s (or Cancel/Back with
another remote).
