#!/usr/bin/env bash
# tvbox deploy - set up the TV box on a (fresh or existing) Raspberry Pi 5.
#
#   ./deploy.sh <pi-ssh-host>        # e.g. ./deploy.sh pi@raspberrypi.local
#
# Idempotent. Builds the React launcher, syncs everything to the Pi, runs the
# ONE root step (provision.sh - apt baseline, udev/polkit device access; you
# may be prompted for the sudo password once), then finishes user-space: npm
# install, the CEC bridge as a systemd USER service, the `tvbox` CLI in
# ~/.local/bin, and a labwc session autostart so the Pi boots straight into
# the tvbox shell (no desktop panel / Kodi). Nothing runs as root after
# provision. Apps are opt-in - see the README ("Enabling apps").
set -euo pipefail
PI="${1:-}"
SKIP_PROVISION=0
[ "${2:-}" = "--skip-provision" ] && SKIP_PROVISION=1
if [ -z "$PI" ]; then
  echo "usage: ./deploy.sh <pi-ssh-host> [--skip-provision]    e.g. ./deploy.sh pi@raspberrypi.local" >&2
  echo "  --skip-provision: skip the root step (fine on an already-provisioned box)" >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"   # tvbox/deploy
TVBOX="$(dirname "$HERE")"              # tvbox/

echo "==> building launcher (React/Vite) -> shell/launcher-dist"
# Quiet stdout, but let stderr THROUGH: a broken build must be diagnosable, not
# a bare "FAILED" with the compiler errors swallowed.
( cd "$TVBOX/launcher" && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null ) \
  || { echo "   launcher build FAILED (see the errors above) - fix it before deploying"; exit 1; }

echo "==> syncing tvbox/shell -> $PI:~/.tvbox/shell"
ssh "$PI" 'mkdir -p ~/.tvbox'
# launcher-dist IS shipped (built above); node_modules / generated data are not.
rsync -az --delete \
  --exclude node_modules --exclude '*.log' --exclude apps-data --exclude electron-web-client \
  "$TVBOX/shell" "$PI:.tvbox/"
# Infra files come from the ONE shared list (deploy/infra.list), so the dev
# deploy can never drift from the OTA tarball / SD image (they read it too, via
# scripts/copy-infra.sh). Basenames land flat in ~/.tvbox/, same as before.
# Fail-closed: a listed-but-missing file makes rsync (under set -e) abort.
INFRA_SRCS=()
while IFS= read -r line; do
  line="${line%$'\r'}"
  case "$line" in
    ''|'#'*) continue ;;
  esac
  INFRA_SRCS+=("$TVBOX/$line")
done < "$TVBOX/deploy/infra.list"
rsync -az "${INFRA_SRCS[@]}" "$PI:.tvbox/"

# ---- the ONE root step: provision (apt baseline, udev/polkit, groups) ----
# ssh -t gives sudo a TTY so it can prompt for the password; on a box with
# passwordless sudo it just runs. Everything after this is user-space.
if [ "$SKIP_PROVISION" = 1 ]; then
  echo "==> provision skipped (--skip-provision)"
else
  echo "==> provisioning (root, one-time; you may be asked for the sudo password)"
  ssh -t "$PI" 'sudo bash ~/.tvbox/provision.sh' \
    || { echo "   provision FAILED - fix and re-run deploy"; exit 1; }
fi

# ---- user-space setup (no root from here on) ----
ssh "$PI" 'bash -s' <<'REMOTE'
set -u
FAIL=0
ok()   { echo "   [ok]   $1"; }
warn() { echo "   [warn] $1"; }
bad()  { echo "   [FAIL] $1"; FAIL=1; }

echo "==> flatpak user remote (apps install on-demand from the UI; nothing preinstalled)"
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo 2>/dev/null \
  && ok "flathub (user) remote" || warn "flathub remote-add failed - UI app installs may not work"

echo "==> Electron (npm install)"
( cd ~/.tvbox/shell && npm install --no-audit --no-fund >/dev/null 2>&1 ) && ok "electron deps" || bad "npm install (shell) failed"
chmod +x ~/.tvbox/run-shell.sh ~/.tvbox/shell/audio-default.sh ~/.tvbox/tvbox 2>/dev/null || true

