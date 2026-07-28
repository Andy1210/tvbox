# Native apps

Most tvbox apps are web apps: the shell serves a bundle (or loads a remote site)
into a `BrowserWindow`. A **native app** is different. It is an ordinary desktop
program that draws its own full-screen Wayland window, and the shell only
launches and supervises it. RetroArch is the first one.

This page describes the mechanism. For writing the manifest, see
[app-manifest.md](app-manifest.md).

## Why it is not just "another window"

The shell already spawns a native process for video: `mpv`. The two are opposites,
and the difference is the whole design.

|                  | mpv                                       | native app                                |
| ---------------- | ----------------------------------------- | ----------------------------------------- |
| Where it sits    | BEHIND a transparent Electron window      | in front, it IS the visible window        |
| Who has focus    | the launcher (so the D-pad drives the UI) | the app itself                            |
| How it is driven | the shell, over a JSON IPC socket         | the user, with the remote or a controller |
| Leaving it       | the launcher was never gone               | the app has to be ended                   |

Because a native app holds keyboard focus, no renderer of ours sees a key press.
That single fact drives everything below.

## What the shell does

[shell/native.js](../shell/native.js) owns the process, main.js owns the screen.

1. **Launch.** `runtime.native` says what to run: a flatpak ref or a binary, plus
   arguments. The values reach argv, so they are validated by the same parser at
   manifest load time and at launch (`parseSpec`), and no shell is involved.
2. **Hand over the screen.** Every Electron window of ours hides, so the app is
   the only visible toplevel and the compositor gives it focus. The hide is
   delayed a couple of seconds: a freshly mapped toplevel stacks above ours
   anyway, and hiding first would flash the bare desktop while the app starts.
   `raiseWindow()` stands down for as long as a native app is meant to be in
   front, otherwise the shell's own focus handling would pull a window over the
   app and steal its input.
3. **Keep a way out.** See below.
4. **End it.** `stop()` signals the app so it can save and exit, then escalates.
   Leaving for another app, pressing Home, and shutting the shell down all go
   through the same path, so a native app never survives the thing that launched
   it.

## The Home button

A native app has focus, so the launcher's usual "Home goes back to the box" cannot
work: the key never reaches a page of ours. Instead the shell tells BOTH uinput
bridges (`tvbox-cec` and `tvbox-remote`) `native on` over their control FIFOs.
While that is set, each bridge turns the Home key into a `POST /tvbox/api/nav`
with `{"dest":"home"}` instead of emitting a key event, and the shell ends the app
and brings the launcher back.

Two details make this reliable:

- **Both bridges**, because Home arrives from either one. A CEC remote has no Home
  key at all on many TVs, so the bridge synthesizes it from a double-tap of Back;
  a BT/USB remote sends it directly.
- **Re-asserted every 10s** while an app is in front. The bridges keep this in
  memory, so a bridge that restarts (a deploy does exactly that) or crashes would
  otherwise come back without it and swallow the Home button, stranding the user
  in an app they cannot leave.

`KEY_HOMEPAGE` (172) is not bound to anything in RetroArch, which is what makes it
safe to intercept: nothing inside the app wanted it.

## Killing a flatpak app

`flatpak run` is a launcher, not the app. The sandbox (`bwrap`, and the app inside
it) is its CHILD, and it survives the launcher: signal `flatpak run` and it exits
while the app keeps running, reparented to init, leaving a full-screen window on
the TV that the shell no longer knows about.

So `stop()` reads the process tree from `/proc` and signals the app processes
themselves, which also lets the app shut down properly (RetroArch writes its
config and its save files on a term signal, while a `flatpak kill` is a hard stop
that loses both). Escalation is by pid liveness, deliberately not by "is this
still the child we spawned", because the launcher exiting early would otherwise
look like success.

`--die-with-parent` is always passed as the backstop: even if the shell dies in a
way that runs no cleanup, the sandbox cannot outlive its launcher.

## Deps: `requires.flatpak`

A flatpak app is installed with `flatpak install --user`, which needs no root. So
unlike `requires.apt`, a missing flatpak dep is installable straight from the UI:
the tile greys out with "needs RetroArch" until then, exactly like a missing
`requires.download` binary. The install is retried, because an app plus its
runtime is a multi-hundred-MB pull that can time out on a slow link and ostree
resumes from what it already fetched.

## What a native app does NOT get

- **No capabilities.** `runtime.capabilities` describes preload bridges for a web
  page; a native app has no renderer of ours, so it has none of them. It talks to
  the outside world with its own code, under its own sandbox if it has one.
- **No background.** Web apps are hidden when you leave them and resume
  instantly. A native app either owns the screen or has exited: there is no
  half-state, and `running` on its tile means its process is alive.
- **No screen of its own on the box.** This is why an app like this declares
  `pairing` entries: a form on a phone is the only sensible place to configure it,
  and it is also a better place to type a password than a TV remote.

## Hardware OpenGL

A native app is usually a flatpak, and a flatpak brings its own Mesa. On this
hardware that matters more than it sounds: the Pi renders on **v3d** and scans out on
**vc4**, which has no render node at all. (The node numbers are whatever the kernel
handed out - `renderD128` and `card1` on the box this was developed against; the
session detects the v3d one rather than assuming.) wlroots advertises the device it opened for KMS - the vc4 one -
as the linux-dmabuf main device, and a Mesa that learns the device only that way
(anything >= 25.1, which dropped the older `wl_drm` path) finds no render node,
declines zink because v3dv has no `nullDescriptor`, and falls back to **llvmpipe**.
The app then renders on the CPU with a perfectly good GPU sitting idle.

The session therefore points wlroots at the v3d render node
(`WLR_RENDER_DRM_DEVICE` in `~/.config/labwc/environment`, shipped as
`deploy/labwc-environment`; `~/.config/labwc/autostart` re-derives the node from
sysfs on every start, so the shipped default is only a starting point). Scanout still happens on vc4 through a dmabuf import,
which is what the Pi has always done, and GL clients get V3D. It only takes effect
at the next session start, since wlroots reads it once when it comes up.

What this hardware serves, for an app deciding which API to ask for:

| API                                   | available                                                             |
| ------------------------------------- | --------------------------------------------------------------------- |
| desktop OpenGL, compatibility profile | 3.1                                                                   |
| OpenGL ES                             | 3.1                                                                   |
| desktop OpenGL, **core** profile      | not above 3.1 - a core-profile 3.3 request fails with `EGL_BAD_MATCH` |
| Vulkan                                | yes (v3dv)                                                            |

RetroArch's package uses exactly that table: it sets the global video driver to
`gl` when the session provides hardware GL, and writes a per-core override for a
core whose own `required_hw_api` says GL cannot serve it (Beetle PSX HW asks for
either a GL core profile >= 3.3 or Vulkan, so it gets Vulkan).

To check what an app actually got, ask inside its sandbox rather than guessing:

```sh
# hardware? then GL_RENDERER says V3D, not llvmpipe
flatpak run --command=python3 org.libretro.RetroArch /path/to/an/egl/probe.py
```
