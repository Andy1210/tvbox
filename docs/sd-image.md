# Building a flashable SD-card image

The end goal: **flash → boot → TV shows the launcher** - no dev machine, no
SSH, no deploy script. This is the LibreELEC/RetroPie-style install story and
the biggest usability win for non-developer users. The pi-gen stage **lives in
the repo at [`image/`](../image/)**; the CI automation is
[`.github/workflows/image.yml`](../.github/workflows/image.yml) (runs on
release publish or manually via _Run workflow_). This doc explains the layout
and the gotchas.

## How it works: pi-gen

[pi-gen](https://github.com/RPi-Distro/pi-gen) is the tool Raspberry Pi OS
itself is built with. It runs a sequence of **stages** (stage0 = bootstrap,
stage1 = minimal system, stage2 = lite image, …) in an arm64 chroot (qemu
binfmt on an x86 host, native on an ARM host/runner). We build:

```
stage0 → stage1 → stage2 (Raspberry Pi OS Lite)
                → stage-tvbox (our custom stage)
```

We intentionally build on top of **Lite + our own Wayland session** rather
than the full desktop image: the box needs labwc + the shell, not a desktop.

## The custom stage (`image/stage-tvbox/`)

A pi-gen stage is a directory of numbered sub-steps. The stage is committed -
this is what's where:

```
image/
  config                      # pi-gen config for LOCAL builds (CI passes the
                              # same values as pi-gen-action inputs)
  stage-tvbox/
    EXPORT_IMAGE              # marks this stage as the one pi-gen exports
    prerun.sh                 # standard pi-gen boilerplate (copy prev stage rootfs)
    00-packages/
      00-packages             # apt baseline (provision.sh's list + labwc/seatd/
                              # greetd session + unattended-upgrades)
    01-tvbox/
      00-run.sh               # the install script (mirrors deploy.sh+provision.sh)
      conf/                   # committed system config - KEEP IN SYNC with the
                              # heredocs in deploy/provision.sh:
                              #   99-tvbox.rules  50-tvbox-networkmanager.rules
                              #   20auto-upgrades 52tvbox-unattended-upgrades
      files/                  # NOT committed - populated by the workflow (or you):
        shell/                #   rsync of shell/ WITH launcher-dist already built
        cec_uinput_bridge.py run-shell.sh labwc-autostart tvbox
        tvbox-cec.service tvbox-flatpak-update.{service,timer} provision.sh
```

`01-tvbox/00-run.sh` - what it must do (each step mirrors what
`deploy.sh`/`provision.sh` do over SSH, but into the chroot; `${ROOTFS_DIR}`
and `${FIRST_USER_NAME}` are provided by pi-gen). The committed
[`00-run.sh`](../image/stage-tvbox/01-tvbox/00-run.sh) does, in order:

1. copies the tvbox tree into `~/.tvbox` (shell already contains
   `launcher-dist`, built host-side - arch-independent);
2. installs the `conf/` system config: udev uinput/cec rules, the polkit
   NetworkManager grant, and unattended-upgrades (install-yes/reboot-never);
3. writes the **greetd autologin** config (labwc session on vt7, kiosk - the
   account password can stay locked, autologin doesn't need one);
4. creates the **linger flag file** for the user;
5. in the chroot: group membership, `chown` of the tree, **`npm install`
   INSIDE the arm64 chroot** (host-side would fetch the x86 Electron), the
   `tvbox` CLI symlink, user units "enabled" via hand-made
   `*.target.wants` symlinks (CEC bridge + nightly flatpak-update timer),
   labwc session autostart, the flathub user remote, `systemctl enable
greetd` + `set-default graphical.target`.

## `image/config` (pi-gen's own config, local builds)

The committed [`image/config`](../image/config) mirrors what CI passes as
action inputs: `RELEASE=trixie`, `ARM64=1`, `FIRST_USER_NAME=tv`,
`DISABLE_FIRST_BOOT_USER_RENAME=1`, `ENABLE_SSH=1`, xz compression.

Notes:

- **User/password + SSH access**: the image ships the fixed `tv` user with a
  **locked password** - no first-boot wizard (it would need a keyboard), greetd
  autologin works without one. Password login is impossible, but **SSH key auth
  still works** on a locked account, so to get in you preseed a key (see
  _Headless provisioning_ below) - no need to unlock or set a password.
  Mechanics: pi-gen refuses `DISABLE_FIRST_BOOT_USER_RENAME` without a
  `FIRST_USER_PASS`, so `image/config` feeds it a random throwaway and
  `00-run.sh` locks the account (`passwd -l`) in the same build.
- **Headless provisioning (SSH key + WiFi), no `custom.toml`**: because this
  image can't process `custom.toml` (below), first-boot config is done with our
  own step (`tvbox-firstboot`, a systemd oneshot) that reads plain files off the
  **bootfs** (FAT) partition - editable on any OS, no tooling. Drop either/both
  after flashing:
  - `authorized_keys` - your SSH **public** key(s). Installed to
    `~tv/.ssh/authorized_keys`; then `ssh tv@<box-ip>` works (key auth, locked
    password is fine). This is how you get a shell on the box.
  - `tvbox-wifi.conf` - for an **ethernet-less** box that should come online by
    itself instead of being set up from the TV:

    ```sh
    SSID="YourNetwork"
    PSK="your-wifi-password"   # omit for an open network
    ```

    It becomes a NetworkManager connection (`tvbox-preseed`) that auto-connects.
    Both are applied every boot (idempotent); the files may stay on the card (the
    key is public; the WiFi PSK is plaintext on the FAT partition - the usual
    headless-preseed trade-off). Without `tvbox-wifi.conf`, set WiFi up from the
    TV (Settings → Network) - that path works out of the box now too.
- **WiFi**: set up **from the TV** once booted (Settings → Network) - the image
  brings the radio up (NetworkManager ships it off) and sets the WiFi country
  (HU) so it scans out of the box. Or preseed it (see _Headless provisioning_).
- **Ethernet**: works out of the box (DHCP, no config).
- **`custom.toml` / Raspberry Pi Imager customisation - NOT supported by this
  image.** Two separate dead ends:
  - Imager 2.0 **greys out "OS customisation" for custom images** (it only
    offers it for images from its own repo - [rpi-imager#1302](https://github.com/raspberrypi/rpi-imager/issues/1302),
    won't-fix);
  - dropping a **`custom.toml`** on the bootfs partition **also does nothing**
    here. That file is applied by Raspberry Pi OS's first-boot config hook, which
    this image intentionally doesn't wire up: the locked-kiosk `tv` user needs
    `DISABLE_FIRST_BOOT_USER_RENAME=1`, and with it pi-gen installs no first-run
    trigger to read `custom.toml`. Symptom (as reported from a real flash): the
    box still prompts for a WiFi country (rfkill) and your `[wlan]`/`[ssh]`/
    `[locale]` sections are ignored.

  Use the **Headless provisioning** files above (`authorized_keys` /
  `tvbox-wifi.conf`) instead - they're independent of Imager / `custom.toml`. An
  on-TV first-boot wizard (language → region/WiFi-country → timezone → keyboard)
  is still planned as the no-PC path.

- **First boot**: an **empty HOME** with a "Get more apps" tile - apps come from
  the [tvbox-apps registry](https://github.com/Andy1210/tvbox-apps), installed
  from the box (Kodi's model). Nothing is preinstalled.
  The image preinstalls only the **shared media stack** (`mpv` + audio libs
  `libpulse0`/`libasound2t64`) - kept in sync with `deploy/provision.sh`; each
  app installs its own binary (e.g. Spotify's `librespot`, a no-root
  `requires.download`) from the UI.
- **Keeping the image honest**: `01-tvbox/conf/` must stay in sync with the
  heredocs in [`deploy/provision.sh`](../deploy/provision.sh) - the SSH
  install path writes those, the image copies these.

## Building locally

Use the one-command wrapper - it does exactly what CI does (build launcher,
assemble `stage-tvbox/files/`, set up static-qemu arm64 binfmt, run pi-gen's
`build-docker.sh`) on any x86_64/arm64 Linux with Docker:

```sh
./scripts/build-image.sh            # -> .image-build/<image>.img.xz
./scripts/build-image.sh --fresh    # clean full rebuild (also the recovery path)
```

The first run does a full build (bootstraps Raspberry Pi OS Lite; ~30-60 min).
**Every run after that is incremental**: pi-gen reuses the prior container's
work volume (`CONTINUE=1`) and we drop a `SKIP` file in stage0/1/2, so only
`stage-tvbox` rebuilds - a few minutes plus the in-chroot Electron npm install.
All of tvbox's image content lives in `stage-tvbox`, and `build-docker.sh`
re-bakes the source every build, so an incremental run always reflects your
edits; `--fresh` if a rebuild ever looks stale. Needs Docker (usable without
sudo), sudo once for `qemu-user-static`, and ~25 GB free in the build dir.

Doing it by hand (what the script automates):

```sh
( cd launcher && npm ci && npm run build )
F=image/stage-tvbox/01-tvbox/files
mkdir -p "$F"
rsync -a --delete --exclude node_modules --exclude apps-data --exclude '*.log' shell "$F/"
cp cec/cec_uinput_bridge.py deploy/run-shell.sh deploy/labwc-autostart \
   deploy/tvbox deploy/tvbox-cec.service deploy/provision.sh \
   deploy/tvbox-flatpak-update.service deploy/tvbox-flatpak-update.timer "$F/"

git clone --branch arm64 https://github.com/RPi-Distro/pi-gen && cd pi-gen
cp -r ../image/stage-tvbox .
cp ../image/config config
touch stage2/SKIP_IMAGES            # only export the tvbox stage's image
./build-docker.sh                   # -> deploy/image_<date>-tvbox.img.xz
```

Flash with Raspberry Pi Imager ("Use custom image") or `dd`.

## CI (GitHub Actions)

[`image.yml`](../.github/workflows/image.yml) does the same on a release
publish (or manually via _Run workflow_): builds the launcher on the runner,
assembles `stage-tvbox/files/`, installs **static** qemu
(`qemu-user-static` + a `qemu-aarch64` symlink - build-docker.sh checks for
that binary, and only a static interpreter survives the F-flag binfmt trip
into the build container), then runs pi-gen's own `build-docker.sh` directly -
the community `usimd/pi-gen-action` wrapper is deliberately NOT used (as of
2026-07 all its releases have broken qemu handling on trixie, see
usimd/pi-gen-action#179, and its main branch ships no built `dist/`). All
build settings come from [`image/config`](../image/config), so CI and local
builds can't drift. The `.img.xz` lands as a workflow artifact and, on a
release event, as a release asset. Expect ~1-1.5 h of runner time per image;
that's normal for pi-gen in CI.

## Gotchas learned elsewhere (so you don't relearn them)

- **Electron must be `npm install`ed inside the arm64 chroot** - a host-side
  install would fetch the x86 binary. This is the slowest custom step
  (~200 MB); consider caching `~/.npm` between builds.
- **`systemctl` doesn't work in a chroot** - that's why the user unit is
  "enabled" via the `default.target.wants` symlink and lingering via the flag
  file, not `systemctl --user enable` / `loginctl enable-linger`.
- **Don't run `provision.sh` in the chroot** - it's written for a live system
  (udevadm, loginctl). The stage replicates its file-drops instead; keep them
  in sync when provision changes.
- pi-gen is picky about **host distro/Docker versions**; the Docker build path
  (`build-docker.sh`) is far more reproducible than the bare `build.sh`.
- **Black screen with only a cursor** almost always means labwc started but
  nothing launched the shell - and the classic causes on a Lite-based image are
  **desktop-only bits Lite doesn't ship**. The box user autostart used to call
  `/usr/bin/lwrespawn` (a Raspberry Pi _desktop-session_ helper, ABSENT on Lite);
  a fresh flash sat at a black screen because that line silently failed. Fixed by
  a self-contained POSIX respawn loop in [`deploy/labwc-autostart`](../deploy/labwc-autostart)
  (no external dependency). Likewise install a **system font** (`fonts-dejavu-core`,
  in `00-packages`): the launcher font stack ends in `sans-serif`, and with no
  font present Chromium renders the UI blank/black even when the shell IS running.
- Otherwise check `greetd`/labwc actually started (`journalctl -u greetd`), and
  that the user is in `video` (GPU access for the compositor).
