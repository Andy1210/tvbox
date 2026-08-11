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

### The easy way: Settings → Remotes & accessories → "Fire TV remote → TV IR"

The guided on-TV flow does everything below for you, with no SSH. It is built around
**devices**, not codesets: you add what is in the room, then say which button
drives which.

1. **Install Bluetooth support** - one tap creates a user-space venv at
   `~/.tvbox/pyenv` and installs `bleak` (+ `dbus-fast`) into it (needs internet;
   `python3-venv`/`pip` come from `provision.sh`). No root, nothing global.
2. **Add a device** - brand (search, or step in by first letter), then the devices
   that brand offers. Those come from a **published index the box downloads**
   (`shell/irindex.js`, one small file per brand, cached ~30 days under
   `~/.tvbox/cache/`); the brand the box read off the TV's HDMI EDID is offered
   first. What the index is built from is below.
3. **Assign the buttons** - Volume ±, Mute and Power each name a device, and
   optionally a **second** one so a single press blasts both. A device whose code
   has no row for a button cannot be assigned to it, and says so.
4. **Test** - a per-key InstantFire blast (nothing saved yet); point the remote
   at the device and confirm it reacts. The test blasts exactly what saving would
   write, second device included. Measured on two Amazon remotes: a blast leaves the
   remote's BLE link DOWN, so a second test right after it fails until the remote is
   woken with a button press, and a remote that was asleep to begin with answers
   status `00` rather than `02`. Neither is a fault in the code; a remote's own
   programmed keys are infrared and need no link at all.
5. **Save to the remote** - programs the keymap; then tvbox sets
   `remote.devices[<mac>].irPassthrough = true` so the bridge stops diverting
   that remote's BT volume keys to the box's own IR blaster (no double volume).
   Erasing sets it back to false.

The setup is stored per remote in `~/.tvbox/firetv_ir_plan.json` and carried by a
backup. It has to be: the keymap lives on the REMOTE and cannot be read back, so
without it a second visit would show a fully programmed remote as unconfigured.
The plan carries **the codes themselves**, not references into the index - so
programming needs no network, and an index rebuilt upstream cannot change what a
remote that is already set up would be written with. A button may only name a
device whose code really carries it - the box enforces that when it stores the
plan, because a key with no code is programmed as nothing and would read on screen
as set up.

A **test** writes `firetv_tv_codes.test.json` and a **program** writes
`firetv_tv_codes.json`; only the second is what "last written to the remote"
reports, and erasing removes it. `~/.tvbox/cache/ir-index-v1.json` and
`ir-brand-<revision>-*.json` are the browsing caches; deleting them is always safe,
and a rebuilt index retires them by itself (their name carries its revision).

### Where the codes come from

Two databases, merged by CI into one index at
**`https://andy1210.github.io/tvbox/ir/`** (built by `scripts/ir-index/build.js`,
published by `.github/workflows/demo.yml` next to the launcher demo, rebuilt weekly
and on any change to the generator):

