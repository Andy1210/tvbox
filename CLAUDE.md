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

```
TV remote     ─HDMI-CEC→ cec_uinput_bridge.py    (systemd USER unit tvbox-cec)     ─┐ uinput
BT/USB remote ─evdev───→ remote_input_bridge.py  (systemd USER unit tvbox-remote) ─┘ key events
   both write /dev/uinput via the udev grant + `input` group - NO root. tvbox-cec        │
   forwards CEC keys (+ TV power); tvbox-remote EVIOCGRABs each remote and re-emits its   │
   keys, applying a PER-DEVICE button remap (unmapped buttons pass straight through).     ▼
labwc session (autologin) ── respawn loop ── run-shell.sh ── Electron shell (shell/)
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

| Path                                                                                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [shell/main.js](shell/main.js)                                                             | Electron host: HTTP+API, windows, mpv, plugin loader, MQTT glue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [shell/install.js](shell/install.js)                                                       | Manifest loading/**validation** + bundle install runner. Shared by shell + CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [shell/cli.js](shell/cli.js)                                                               | `tvbox list/deps/install/remove/update/backup/restore` (symlinked at `~/.local/bin/tvbox`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [shell/updater.js](shell/updater.js)                                                       | OTA self-update: feed check, versions/ install, `current` symlink flip. Rollback lives in [deploy/run-shell.sh](deploy/run-shell.sh).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [shell/backup.js](shell/backup.js)                                                         | Encrypted settings backup/restore (phone page: [shell/pairing/backup.js](shell/pairing/backup.js)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [app-sdk/](app-sdk/)                                                                       | `@tvbox/app-sdk` - the shared 10-foot UI SDK (spatial-nav focus components, OSK, PIN pad, i18n, config/capability clients). The launcher AND every app package consume it as source via the `@sdk` Vite alias.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `~/.tvbox/apps/<id>/`                                                                      | Where installed app PACKAGES live (manifest.json + plugin.js + web/), fetched from the [tvbox-apps registry](https://github.com/Andy1210/tvbox-apps). No in-shell first-party slot - the shell ships only the SDK. Schema: [docs/app-manifest.schema.json](docs/app-manifest.schema.json).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [shell/appfetch.js](shell/appfetch.js) + [shell/appdata.js](shell/appdata.js)              | Capability brokers: `fetch` (origin-locked SSRF-guarded data proxy) + `storage` (per-app kv). See [docs/capabilities.md](docs/capabilities.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [shell/netguard.js](shell/netguard.js)                                                     | **Single** network-trust classifier (loopback/RFC1918/link-local/metadata/IPv4-mapped-IPv6). `appfetch`'s SSRF logic is the reference; `updater`/`main`/`install`/`pairing` all import from here so the guards can't drift apart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [shell/preload-app.js](shell/preload-app.js)                                               | Sandbox-safe contextBridge preload for **capability apps** in the isolated window (vs [shell/preload.js](shell/preload.js) for the main/Node-capable window).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [tvbox-apps AUTHORING.md](https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md)   | How to write an app package (layout, manifest, web/ UI via `@tvbox/app-sdk`, host plugin, deps + platform baseline). The launcher no longer compiles in any app view.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [launcher/src/lib/i18n.tsx](launcher/src/lib/i18n.tsx) + [locales/](launcher/src/locales/) | i18n; en+hu key parity is test-enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [deploy/deploy.sh](deploy/deploy.sh)                                                       | Build + rsync + provision + user-space setup. Idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [deploy/provision.sh](deploy/provision.sh)                                                 | **The ONE root step** (apt baseline, udev/polkit, linger, legacy migration).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [deploy/infra.list](deploy/infra.list) + [scripts/copy-infra.sh](scripts/copy-infra.sh)    | **Single source of truth** for every non-`shell/` file that must ship. All four channels (dev deploy, OTA tarball, SD image, CI) copy from it; `shell/updater.js`'s `INFRA_FILES` allowlist is cross-checked against it by `shell/updater.test.js`. Add a file here → it ships everywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [cec/cec_uinput_bridge.py](cec/cec_uinput_bridge.py)                                       | CEC→uinput bridge (user service). LG quirks documented in its docstring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [remote/remote_input_bridge.py](remote/remote_input_bridge.py)                             | BT/USB remote → uinput bridge (user service `tvbox-remote`): EVIOCGRAB + per-device button remap, learn mode over a FIFO. Special remap actions emit no key: `power` = CEC TV toggle (`toggle 0` FIFO), `settings`/`appswitcher` = shell `/tvbox/api/nav`. Fire TV **app buttons** (vendor HID, no evdev key) are read from the remote's **hidraw** node (reports 0xEF vendor + 0x02 consumer; provision grants Amazon-VID hidraw) and injected as virtual keycodes (0x300/0x400 + report byte, ANY button, nothing hardcoded; report 0x01 mirrors normal keys and stays ignored) into the same remap path. **Panic reset:** same remapped raw button ×8 rapid (repeat-prone actions exempt) → `/tvbox/api/remote/reset`. Keymap in `config.remote.devices`; UI (button-test + reset + reassign-confirm) is Settings → Peripherals ([launcher/src/components/RemoteRemap.tsx](launcher/src/components/RemoteRemap.tsx)). |
| [shell/ir.js](shell/ir.js)                                                                 | IR blaster hub: TV volume/mute for CEC-volume-less TVs, pluggable backends (`esphome` native API - XIAO Smart IR Mate; `homeassistant` scripts - Broadlink et al). Fed by the remote bridge's volume keys + MQTT `volume_*`/`mute`. Recipes: [docs/ir-blaster.md](docs/ir-blaster.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [shell/appwindows.js](shell/appwindows.js)                                                 | Background-apps window registry + hidden-set policy (mute/pause on hide, RAM-scaled LRU caps). Per-window app identity (`windowAppId`), foreground orchestration + `switchApp` live in main.js. `config.apps.background=false` = old destroy-on-leave. [docs/background-apps.md](docs/background-apps.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [shell/firetvir.js](shell/firetvir.js)                                                     | Fire TV remote IR programming (Settings → Peripherals): venv+bleak deps install, irdb codeset fetch/cache (github.com/probonopd/irdb), test/program via `remote/firetv_remote_ir.py`. Protocol encoders: [remote/ir_protocols.py](remote/ir_protocols.py); keymap bytes: [remote/keymap_compile.py](remote/keymap_compile.py). [docs/firetv-remote-ir.md](docs/firetv-remote-ir.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [docs/app-manifest.md](docs/app-manifest.md)                                               | How to write an app (the extension story).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [docs/sd-image.md](docs/sd-image.md)                                                       | pi-gen flashable-image recipe (workflow: .github/workflows/image.yml).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [docs/updates-and-backup.md](docs/updates-and-backup.md)                                   | OTA + OS updates (never auto-reboot) + phone backup. Release: [scripts/make-release.sh](scripts/make-release.sh) / release.yml.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

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
   the hardened separate window. Don't move apps between these worlds. Brokered
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
   apps - prefer `requires.download`. Spotify Connect is also opt-in at
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
  A screenshot of the running UI: `grim ~/shot.png` in the Wayland session
  (`XDG_RUNTIME_DIR=/run/user/$(id -u) WAYLAND_DISPLAY=wayland-0`).
- Lockfiles are committed (shell's was generated with
  `npm i --package-lock-only`; a full `npm install` in shell/ downloads the
  ~100MB ARM64 Electron - avoid on the dev host).

## Sharp edges

- **Two independent uinput bridges feed input**, both user services: `tvbox-cec`
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
  transmits; fixed in mainline 6.19 by `cf207ea2c39d`). If a box needs a
  forced output (boot with TV off), use `vc4.force_hotplug=1` instead - it
  keeps the normal detect/EDID/CEC path. Diagnose with
  `cec-ctl -d0` (look at "Physical Address").
- The Pi 5 has **no H.264 hardware decode** - mpv runs `--vo=gpu` with
  software decode; don't add hwdec flags blindly.
- mpv PiP runs under **XWayland** (`DISPLAY`, no `WAYLAND_DISPLAY`) because
  Wayland clients can't self-position; fullscreen mpv is a Wayland client
  behind the transparent window. The `raiseWindow` retry loop after launch is
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
- **`wlr-randr` (not `wlrctl`) backs the resolution picker.** `shell/display.js`
  shells out to `wlr-randr`; it must be in the apt lists (provision.sh HARD +
  image 00-packages). Missing it = an empty resolution list, silently.
- **OTA can NEVER install apt packages** (user-space by design, root lives only
  in provision/image). A release that adds a new system-package dependency
  reaches OTA-only boxes as code WITHOUT its dependency and there is no SSH on
  an end-user box to fix it - exactly how 1.2.0's resolution picker stayed
  empty on OTA-updated boxes (`wlr-randr` never arrived). When a feature needs
  a new binary: either make it degrade with a clear on-TV message AND accept it
  only works on freshly flashed/provisioned boxes, or ship the binary
  Kodi-style like librespot (sha256-pinned no-root download into
  `~/.tvbox/bin`, see `requires.download` / `installDownload`). Flag the
  decision in the release notes.
- Nothing on the box ever reboots it or restarts the shell on its own while
  something plays: OS updates run with `Automatic-Reboot "false"` (Settings
  shows the reboot hint), and the OTA auto-apply is gated on `boxIdle()` +
  the 03-06h window.
