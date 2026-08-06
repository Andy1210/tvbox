# CLAUDE.md - tvbox

FireTV-style TV box for the Raspberry Pi 5: Electron shell + React 10-foot
launcher + native `mpv`, driven by the TV remote over HDMI-CEC. The
user-facing [README.md](README.md) is the manual; this file is the **map for
an AI agent** - what runs where and which assumptions burn you.

> Convention in this file: `<pi-ssh-host>` is the SSH host of the target Pi
> (e.g. `pi@raspberrypi.local`, or a `~/.ssh/config` alias) - substitute your
> own. `<user>` is the box's login user; everything lives under its
> `~/.tvbox/`.

## Architecture in one screen

```text
TV remote     ─HDMI-CEC→ cec_uinput_bridge.py    (systemd USER unit tvbox-cec)     ─┐ uinput
BT/USB remote ─evdev───→ remote_input_bridge.py  (systemd USER unit tvbox-remote) ─┘ key events
   both write /dev/uinput via the udev grant + `input` group - NO root. tvbox-cec        │
   forwards CEC keys (+ TV power); tvbox-remote EVIOCGRABs each remote and re-emits its   │
   keys, applying a PER-DEVICE button remap (unmapped buttons pass straight through).     ▼
greetd ─→ tvbox-wc (our compositor) ─→ session.sh ── respawn loop ── run-shell.sh ── Electron shell (shell/)
   • compositor control socket: $XDG_RUNTIME_DIR/tvbox-wc.sock (modes, HDR, focus, typing, screenshot)
   • control FIFOs: /tmp/tvbox-cec-cmd ("on 0"/"standby 0") · /tmp/tvbox-remote-cmd (reload | learn <id>)
   • HTTP 127.0.0.1:8097 - serves the launcher (/tvbox/), app web/ bundles at /<id>/, JSON API
   • apps = PACKAGES in ~/.tvbox/apps/<id>/ (manifest.json + plugin.js + web/), installed from the registry
   • plugins ship IN the package (~/.tvbox/apps/<id>/plugin.js) - deps-gated, host-process, boot-time only
   • mpv: lazy shared player BEHIND the transparent window (JSON IPC /tmp/tvbox-mpv.sock)
   • every app runs in its OWN window (background apps: leaving hides, resume is instant - docs/background-apps.md);
     local apps get the full preload SDK, remote apps (YouTube) a hardened sandbox window; ONE window visible at a time
   • pairing server 0.0.0.0:8099 - phone forms, only while pairing, code-gated
   • MQTT (optional; Settings → Network or ~/.tvbox/config.json) - now-playing / commands / notify (HA) - docs/mqtt-integration.md
```

Launcher (launcher/) is React+TS+Vite+Tailwind, spatial nav via
`@noriginmedia/norigin-spatial-navigation`, built into `shell/launcher-dist/`.

## Layout

