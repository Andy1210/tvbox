# Game controllers

Two separate problems, two separate fixes - both on by default, nothing to
configure.

## 1. Driving the UI with a pad

The 10-foot UI is built on DOM key events: the CEC and BT/USB remote bridges
publish a virtual keyboard, and the launcher navigates on arrows / Enter /
Backspace. A game controller emits none of that - it speaks the **Gamepad API** -
so the UI simply never moved for one.

[`app-sdk/src/gamepad.ts`](../app-sdk/src/gamepad.ts) translates a pad into those
same key events: D-pad and left stick → arrows (repeating after a 400 ms hold),
**A** → Enter, **B** → Back. There's a deadzone band (0.45 to press, 0.3 to
release) so a stick resting near the threshold doesn't stutter.

It lives in the **renderer**, not in the input bridge, on purpose: a bridge that
turned pad events into arrow keys would also fire them inside an app that speaks
Gamepad natively - Xbox Cloud Gaming - double-navigating its menus. Only windows
that call `startGamepadNav()` translate (the launcher does, in `main.tsx`); a
gamepad-native app keeps the pad to itself.

Idle cost is zero: the polling loop starts on the first `gamepadconnected` and
stops when the last pad disappears, and `requestAnimationFrame` is throttled to a
stop in hidden windows.

Two details that are easy to get wrong, both learned the hard way:

- the synthetic events are dispatched at the **focused element**, not at `window`.
  For a window-targeted event Chromium runs window listeners in registration order
  and ignores the capture flag, so a screen that swallows keys in the capture phase
  (the screensaver, About's scroll handler) would have run _after_ spatial-nav -
  waking the ambient screen with **A** also launched the focused tile.
- an unrecognised pad's axes 6/7 are a hat on one device and analog **pedals** on
  another, and a pedal rests at `-1.0`. Each pad's resting values are sampled on the
  first frame and deflection is measured from there, so a resting axis is neutral
  whatever it reports.

## 2. Making an unrecognised pad usable in cloud gaming

Chromium decides a pad's `Gamepad.mapping` from its vendor:product id against a
built-in table. A pad that isn't in that table is handed to pages in **raw HID
order** with `mapping: ""`, and an app that must know which button is A/B/X/Y
refuses it. That is exactly what a Nacon MG-X PRO does here:

```text
[gamepad] connected: "Nacon MG-X PRO (Vendor: 3285 Product: 0312)" mapping="" buttons=15 axes=8
```

…while Xbox Cloud Gaming reports "no controller connected" - even though the
kernel, `/dev/input/js0` and Chromium all see the device.

`tvbox-gamepad` ([`gamepad/gamepad_shim.py`](../gamepad/gamepad_shim.py)) fixes
that: it `EVIOCGRAB`s the unrecognised pad and re-emits it through a `uinput`
device that identifies as an **Xbox 360 pad (045e:028e)**, which every browser
maps as standard. The grab is what keeps exactly one pad visible - a kernel grab
is device-wide, so the raw pad's `js` node goes quiet instead of appearing as a
second controller.

The translation is mostly identity, because the kernel already did the hard part:
`hid-generic` gives HID gamepads semantic `BTN_A`/`BTN_B`/… codes rather than raw
button numbers. What differs between pads is where the **right stick** and the
**triggers** live, so those are resolved per device and logged:

| Pad style                             | Right stick | Triggers                |
| ------------------------------------- | ----------- | ----------------------- |
| Xbox-style (has `ABS_RX`/`ABS_RY`)    | RX / RY     | Z / RZ                  |
| Android-style (phone pads, the Nacon) | Z / RZ      | BRAKE/GAS or THROTTLE/… |

```console
$ systemctl --user status tvbox-gamepad     # what it picked, per pad
[gamepad-shim] 'Nacon MG-X PRO' vendor=3285:0312 right-stick=ABS_Z/ABS_RZ triggers=ABS_BRAKE/ABS_GAS
```

Pads from vendors Chromium already maps - Microsoft, Sony (a DualSense on USB
binds the kernel's `playstation` driver and maps as standard), Nintendo, Valve,
Logitech, 8BitDo - are **left alone**, so a working mapping is never replaced by
a guess.

`Z`/`RZ` is the one pair whose code says nothing - it is the right stick on an
Android-style pad and the triggers on an Xbox-style one - so the shim settles it from
the pad's **shape** first and its resting values only when nothing else can:

- `RX`/`RY` present → that is the stick, so `Z`/`RZ` is the trigger pair.
- a **pedal** axis present (`BRAKE`/`GAS`, `THROTTLE`/…) → those are the triggers, so
  `Z`/`RZ` is the stick. A pedal axis is never a stick, whatever it currently reads.
- digital `BTN_TL2`/`BTN_TR2` present → those are the triggers, so `Z`/`RZ` is the stick.
- otherwise, and only then: **where the axis rests** decides. A stick rests mid-range,
  a trigger at its minimum.

That last rule cannot be applied to a pad that has not reported yet. The shim grabs a
pad the instant it appears, and until its first report every axis reads the zero the
kernel created it with - so a Bluetooth Nacon's centred right stick looked like a
released trigger pair and **took the triggers' place**: both triggers went dead, and
the virtual pad's sat half-pressed because a centred stick scales to the middle of a
trigger's range. What counts as a report having arrived is an axis resting at
anything other than that zero, or an `EV_ABS` event actually turning up. A centred
axis is not evidence: on a signed range (`-32768..32767`, which is most pads) the
centre _is_ zero, so the left stick reads centred before the pad has said anything.
Until one of those comes the pad's axes stay unmapped - silent rather than wrong -
for up to five seconds, while buttons pass through. Watch it settle:

```console
[gamepad-shim] 'Some Pad' axes idle at zero - waiting for its first report
[gamepad-shim] 'Some Pad' vendor=…  right-stick=ABS_Z/ABS_RZ triggers=none
```

A D-pad reported as buttons (`BTN_DPAD_*`) becomes the hat, and digital shoulder
triggers become full-scale analog ones - without that, a grabbed pad could lose its
D-pad entirely.

When the last shimmed pad disconnects the virtual pad is **neutralised and removed**:
uinput remembers its last state, so a pad that dies mid-direction would otherwise
leave the UI auto-repeating that arrow forever.

Disable the whole thing with `"gamepad": { "shim": "off" }` in
`~/.tvbox/config.json` (then restart `tvbox-gamepad`). The unit is `Restart=on-failure`
precisely because that off-switch exits cleanly - `always` would respawn it every few
seconds forever.

> On a box that only ever updates over OTA the new service lands on disk and is
> enabled, but systemd only picks it up on the next boot (OTA never reboots the box),
> so the shim starts working then.

Offline unit tests for the pair resolution, the axis scaling and the "don't shim
this" rules: `python3 gamepad/gamepad_shim_test.py` (also in CI; it stubs `evdev`
with the real kernel code values, so no hardware needed).

## Which button does what

| Pad             | UI                | In a game / cloud app  |
| --------------- | ----------------- | ---------------------- |
| D-pad, stick    | move focus        | the app's own handling |
| A               | select            | ditto                  |
| B               | back              | ditto                  |
| everything else | ignored by the UI | ditto                  |

The UI mapping is deliberately minimal: a pad is for playing, and the remote
stays the primary way to drive the box.