- **irdb** ([github.com/probonopd/irdb](https://github.com/probonopd/irdb)) - one
  DECODED row per button: protocol, device, subdevice, function. 3243 codesets.
- **Flipper-IRDB**
  ([github.com/UberGuidoZ/Flipper-IRDB](https://github.com/UberGuidoZ/Flipper-IRDB),
  CC0) - one `.ir` file per remote model, each button either `parsed` (a protocol
  plus address/command bytes) or **`raw`** (the microsecond timings themselves).
  1950 curated files; its `_Converted_/` tree is skipped, being 6944 files of other
  databases run through a converter - `_Converted_/CSV/` IS irdb, which the index
  already carries natively.

**Raw is why the second database is here at all.** irdb can only hold what a
decoder understands, so a signal none of them do cannot be in it. Samsung's
soundbars are exactly that: a 4.5/4.5 ms leader where NEC has 9/4.5, i.e. Samsung's
own 36-bit protocol, so every Samsung codeset in irdb is the wrong protocol for one.
A capture of such a remote has to reach the keymap unchanged, which is what
`scripts/ir-index/flipper.test.js` asserts against a codes file known to work.

The box converts a code to IR itself: `remote/ir_protocols.py` for an irdb row
(NEC/NECx/RC5/RC6/Sony SIRC/Panasonic) and `remote/flipper_protocols.py` for a
Flipper `parsed` block (NEC/NECext/NEC42/NEC42ext/Samsung32/RC5/RC5X/RC6/
SIRC 12-15-20/Kaseikyo/RCA/Pioneer, ported from the Flipper firmware's own encoder tables). A raw
capture needs no encoder - it is sent verbatim. Anything else is offered as
unpressable rather than blasting garbage, and the box decides that from ITS OWN
python rather than trusting the index, because a box updates on its own schedule.

Two things the generator does that are easy to get wrong:

- **A capture may hold the same frame several times** (263 of the ~900 that carry
  one of these four buttons do). On a volume key that is two steps per press, and on
  a power toggle a press that undoes itself - so a repeat is cut back to one frame.
  The test is PERIODICITY, not a long gap: a Samsung 36-bit frame carries a 4.5 ms
  element in its middle, and a gap rule would send half of it.
- **Microseconds convert to the keymap's 10 µs unit with python's rounding**
  (half to even), the same rule `ir_protocols.py` uses: 505 µs is 50, not 51.

### Why a brand's list is short

A brand folder in either database is a list of REMOTE MODELS, and the same codes are
filed under every model number that ever carried them - so the index merges the
codesets that send the same four keys into one row (`scripts/ir-index/group.js`).
Measured against the live databases: Samsung's 153 codesets become 64 rows, LG's 109
become 40, and 3243 + 1950 codesets in total become 3089 devices across 1151 brands.

What decides that two codesets are the same device is the **frame they transmit**,
hashed through the encoders above - which is also what merges the two databases: an
irdb `NEC1 4,-1,8` row and a Flipper `NEC addr 04 cmd 08` block are the same
waveform, and offering both would be asking someone to choose between two identical
rows. 54 devices carry codes from both.

A type filter cannot do that job: 1228 of irdb's 1476 type folders are
`Unknown_<remote model>` (65 of Samsung's 68 sets), so grouping by type leaves 60
groups of one. The type is kept as the row's label and a coarse kind (TV / audio /
set-top / player / climate), never as the thing that makes the list short. Two
groups that end up with the same label carry the address they transmit on, and then
the model number most of their files were filed under - brands do file two unrelated
codes under "TV".

Note the box already toggles the TV over HDMI-CEC, so "TV + soundbar on one
button" usually needs only the soundbar's code on that key.

**Attribution.** irdb's licence (LICENSE.md clause 2) requires a verbatim notice
wherever the database is used or accessed: it is shown in **Settings → About → Open
source**, travels inside the index (`ir/index.json`, `ir/NOTICE.txt`) and the flow
footer credits both databases. Clause **1** is a human step for whoever distributes
a build: announce the product by opening an issue at
github.com/probonopd/irdb/issues. Flipper-IRDB is CC0, so it needs none - it is
credited anyway.

**Pointing a fork's boxes at its own build:** `firetvir.indexBase` in
`~/.tvbox/config.json`, the same kind of self-host override as `update.feed` and vetted
by the same rule (`netguard.isAllowedFetchUrl`): https to any host, plain http only to a
LAN or loopback address. Every fetch is then pinned to that origin, and a redirect off it
is refused.

### The manual way (SSH)

`~/.tvbox/firetv_remote_ir.py` (with `~/.tvbox/keymap_compile.py`,
`~/.tvbox/ir_protocols.py` and `~/.tvbox/flipper_protocols.py`). Needs `bleak` -
either the venv the UI made
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
(an irdb row), `{"flipper":{"protocol":"Samsung32","address":"07 00 00 00","command":"02 00 00 00"}}`
(a Flipper-IRDB parsed block), `{"raw":[...],"frequency":38000}` (on/off durations
in **10 µs** units - a capture, and what a soundbar no decoder knows needs),
`{"nec":{"address":N,"command":M}}` (LG and most TVs), or
`{"pronto":"0000 006D ..."}` (a Pronto/CCF code). The UI writes the first three.

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

Shell plumbing for the UI flow is `shell/firetvir.js` (venv, the saved plan, the
BLE tool runner) plus `shell/irindex.js` (the published index); endpoints under
`/tvbox/api/firetvir/*`. The index generator and its tests live in
`scripts/ir-index/`.

## 2. App buttons (Netflix / Prime / …) → any action

The dedicated app buttons don't arrive as normal keys: they're an Amazon
**vendor HID report** the Linux kernel maps to no keycode at all, so they never
reach evdev (the button test / learn mode can't see them). The hamburger and
app-switcher style buttons are similar: their consumer-report usage reaches
evdev only as `KEY_UNKNOWN` (the same code 240 for all of them, useless). But
they all DO show up on the remote's **hidraw** node:

```text
ef a1 00 00 00   # report 0xEF: vendor app buttons, 3 slots of 8 bits
02 33 00 00 00   # report 0x02: consumer control, 2 slots of 16 bits, little endian
                 #   (0x0033 hamburger, 0x0002 app switcher, 0x027E/0x027F/0x0280
                 #    a Remote Pro's customizable and headphone buttons)
01 4f 00 00      # report 0x01: mirrors the NORMAL keys - ignored (evdev has them)
```

Both are HID **arrays**: the report lists the usages currently down, so a
button is released by disappearing from it rather than by a code of its own,
and a report carries several at once. The slot width matters - a Remote Pro's
extra buttons sit above 0xFF, so reading the consumer report a byte at a time
does not reach them at all.

(Observed on an AFTKA-era remote: 0xA1..0xA4 for the four app buttons; other
generations use other usages - the bridge doesn't care which.)

The remote bridge reads that hidraw node directly and injects a virtual
keycode (a per-report band plus the usage: 0xEF at 0x300, 0x02 at 0x400, above
KEY_MAX so it can never collide with a real key, and below the 2048 the shell
accepts in a saved keymap) into the SAME per-device remap pipeline, so EVERY
such button, whatever it sends, becomes learnable/mappable like any other
button:
**Settings → Remotes & accessories → (remote) → learn a button → pick an action** (launch
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
- **Settings → Remotes & accessories → (remote) → "Reset this remote's buttons"** clears
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