| Path                                                                                                  | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [shell/main.js](shell/main.js)                                                                        | Electron host: windows, app launching, the API's routes, the plugin loader, MQTT glue. What is NOT here any more: the player, the box's own settings, the background jobs and the HTTP transport - the five rows below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [shell/player.js](shell/player.js)                                                                    | **The shared mpv**, and the two sequences that are easy to break: a fullscreen film starts PAUSED so the output mode and the colour space land before the first frame, and every launch carries a sequence number so a slow property read cannot claim a mode for the film after it. One process, one display-mode claim, one HDR claim. The shell injects which windows hear a player event, how to reveal the video, the mode arbiter and the TV's power.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [shell/system.js](shell/system.js)                                                                    | The machine's own settings: wifi, ethernet, timezone, keymap, hostname, and the About numbers. nmcli/hostnamectl/timedatectl/localectl, never sudo. Commands go through an injectable execFile, which is what makes the parsing testable - and the parsing is where the bugs are (nmcli escapes ':' inside a value; a hidden network answers with an EMPTY SSID field).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [shell/maintenance.js](shell/maintenance.js)                                                          | The work the box does to itself: installs, binary deps, flatpak updates, re-extracting a stale bundle, finishing a restore. Owns the flags `boxFree()` reads and answers for all of them - the nightly update spends its registry download before any app is marked installing, so "idle and nothing installing" would call the box free while it is already saturating the link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [shell/httpserver.js](shell/httpserver.js)                                                            | The transport under the API: JSON responses, static files, the same-origin gate, plugin-route matching. Two of those are security decisions and have tests - a static path must not escape its root (nor reach a sibling directory that merely shares a prefix), and a state-changing request must carry one of our own origins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [shell/edid.js](shell/edid.js)                                                                        | What the TV says about itself, read from sysfs rather than over a compositor protocol: HDR capability (BT2020 + PQ), the registered manufacturer id (LG files as GSM, Panasonic as MEI - no brand can be matched as a substring), and the name the set gives itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [shell/install.js](shell/install.js)                                                                  | Manifest loading/**validation** + bundle install runner. Shared by shell + CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [shell/flatpak.js](shell/flatpak.js)                                                                  | **The one place that knows flatpak**: which refs an app depends on and in which arch (`requires.flatpak` = it RUNS one; `install.source.flatpak` = its bundle was EXTRACTED from one), installed versions (`flatpak list`, cached), commits, `--user` install/update. install.js/store.js/main.js/cli.js all go through it. The COMMIT, not the version, decides whether a flatpak moved - a rebuild can keep the version string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [shell/cli.js](shell/cli.js)                                                                          | `tvbox list/deps/install/remove/flatpak-update/update/backup/restore` (symlinked at `~/.local/bin/tvbox`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [shell/updater.js](shell/updater.js)                                                                  | OTA self-update: feed check, versions/ install, `current` symlink flip. Rollback lives in [deploy/run-shell.sh](deploy/run-shell.sh).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [shell/backup.js](shell/backup.js)                                                                    | Encrypted settings backup/restore (phone page: [shell/pairing/backup.js](shell/pairing/backup.js)). Carries config, manifests, per-app `storage` data, app-declared files (`backup.paths`/`backup.state`) and the **list of installed app ids**; what it cannot carry is re-acquired by reconcile.js. A CLONE restore replays only `tvbox.`-prefixed localStorage keys (gated on `payload.clone` like identity.js; the machine id can only force the answer to "same box", never to "different", because a re-flash also arrives with a fresh one): that store is shared by the launcher and every local app on one origin, so carrying it whole handed the second box an app's identity and login - two boxes became one Plex device. Same principle as identity.js, for renderer storage.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [shell/reconcile.js](shell/reconcile.js)                                                              | **A restore is a reconciliation, not a file copy.** What sits behind the settings - registry packages, flatpaks, `~/.tvbox/bin` binaries, extracted bundles - cannot travel in a JSON file, so a restore records a desired state in `~/.tvbox/reconcile.json` and the next boot works towards it: app -> deps -> bundle, only while idle, progress on `/tvbox/api/reconcile/status`. A FAILED run gets 3 attempts; an INTERRUPTED one retries for free. Headless: `tvbox reconcile [--all]`. [docs/updates-and-backup.md](docs/updates-and-backup.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [shell/identity.js](shell/identity.js)                                                                | **What makes this box THIS box** - the one list of config fields that must never be shared between two boxes: `mqtt.deviceId` (it becomes an MQTT TOPIC SEGMENT) and `spotify.deviceName`. Both are DERIVED from the hostname when unset, and `setMqtt`/`setSpotify` refuse to STORE a value that only echoes that default - otherwise saving a settings form would freeze today's hostname in, and a clone would read it as a name its owner chose. A clone restore (`clone: true`, chosen on the SOURCE box) re-derives them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [shell/mediastate.js](shell/mediastate.js)                                                            | mpv (the clock) + the foreground app's now-playing (the metadata) + the audio sink (the volume) -> ONE retained `state` payload, which is what the Home Assistant `media_player` runs on. Pure and unit-tested: the merge rules and "is this change worth publishing" live here, the wiring in main.js.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [homeassistant/custom_components/tvbox/](homeassistant/custom_components/tvbox)                       | The box as a real HA `media_player`, copied into a Home Assistant config dir by hand. It exists because HA's MQTT integration has **no media_player platform** - a discovery payload cannot make one. Thin: the broker is its only channel, discovery happens at the INTEGRATION level (the manifest declares the box's retained `announce` topic), and `supported_features` comes from the command list the box advertises. [docs/homeassistant-integration.md](docs/homeassistant-integration.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [scripts/image-smoke.sh](scripts/image-smoke.sh)                                                      | **The SD image is tested now.** Phase 1 mounts it (geometry, free space BEFORE the first-boot expand, cmdline/kernel/fstab, every runtime file OTA can never install); phase 2 boots its OWN systemd under `systemd-nspawn` + arm64 binfmt and asserts from inside. Runs in image.yml before the upload; `--self-test` runs on every push. It does NOT run the Pi's kernel or a graphical session - read the script header before trusting a pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [app-sdk/](app-sdk/)                                                                                  | `@tvbox/app-sdk` - the shared 10-foot UI SDK (spatial-nav focus components, OSK, PIN pad, i18n, config/capability clients). The launcher AND every app package consume it as source via the `@sdk` Vite alias.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `~/.tvbox/apps/<id>/`                                                                                 | Where installed app PACKAGES live (manifest.json + plugin.js + web/), fetched from the [tvbox-apps registry](https://github.com/Andy1210/tvbox-apps). No in-shell first-party slot - the shell ships only the SDK. Schema: [docs/app-manifest.schema.json](docs/app-manifest.schema.json).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [shell/appfetch.js](shell/appfetch.js) + [shell/appdata.js](shell/appdata.js)                         | Capability brokers: `fetch` (origin-locked SSRF-guarded data proxy) + `storage` (per-app kv). See [docs/capabilities.md](docs/capabilities.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [shell/display.js](shell/display.js) + [shell/displaymode.js](shell/displaymode.js)                   | Adaptive output mode: mode parsing/selection (pure, unit-tested) + the claim/release arbiter behind the `display` capability and the shell's mpv path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [shell/netguard.js](shell/netguard.js)                                                                | **Single** network-trust classifier (loopback/RFC1918/link-local/metadata/IPv4-mapped-IPv6). `appfetch`'s SSRF logic is the reference; `updater`/`main`/`install`/`pairing` all import from here so the guards can't drift apart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [shell/preload-app.js](shell/preload-app.js)                                                          | Sandbox-safe contextBridge preload for **capability apps** in the isolated window (vs [shell/preload.js](shell/preload.js) for the main/Node-capable window).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [tvbox-apps AUTHORING.md](https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md)              | How to write an app package (layout, manifest, web/ UI via `@tvbox/app-sdk`, host plugin, deps + platform baseline). The launcher no longer compiles in any app view.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [launcher/src/lib/i18n.tsx](launcher/src/lib/i18n.tsx) + [locales/](launcher/src/locales/)            | i18n; en+hu key parity is test-enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [deploy/deploy.sh](deploy/deploy.sh)                                                                  | Build + rsync + provision + user-space setup. Idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [deploy/provision.sh](deploy/provision.sh)                                                            | **The ONE root step** (apt baseline, udev/polkit, linger, legacy migration).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [deploy/install-compositor.sh](deploy/install-compositor.sh) + [deploy/session.sh](deploy/session.sh) | **How the box gets a screen.** greetd starts `tvbox-wc -- /usr/local/bin/tvbox-session`, the root wrapper exec's `~/.tvbox/session.sh` (audio, then the shell's respawn loop), and the installer puts the compositor in place - from the release pinned in `deploy/compositor.version`, or from a source tree on the box. There is no fallback compositor: an image that cannot install one boots to nothing, which is why that step is fatal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [deploy/tvbox-diag.sh](deploy/tvbox-diag.sh) + [deploy/tvbox-safemode.sh](deploy/tvbox-safemode.sh)   | **What the box says when nothing works.** A plain-text report on the FAT boot partition (readable by the firmware, the box, and any laptop, and it survives a read-only root), plus a safe mode that comes up with networking and sshd but NO session - on request from the boot partition, or after 3 starts that never reached the launcher. Root (the partition mounts `fmask=0022`); the shell's only part is a marker file, [shell/boothealth.js](shell/boothealth.js). Both installed by provision.sh AND the image stage from the SAME repo file, so there is no heredoc to keep in sync. [docs/diagnostics.md](docs/diagnostics.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [deploy/infra.list](deploy/infra.list) + [scripts/copy-infra.sh](scripts/copy-infra.sh)               | **Single source of truth** for every non-`shell/` file that must ship. All four channels (dev deploy, OTA tarball, SD image, CI) copy from it; `shell/updater.js`'s `INFRA_FILES` allowlist is cross-checked against it by `shell/updater.test.js`. Add a file here → it ships everywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [cec/cec_uinput_bridge.py](cec/cec_uinput_bridge.py)                                                  | CEC→uinput bridge (user service). LG quirks documented in its docstring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [remote/remote_input_bridge.py](remote/remote_input_bridge.py)                                        | BT/USB remote → uinput bridge (user service `tvbox-remote`): EVIOCGRAB + per-device button remap, learn mode over a FIFO. Special remap actions emit no key: `power` = CEC TV toggle (`toggle 0` FIFO), `settings`/`appswitcher` = shell `/tvbox/api/nav`. Fire TV **app buttons** (vendor HID, no evdev key) are read from the remote's **hidraw** node (reports 0xEF vendor + 0x02 consumer; provision grants Amazon-VID hidraw) and injected as virtual keycodes (0x300/0x400 + report byte, ANY button, nothing hardcoded; report 0x01 mirrors normal keys and stays ignored) into the same remap path. **Panic reset:** same remapped raw button ×8 rapid (repeat-prone actions exempt) → `/tvbox/api/remote/reset`. Keymap in `config.remote.devices`; UI (button-test + reset + reassign-confirm) is Settings → Peripherals ([launcher/src/components/RemoteRemap.tsx](launcher/src/components/RemoteRemap.tsx)).                                                                                                                                                                                                                                                                                    |
| [gamepad/gamepad_shim.py](gamepad/gamepad_shim.py)                                                    | Gamepad shim (user service `tvbox-gamepad`): EVIOCGRABs a controller Chromium does NOT recognise and re-emits it through uinput as an Xbox 360 pad (045e:028e), so `Gamepad.mapping` becomes `"standard"` and apps that need to know which button is A/B/X/Y (Xbox Cloud Gaming) accept it. Pads from vendors Chromium already maps (Microsoft/Sony/Nintendo/Valve/Logitech/8BitDo) are left alone. `config.gamepad.shim: "off"` disables it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [shell/fileserver.js](shell/fileserver.js)                                                            | **The box's folders over WebDAV** (`rclone serve webdav`, supervised, no root). The shared set is a directory of SYMLINKS rebuilt per change (`--copy-links`, writes included). Which folders are offered is DISCOVERED - `~/.tvbox` user content (machinery filtered by name), `~/*`, and each installed flatpak's data dir, which is how an emulator's BIOS folder becomes reachable - so a folder a future app adds needs no code change. A password is mandatory (it binds to the LAN) and reaches rclone through the environment, never argv. [docs/file-server.md](docs/file-server.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [shell/ir.js](shell/ir.js)                                                                            | IR blaster hub: TV volume/mute for CEC-volume-less TVs, pluggable backends (`esphome` native API - XIAO Smart IR Mate; `homeassistant` scripts - Broadlink et al). Fed by the remote bridge's volume keys + MQTT `volume_*`/`mute`. Recipes: [docs/ir-blaster.md](docs/ir-blaster.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [shell/appwindows.js](shell/appwindows.js)                                                            | Background-apps window registry + hidden-set policy (mute/pause on hide, RAM-scaled LRU caps). Per-window app identity (`windowAppId`), foreground orchestration + `switchApp` live in main.js. `config.apps.background=false` = old destroy-on-leave. [docs/background-apps.md](docs/background-apps.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [shell/native.js](shell/native.js)                                                                    | **native programs** (RetroArch): a program that draws its OWN full-screen Wayland window. Either the whole app (`type: native`) or something a web app LAUNCHES per item (`type: webclient` + `runtime.native` + `host.launchNative(id, args)` - RetroArch's grid starting `retroarch -L <core> <rom>`; the arguments go through the same parser that validates a manifest, and the app's own window is what the screen returns to when the program exits, `nativeHostApp` in main.js). The opposite of mpv, which sits BEHIND a transparent window and is IPC-driven so the launcher keeps focus. A native app owns screen AND input, so every Electron window hides and `raiseWindow()` stands down (`nativeForeground` in main.js is the intent flag, deliberately not "is the process alive"). Home cannot reach any renderer, so BOTH uinput bridges are put in `native on` mode over their FIFOs and turn Home into `POST /nav {dest:home}`, re-asserted every 10s so a bridge restart cannot strand the user in an app. Killing a flatpak app means signalling the app pids found via `/proc`, NOT the `flatpak run` launcher (the sandbox survives it). [docs/native-apps.md](docs/native-apps.md). |
| [shell/firetvir.js](shell/firetvir.js)                                                                | Fire TV remote IR programming (Settings → Peripherals): venv+bleak deps install, irdb codeset fetch/cache (github.com/probonopd/irdb), test/program via `remote/firetv_remote_ir.py`. Protocol encoders: [remote/ir_protocols.py](remote/ir_protocols.py); keymap bytes: [remote/keymap_compile.py](remote/keymap_compile.py). [docs/firetv-remote-ir.md](docs/firetv-remote-ir.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [docs/app-manifest.md](docs/app-manifest.md)                                                          | How to write an app (the extension story).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [docs/sd-image.md](docs/sd-image.md)                                                                  | pi-gen flashable-image recipe (workflow: .github/workflows/image.yml).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [docs/diagnostics.md](docs/diagnostics.md)                                                            | The boot-partition report + safe mode: what is in it, both triggers, and what it deliberately does not cover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [docs/updates-and-backup.md](docs/updates-and-backup.md)                                              | OTA + OS updates (never auto-reboot) + phone backup. Release: [scripts/make-release.sh](scripts/make-release.sh) / release.yml.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Hard rules

1. **No root at runtime.** Root lives ONLY in `deploy/provision.sh` (one-time
   udev/polkit/apt) and the apt path of `tvbox deps`. Never add `sudo` to the
   shell - a feature that seems to need it needs a udev/polkit grant in
   provision instead. Reboot/poweroff = plain `systemctl` (logind
   active-session polkit), sudo is only a fallback. **Power-user sudo is a
   separate, opt-in HUMAN affordance**, not a runtime path: `SUDO=true` in the
   boot-partition `tvbox.conf` makes `tvbox-firstboot`/`provision.sh` grant the
   box user passwordless sudo for an SSH admin (see the `010_pi-nopasswd` note in
   Sharp edges). It never changes that the shell/app code runs rootless.
2. **`runtime.capabilities` is the security boundary** and fails closed
   (default `["nav"]`, `capsFor` in main.js). The launcher (id null) gets
   nav+player+config. Remote sites NEVER run in the main window - it has
   `contextIsolation:false` for the Plex QWebChannel bridge; remote apps get
   the hardened separate window. Don't move apps between these worlds. That
   bridge now ships IN the app package (`runtime.bridge: "./bridge.js"`, the
   shell has none of its own), so a package puts renderer code into that
   non-isolated window - the same review-is-the-boundary trust as its
   `plugin.js`, and less than it. `bridgePath` in main.js pins the file inside
   the package dir before it reaches `require()`; the manifest validator gates
   the same shape. Brokered
   capabilities (`player`, `fetch`, `storage`) are gated the same way in BOTH
   preloads (`preload.js` main window; `preload-app.js` isolated window, attached
   only to capability apps). A new capability = a new broker gated on its cap
   name; never expose one unconditionally. The `fetch` broker is origin-locked +
   SSRF-guarded (appfetch.js) - see [docs/capabilities.md](docs/capabilities.md).
3. **Manifests reload live, plugins don't.** `GET /tvbox/api/apps` re-reads
   `shell/apps/` + `~/.tvbox/apps/` on every call; a dropped-in manifest
   appears immediately. `service` plugins load at boot only (deps-gated) - a
   new plugin needs a shell restart. `manifestVersion` is 1; the validator in
   install.js skips anything else.
4. **i18n both-or-nothing:** every launcher string goes through `t()`/`loc()`
   and must exist in BOTH `locales/en.json` and `hu.json` -
   `locales.test.ts` fails on drift or dead keys. Defaults are `en`
   everywhere (pairing pages, livetv "Other" fallback, `index.html` lang).
   No emoji in launcher UI - the box's Chromium has no colour-emoji font
   (renders tofu); inline SVG only.
5. **Apps install their own binaries (Kodi model); the core ships only the
   shared media stack.** `image/stage-tvbox` + `deploy/provision.sh` preinstall
   **`mpv`** (the shared player for Live TV + Plex) and the runtime libs
   **`libpulse0`/`libasound2t64`** - the "core provides ffmpeg/system libs" layer.
   App-specific binaries are NOT bundled: they're `requires.download` static
   binaries the app installs **from the UI, no root** (tap the greyed tile →
   `POST /apps/deps` → `installDownload`, sha256-pinned into `~/.tvbox/bin`).
   Spotify's `librespot` is exactly this - a hosted aarch64 binary (release
   `librespot-v0.8.0`, extracted from raspotify/librespot v0.8.0), not bundled.
   `apt`/`aptRepo` deps still need `tvbox deps` (root) and should be avoided for
   apps - prefer `requires.download`. A flathub app is the third no-root kind
   (`requires.flatpak`, `flatpak install --user`): RetroArch is exactly this,
   and a missing one greys the tile and installs from the UI like a download dep. Spotify Connect is also opt-in at
   _runtime_: the daemon runs only when `config.spotify.enabled` is set (the
   launcher's enable toggle). A `service` app that gains its binary via a UI
   deps-install auto-restarts the shell to load its plugin - but only when
   `boxIdle()` and nothing else is installing.
6. **Secrets stay in `~/.tvbox/`** (config.json chmod 600). The launcher only
   ever sees `publicConfig()` - check it before exposing a new config field.
   Parental PIN: salted sha256 + timingSafeEqual (legacy unsalted still
   verifies).
7. **Everything must degrade on a keyboardless TV**: missing binary → greyed
   tile; shell API down → retry screen (not onboarding); renderer crash →
   ErrorBoundary reload button. Never leave a dead end that needs a keyboard.

## Dev / deploy / verify

```sh
npm run format         # ALWAYS before any commit - prettier --write over the repo
cd launcher && npm run typecheck && npm test && npm run build      # before any commit
./deploy/deploy.sh <pi-ssh-host>                    # full deploy (provision included)
./deploy/deploy.sh <pi-ssh-host> --skip-provision   # iterate without the root step
```

**Run `npm run format` before every commit.** CI runs `npm run format:check`
(prettier `--check .`) and fails the build on any unformatted file - this is
not optional and not launcher-scoped, it covers the whole repo. If you only
touched one file, `npx prettier --write <file>` is enough; when in doubt run
`npm run format`.

- Deploy does NOT restart a running shell. Restart it with
  `ssh <pi-ssh-host> pkill -f 'electron[/]dist'` (the autostart respawn loop restarts it; note:
  a bare `pkill -f "electron ."` also matches your own ssh command line and
  kills the connection - hence the `[/]` character class).
- Verify (on the box, via ssh): `curl -s http://127.0.0.1:8097/tvbox/api/apps`,
  `systemctl --user status tvbox-cec`, `journalctl --user -u tvbox-cec` for CEC
  traffic/keypress logs.
  A screenshot of the running UI, from the compositor itself:
  `printf '{"id":1,"request":"screenshot","path":"/tmp/shot.png"}\n' | nc -U $XDG_RUNTIME_DIR/tvbox-wc.sock`.
- Lockfiles are committed (shell's was generated with
  `npm i --package-lock-only`; a full `npm install` in shell/ downloads the
  ~100MB ARM64 Electron - avoid on the dev host).

## Sharp edges

- **Three independent uinput bridges feed input**, all user services: `tvbox-cec`
  (CEC, [cec/cec_uinput_bridge.py](cec/cec_uinput_bridge.py)) and `tvbox-remote`
  (BT/USB evdev, [remote/remote_input_bridge.py](remote/remote_input_bridge.py)).
  `tvbox-remote` **EVIOCGRABs** every remote's keyboard node, so if it misbehaves
  the remotes look dead - `systemctl --user stop tvbox-remote` releases the grabs
  and they fall straight back to raw keys (the kernel also releases grabs if the
  process dies, so a crash self-heals). Default is pure pass-through; only buttons
  the user explicitly remapped (Settings → Peripherals) are rewritten. Device id
  is the BT MAC (uniq) or USB path; the friendly name has the kernel's
  " Keyboard"/" Consumer Control" collection suffix stripped. The renderer only
  ever sees canonical keys - there is deliberately no device identity in DOM key
  events, which is exactly why the remap lives in the bridge, not the launcher.
  The third bridge is `tvbox-gamepad`
  ([gamepad/gamepad_shim.py](gamepad/gamepad_shim.py)), which grabs only devices
  that look like a gamepad (BTN_SOUTH + ABS_X/ABS_Y) - the remote bridge
  deliberately ignores those (its filter requires nav KEYS), so the two never
  fight over a device.
- **A game pad reaches a native program whether or not it has focus.** RetroArch runs
  with `input_joypad_driver = "udev"`, i.e. it reads `/dev/input` itself, while a
  renderer of ours reads the same pad through Chromium's Gamepad API. So any window
  shown over a running game would act on the very presses the game is also getting.
  The RetroArch app's grid translates pad → keys only while its own window is
  visible (`startGamepadNav` stops on `visibilitychange`), which is what keeps the pad
  the emulator's alone during a game. Anything that wants an on-screen overlay
  mid-game has to solve this first - the pad cannot be "taken back" by focus.
- **A pad's Guide button has a different NUMBER on every pad, and RetroArch's own
  profile for the official Xbox controller gets it wrong.** RetroArch's udev driver
  numbers buttons by ascending evdev code from `BTN_MISC`, so the index depends on the
  key set the KERNEL reports: `hid-microsoft` claims the full gamepad set for an Xbox
  pad over Bluetooth, including four buttons the hardware hasn't got (`BTN_C`,
  `BTN_Z`, `BTN_TL2`, `BTN_TR2` - its triggers are axes), which moves `BTN_MODE` from
  8 to **12**. libretro's `Xbox One S Wireless Controller.cfg` (matched by
  vendor+product 045E:0B13) shifts every other bind accordingly - select 10, start 11,
  thumbs 13/14 - and leaves `input_menu_toggle_btn = "8"`, i.e. a button that does not
  exist. That, not the pad, is why the Xbox button did nothing in-game while the
  gamepad shim's re-emitted pad (eleven keys, Guide at 8) worked.
  **A global `input_menu_toggle_btn` cannot fix it**: measured, a concrete global value
  overrides EVERY profile's bind, and no single number can serve two pads whose Guide
  sits at different indices - a profile's own bind only applies while the global is
  `"nul"`. So the correction is per device: the retroarch plugin reads each connected
  pad's key set from sysfs (`lib/pads.js`), and owns RetroArch's profile directory
  (`lib/autoconfig.js` - the flatpak's is read-only, so the mirror symlinks every
  profile at its SANDBOX path and replaces the corrected ones with real files).
  `quit_on_close_content = "1"` comes with it, so the menu's "Close Content" ends
  RetroArch and the shell brings the games grid back. All of it verified with a uinput
  pad cloned from the real one's vendor/product AND key set - the identity and the key
  set are what the behaviour keys off, so a clone answers the question without the
  physical pad.
- **CEC is TV-specific.** Every TV forwards a different subset of remote keys
  and quirks its own way - the mapping in `cec_uinput_bridge.py` was tuned
  empirically (e.g. on the LG set it was developed against, Back and Exit share
  one code, Home/colour keys are never forwarded, and long-press is
  undetectable, so Home is synthesized as a double-tap of Back within 0.4s).
  Don't "fix" the mapping without a real TV to test on, and name the TV model
  in any commit touching CEC.
- **LG TVs need the vendor shim** ([cec/cec_vendor_shim.c](cec/cec_vendor_shim.c)):
  SIMPLINK only forwards keys to devices whose CEC vendor ID reads LG, and
  libcec's own LG masquerade loses the TV's vendor query race (details in the
  bridge docstring). The shim mechanism is vendor-agnostic (target comes from
  `$CEC_SHIM_VENDOR_ID`); the bridge compiles and LD_PRELOADs it into
  cec-client per the `cec.vendorShim` config key (`"auto"` default = LG TVs
  only - the only tested brand; `"tv"`/hex/`false` for experiments) - non-LG
  TVs run stock libcec, don't make the shim unconditional. If keys are dead
  right after first setup on an LG, the TV cached the wrong identity: toggle
  SIMPLINK off/on on the TV once.
- **Kernel 6.14-6.18 + a forced HDMI connector kills CEC** on the Pi 5: with
  `video=HDMI-A-1:e` on the cmdline the vc4 driver never feeds the EDID
  physical address to the CEC core (phys addr stays `f.f.f.f`, nothing
  transmits; fixed in mainline 6.19 by `cf207ea2c39d`). Diagnose with
  `cec-ctl -d0` (look at "Physical Address"). This is `video=...:e` ONLY -
  **`vc4.force_hotplug=1` is safe and provision/the image now set it**, verified
  on an LG set (CEC keeps a real physical address with it on). Don't confuse the
  two: the LG key-forwarding breakage on 6.18 was the vendor-query race (hence
  the shim, now libcec 8 `--vendor-id`), NOT the hotplug setting.
- **A session with ZERO outputs busy-loops**, so the box must always have one.
  Measured on a Pi 5 with labwc, and the shape is the compositor's frame clock
  rather than any one implementation: a session that _starts_ with no sink - a box
  plugged in while the TV is off - burned ~65% of a core in the compositor alone
  and ~200% once Electron joined (its main thread does ~35k Wayland roundtrips/s:
  `recvmsg`/`sendmsg`/`ppoll` in a tight loop). Losing the output later is
  harmless and recovery when the TV returns is clean, so the fix is
  `vc4.force_hotplug=1` on the cmdline - vc4 then ignores HPD and an output always
  exists.
- **The Pi renders and displays on DIFFERENT DRM devices, and that breaks GL for
  sandboxed apps.** vc4 drives HDMI with no render node at all; v3d renders. (Node
  numbers are the kernel's business - `card1` and `renderD128` on the dev box; the
  compositor finds the v3d one itself, so don't hardcode either.) A compositor that
  advertises the device it opened for KMS - the vc4 one - as the linux-dmabuf
  **main device** leaves a client whose Mesa learns the device only that way with
  no render node to open: no driver, zink refused (v3dv has no `nullDescriptor`),
  **llvmpipe**. That is every flatpak app on a current runtime, because Mesa >=
  25.1 dropped the `wl_drm` path the host's own Mesa still uses - which is why mpv
  and Chromium were always fine and RetroArch's GL cores ran on the CPU while its
  Vulkan path was perfect (Vulkan enumerates `/dev/dri` itself and never asks the
  compositor). tvbox-wc names the render node in its dmabuf feedback, which is what
  the whole class of bug turns on. Diagnose from inside the sandbox:
  `flatpak run --command=python3 <app>` + an EGL probe, or just
  `EGL_PLATFORM=surfaceless` - if surfaceless says V3D and wayland says llvmpipe,
  this is it.
- The Pi 5 has **no H.264 hardware decode** - mpv runs `--vo=gpu` with
  software decode; don't add hwdec flags blindly. It kept the HEVC decoder,
  which is what all 4K content here is.
- **Two GPU passes do not fit at 4K, and one of them is the compositor's.**
  `--vo=gpu` renders every frame on the V3D; a compositing session has to make a
  second full 4K pass for as long as any window sits over the video, which is always
  (the app UI is a fullscreen transparent window above mpv). Together they miss
  vblank: **~17 dropped frames a second at 4K with the decoder idle at zero**,
  and it is not the app - our own near-static launcher costs the same 15/s as
  the Plex UI, so no app-side quiescing helps. `shell/videoout.js` removes OUR
  pass instead: for fullscreen hardware-decoded video **from 1440p up**
  (`ZERO_COPY_MIN_HEIGHT`) it switches mpv to
  **`dmabuf-wayland`** (decoded frame handed to the compositor untouched, 0
  drops, 4% of a core). `vo` is settable at runtime, so it lands in the same
  paused window as the display-mode switch, before the first frame. Two limits
  keep it narrow: that output shows **nothing** for a software-decoded stream
  (it fails at the hwupload), and it processes nothing, so it **tone-maps
  nothing** - HDR from 1440p up reaches the panel as raw PQ. Under that the GPU
  renderer keeps up (the output mode follows the content, so a 1080p film is
  composited at 1080p) and is kept for its tone mapping. Measured dead ends,
  don't retry:
  `gpu-next` presents a frozen first frame on v3dv (its drop counter reads 0,
  which is how it fools a naive measurement), `--gpu-api=vulkan` and
  `gpu-next --gpu-api=opengl` render nothing, and no timing knob
  (`video-sync`, `swapchain-depth`, decoder queue) moves the 17/s.
- **The compositor's pass is gone as well, and that is why the box has its own
  compositor.** Removing ours left the video smooth only while nothing sat over it -
  a fullscreen translucent UI still sent the whole output through the renderer, 67%
  of the V3D. [tvbox-wc](https://github.com/Andy1210/tvbox-wc) hands the layers to
  the display hardware instead: film on the vc4 primary plane, UI on an overlay,
  compositor at **0% GPU**, 0 dropped frames with the Plex UI open. Two things it
  does that a general compositor will not: every element is a scan-out candidate
  (Smithay never offers an overlay plane otherwise), and a client's dmabuf is
  imported straight into a KMS framebuffer rather than through gbm, which gets the
  per-plane handles wrong for P030 and fails the commit. The previous route was
  labwc + wlroots with eleven local patches; those are kept in
  `docs/upstream/patches/` because three of them are plain wlroots bugs, but
  nothing on the box applies them any more.
  One operational trap survives the change: `systemctl restart greetd` on a live
  session can lose to itself, because the previous compositor holds
  `/dev/dri/card1` for a second or two, each attempt exits at once, and systemd's
  start limit trips after five - leaving greetd `failed` with no session at all.
  Stop greetd, kill the leftovers, wait, then start it once.
- **mpv is a Wayland client in both modes**, fullscreen and PiP, sitting behind
  the transparent shell window. PiP used to need XWayland - a Wayland client
  cannot place itself - and the compositor does the placing now
  (`compositor.placeWindow`, set BEFORE mpv starts so the window is never
  fullscreen for a frame first). The `raiseWindow` retry loop after launch is
  load-bearing (mpv steals focus late).
- `~/.tvbox/apps/` user manifests: built-in ids win on clash; a manifest-only
  app is sandboxed/capability-scoped, but a user-app `plugin.js` is trusted
  Node code in the host process - that trust split is by design (SECURITY.md).
- Raspberry Pi OS ships its own `010_pi-nopasswd` passwordless-sudo drop-in on
  some images; tvbox does **not** rely on it (provision is the only root step),
  so don't write code that assumes passwordless sudo at runtime. tvbox _does_
  optionally grant it, but only as an opt-in power-user affordance gated on
  `SUDO=true` in the boot-partition `tvbox.conf` (our own `/etc/sudoers.d/010-tvbox`,
  written by `tvbox-firstboot` on flashed boxes and `provision.sh` on dev
  deploys; toggles both ways; the legacy empty `tvbox-sudo` marker also still
  works). It's for a human on the SSH shell - runtime code must still never call
  sudo.
- **Plex's stream quality is decided by TWO things, and the second one is the
  server's.** The client reports the panel resolution (the Plex bridge overrides
  `window.screen` from `display.panelResolution()`, which is why it says 4K while
  the UI runs at 1080p) - that part works. But the SERVER also classifies the
  session as local or remote from the source IP, and a client that reaches it
  through the public `plex.direct` address arrives from the ROUTER's IP: hairpin
  NAT, `location=wan`, and the remote quality cap (12 Mbps) turns a 4K HDR film
  into a 1080p transcode. Which path the client picks varies per start, which is
  what made this look like a race in our own code. Fix is one server setting:
  Settings -> Network -> **LAN Networks = `192.168.1.0/24`** (`LanNetworksBandwidth`
  over the API), which is right for what was MEASURED here - the request arrived
  from `192.168.1.1`, the router's LAN address, and that subnet is now declared
  local. Not yet confirmed against a recurrence: the client has taken the LAN path
  on every start since. If a request ever shows up from the actual public IP,
  `LAN Networks` cannot cover it and the setting to reach for is
  **Treat WAN IP As LAN Bandwidth**. Diagnose from the
  PMS log with the token: `curl "$PMS/diagnostics/logs?X-Plex-Token=..."` and look
  for `location=` and `Reached Decision` next to the box's IP - "App cannot direct
  play this item" is the client's own profile refusing, not the server's.
- **An extracted bundle is a COPY, and its flatpak moves on its own.** Plex's web
  UI is extracted out of `tv.plex.PlexHTPC` into `apps-data/plex`, while the nightly
  `tvbox-flatpak-update.timer` updates the flatpak underneath it - so the copy
  silently stayed at the version it was extracted at (a stale client talking to a
  moved-on server) until someone reinstalled by hand. `install.js` records what a
  bundle came from in `apps-data/.sources/<id>.json` (ref + arch + **commit**, since
  a rebuild can keep the version string) and `bundleStale()` compares it;
  `main.js`'s `bundleRefreshTick` re-extracts out of process when idle, and the
  store's manual flatpak update does it inline. The boot pass passes
  `keepStale: true` on purpose - acquiring anything there would block the Electron
  main process. A bundle with NO record reads as stale once, so a box that predates
  this levels up on its own.
- **Two shells at once silently wipe the launcher's memory.** Electron's second
  instance loses the race for Chromium's storage lock and falls back to an
  **in-memory** localStorage: the launcher then reads no setup flag on a fully
  configured box, offers onboarding, and cannot save the answer either - so the box
  asks again at every start, and nothing logs an error. Guarded on both sides:
  `deploy/run-shell.sh` waits for a predecessor **before** it counts an OTA boot
  attempt (a fast exit would otherwise spend the 3 attempts a release gets and roll
  a good update back), and `main.js` claims `requestSingleInstanceLock()` - waiting
  up to 20s, since the overlap is normally a predecessor still shutting down - then
  exits 79. Onboarding state also lives in `config.json` (`setup.done`, exposed in
  `publicConfig`), so a storage hiccup cannot resurrect the wizard. A session killed
  out from under the shell (two compositors for a while) is how this shows up.
- `deploy.sh` requires an explicit `<pi-ssh-host>` - never hardcode a host.
- A deployed box is usually someone's actual living-room TV: restarting the
  shell or `mpv` interrupts whatever is playing. Check `pgrep -x mpv` (or ask)
  before disruptive ops on a box that might be in use.
- **OTA vs dev deploy:** an OTA release runs from `~/.tvbox/current/shell`
  (symlink into `versions/`), NOT `~/.tvbox/shell`. `deploy.sh` deletes the
  symlink so a dev deploy always wins - if a box seems to ignore your deploy,
  look for a stray `current` symlink. Update state: `~/.tvbox/update/*`
  (pending/attempts/failed/last). Full design: docs/updates-and-backup.md.
- **`deploy/run-shell.sh` IS the rollback mechanism** (boot-attempt counting +
  symlink flip-back). Keep it dependency-free POSIX sh; a release's infra
  files (incl. run-shell.sh itself) are only installed AFTER the new shell's
  first healthy boot (updater.js `onLauncherLoaded`), never before.
- **`deploy/infra.list` is the ONE list of shipped infra files.** It used to be
  hand-copied in five places (deploy.sh, make-release.sh, build-image.sh,
  image.yml, updater.js) which silently drifted - the v1.1.0 BT-remote bridge
  reached only dev deploys, not OTA/image. Now the copiers all read `infra.list`
  via `scripts/copy-infra.sh`, and `updater.test.js` fails the build if
  `INFRA_FILES` drifts from it. Never re-hardcode an infra path in a channel.
- **Electron is pinned at 43** (`shell/package.json`). The `console-message`
  webContents event uses the ≥37 `(event, details)` shape (details.level is a
  string) - see `shell/main.js`. Don't revert to the old positional `(e, level,
message, line, src)` signature.
- **Resolution is ADAPTIVE, there is no manual picker.** The UI sits at the
  panel's own resolution capped to **1080p**; video claims a mode that suits the
  content (refresh first - a 23.976 film on 60 Hz judders with nothing dropped -
  then the smallest resolution that covers it, 720p floor) and releases it after.
  Pure selection logic + its tests: `shell/display.js` / `display.test.js`.
  Arbitration (one claim, foreground-only, newest wins, rate limit, "won't stick"
  budget): `shell/displaymode.js` / `displaymode.test.js`. mpv starts **paused** so
  the switch happens before the first frame; apps that play video themselves use
  the `display` capability. Don't reintroduce a saved-mode setting - a stored mode
  and a live claim fight each other on every hotplug.
- **The compositor's control socket backs all of that**, over
  `$XDG_RUNTIME_DIR/tvbox-wc.sock` - one JSON object per line, the same framing mpv
  uses. `shell/compositor.js` is the client and `shell/display.js` the selection
  logic above it. Refresh is **mHz on the wire and Hz in display.js**, and the mode
  key rounds on purpose, so 23.976 and 24 collide there and are told apart by
  `refreshExact`; the pair is not interchangeable for a film. Protocol:
  [tvbox-wc docs/ipc.md](https://github.com/Andy1210/tvbox-wc/blob/main/docs/ipc.md).
- **OTA can NEVER install apt packages** (user-space by design, root lives only
  in provision/image). A release that adds a new system-package dependency
  reaches OTA-only boxes as code WITHOUT its dependency and there is no SSH on
  an end-user box to fix it - exactly how 1.2.0's resolution picker stayed
  empty on OTA-updated boxes (its `wlr-randr` never arrived). When a feature needs
  a new binary: either make it degrade with a clear on-TV message AND accept it
  only works on freshly flashed/provisioned boxes, or ship the binary
  Kodi-style like librespot (sha256-pinned no-root download into
  `~/.tvbox/bin`, see `requires.download` / `installDownload`). Flag the
  decision in the release notes.
- Nothing on the box ever reboots it or restarts the shell on its own while
  something plays: OS updates run with `Automatic-Reboot "false"` (Settings
  shows the reboot hint), and the OTA auto-apply is gated on `boxIdle()` +
  the 03-06h window.
- **Never write the boot partition in place, and know that `cmdline.txt` is
  rewritten at EVERY boot.** On FAT the new cluster chain is allocated before the
  directory entry is flushed (and a rename can reach the disk before the data it
  points at), so a box cut off in between boots with a ZERO-BYTE file and its old
  contents orphaned into a `FSCK*.REC`. Found on a real box: it was booting on the
  firmware's fallback command line - no `root=PARTUUID`, no regdom, no
  `vc4.force_hotplug=1` - and nothing on a running system reports that.
  The per-boot writer is ours by proxy: `tvbox-wifi-country` calls
  `raspi-config nonint do_wifi_country`, which rewrites `/boot/firmware/cmdline.txt`
  with an **unconditional `sed -i`** (strip the regdom, append it again) whether or
  not it changes. That unit now has `ExecStartPost=-/bin/sync` so the window is
  milliseconds instead of the writeback delay; skipping the call when the country is
  already correct would remove the write altogether and is the obvious follow-up.
  For our own writes: temp file on the same filesystem, `sync`, then `mv`
  (`write_cmdline` in provision.sh, same shape in tvbox-diag.sh). The diagnostics
  report flags an empty cmdline and any `.REC`, and provision.sh restores from
  `cmdline.txt.bak-tvbox`.
- **Diagnostics and safe mode are ROOT, so OTA cannot update them.** The active
  copies live in `/usr/local/sbin` + `/etc/systemd/system`; an OTA release only
  refreshes the copies in `~/.tvbox/`, and `provision.sh` is what installs them.
  Deliberate: a root unit must never exec a file out of the box user's home, or a
  user-app `plugin.js` (trusted Node in the host process, but as the box user)
  would get root at the next boot. Same "OTA-only boxes keep what they were
  provisioned with" caveat as apt packages - flag it in release notes.
- **An app's id prefix is not a boundary on its own.** A manifest id is only
  constrained to `[a-z0-9_-]`, so "the file must start with the app id" would let a
  manifest calling itself `config` claim `~/.tvbox/config.json` - the box's
  credentials and parental PIN hash. `backup.state` therefore needs BOTH gates:
  `<id>-` prefix AND `RESERVED_STATE_FILES` in [install.js](shell/install.js), which
  `install.test.js` cross-checks against backup.js's `EXTRA_FILES`. Any future
  feature that lets a manifest name a shell-owned path needs the same pair.
- **A backup payload is untrusted until its password verifies, and even then it may
  come from a different box.** Everything restored from one is re-derived on THIS
  box: an app's file roots come from the local manifest (never the payload), paths
  must resolve STRICTLY inside them (`saves/..` resolves to the root itself - that
  is why the guard is a `startsWith(root + sep)` and not `!== root`), `appdata` goes
  through the same id/size/key guards as a live write, and identity fields are
  re-derived rather than copied. Restored files are `0600`.
- **Unit tests here agree with each other, not with reality.** Every bug found in the
  restore path sat in an integration seam: `bundleStale` was right, the store was
  right, HOME was right, and their sum was a dead end. The modules' own tests inject
  fakes, and the fakes agreed while the real modules did not.
  [shell/integration.test.js](shell/integration.test.js) is the answer - whole
  scenarios ("a re-flashed box restores and comes back whole") through the real
  modules, a real filesystem and a real HTTP registry. Two things shape it: every
  module resolves `os.homedir()` at IMPORT time, so one process is one box and a
  two-box scenario runs each as a child process; and `inBox` MUST stay async,
  because the registry serves from the test's own event loop and an
  `execFileSync` would deadlock it. It deliberately stops short of main.js's
  wiring (routes, timers, publish-on-event) - that needs Electron under Xvfb, and a
  flaky job is worse than an absent one. When you add a scenario, break the fix it
  covers and check it actually fails.
- **The image smoke test does not run the Pi's kernel.** `scripts/image-smoke.sh`
  boots the image's **userspace** (systemd-nspawn + arm64 binfmt), which catches a
  rootfs that cannot come up, a missing payload, and a too-small filesystem - not a
  kernel that panics on real hardware. QEMU's `raspi` machines were considered and
  rejected as too flaky to gate a build on. Two traps if you touch it: nspawn mounts
  a tmpfs over `/run` AND `/tmp`, so results go to `/var/tmp` (plus a console copy as
  a fallback), and `--self-test` is all the coverage the checks get on an ordinary
  push - in CI, phase 2 runs only during an image build (locally it runs on any
  image, unless `SKIP_BOOT=1`).