echo "==> dev deploy wins over OTA (drop the \`current\` symlink + update markers)"
# An OTA update flips ~/.tvbox/current at a release under versions/; while it
# exists, run-shell.sh ignores the dev tree we just rsync'd. A deploy is an
# explicit "run THIS code", so reset the OTA state (releases stay on disk -
# the next OTA update simply re-flips).
if [ -L ~/.tvbox/current ]; then
  rm -f ~/.tvbox/current ~/.tvbox/update/pending ~/.tvbox/update/attempts ~/.tvbox/update/failed
  ok "OTA release deactivated - the box runs the deployed dev tree again"
else
  rm -f ~/.tvbox/update/failed # stale OTA failure notices don't apply to a fresh dev tree
  ok "no OTA release active"
fi

echo "==> 'tvbox' app CLI on PATH (~/.local/bin - no root)"
mkdir -p ~/.local/bin
ln -sf ~/.tvbox/tvbox ~/.local/bin/tvbox && ok "tvbox CLI" || warn "tvbox symlink failed (ln -sf ~/.tvbox/tvbox ~/.local/bin/tvbox)"

echo "==> nightly user-flatpak update timer (app bundles track flathub)"
mkdir -p ~/.config/systemd/user
cp ~/.tvbox/tvbox-flatpak-update.service ~/.tvbox/tvbox-flatpak-update.timer ~/.config/systemd/user/
if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now tvbox-flatpak-update.timer >/dev/null 2>&1; then
  ok "flatpak update timer (03:30 + jitter)"
else
  warn "flatpak update timer not enabled (fine after reboot: systemctl --user enable --now tvbox-flatpak-update.timer)"
fi

echo "==> CEC bridge (systemd user service - runs as you, not root)"
mkdir -p ~/.config/systemd/user
cp ~/.tvbox/tvbox-cec.service ~/.config/systemd/user/tvbox-cec.service
if systemctl --user daemon-reload 2>/dev/null \
   && systemctl --user enable tvbox-cec.service >/dev/null 2>&1 \
   && systemctl --user restart tvbox-cec.service 2>/dev/null; then
  ok "CEC user service"
else
  # First install: /dev/uinput group access lands after the reboot; the unit
  # is enabled and will come up clean then.
  warn "CEC user service not running yet (fresh group grant? fine after reboot)"
fi

echo "==> remote input bridge (systemd user service - per-device button remap)"
cp ~/.tvbox/tvbox-remote.service ~/.config/systemd/user/tvbox-remote.service
if systemctl --user daemon-reload 2>/dev/null \
   && systemctl --user enable tvbox-remote.service >/dev/null 2>&1 \
   && systemctl --user restart tvbox-remote.service 2>/dev/null; then
  ok "remote input bridge"
else
  warn "remote input bridge not running yet (fresh group grant? fine after reboot)"
fi

echo "==> session autostart (tvbox shell; no panel / Kodi)"
mkdir -p ~/.config/labwc
if [ -f ~/.config/labwc/autostart ] && [ ! -f ~/.config/labwc/autostart.pre-tvbox ]; then
  cp ~/.config/labwc/autostart ~/.config/labwc/autostart.pre-tvbox
fi
cp ~/.tvbox/labwc-autostart ~/.config/labwc/autostart && chmod +x ~/.config/labwc/autostart && ok "session autostart" || bad "autostart install failed"

echo
if [ "$FAIL" = 0 ]; then
  echo "==> tvbox deployed OK. Reboot to boot into the shell:  sudo reboot"
  echo "    Apps come from the curated registry and show up as tiles. Install them from"
  echo "    the on-box Store (Settings -> Apps), or from an SSH shell:"
  echo "      tvbox list                 # what the registry offers + install state"
  echo "      tvbox install <id>         # add an app (e.g. livetv, spotify, plex, jellyfin)"
  echo "      tvbox deps <id>            # fetch its binary dep (mpv / librespot), no root"
else
  echo "==> tvbox deploy FAILED on one or more hard steps (see [FAIL] above) - fix and re-run."
fi
exit $FAIL
REMOTE
echo "==> done."
