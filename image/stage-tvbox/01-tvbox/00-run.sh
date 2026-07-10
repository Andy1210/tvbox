#!/bin/bash -e
# stage-tvbox / 01-tvbox - put tvbox into the image. Mirrors what deploy.sh +
# provision.sh do over SSH, but into the pi-gen chroot (don't run provision.sh
# here - it's written for a live system: udevadm, loginctl, systemctl --now).
#
#   files/  is assembled by CI (.github/workflows/image.yml) or by hand for a
#           local build: shell/ WITH launcher-dist built + the deploy/ infra
#           files (run-shell.sh, tvbox CLI, CEC bridge, units, provision.sh).
#   conf/   committed system config - KEEP IN SYNC with deploy/provision.sh
#           (udev/polkit rules, unattended-upgrades: same content as its heredocs).
USER_HOME="/home/${FIRST_USER_NAME}"

# 1) the tvbox tree
install -d "${ROOTFS_DIR}${USER_HOME}/.tvbox"
cp -r files/shell "${ROOTFS_DIR}${USER_HOME}/.tvbox/"
# A fresh image starts with an EMPTY home - no apps installed. Apps are added
# from the registry via HOME -> "Get more apps" (the Kodi model).
install -m 755 files/run-shell.sh files/tvbox files/cec_uinput_bridge.py files/cursor_idle_hide.py \
  files/remote_input_bridge.py \
  "${ROOTFS_DIR}${USER_HOME}/.tvbox/"
# cec_vendor_shim.c is source the CEC bridge compiles on the box (LG SIMPLINK
# vendor identity - see the bridge docstring); tvbox-remote.service is the BT/USB
# remote bridge's user unit. Both come from deploy/infra.list now, so they ship
# on flashed boxes the same as on dev deploys / OTA.
install -m 644 files/labwc-autostart files/provision.sh files/tvbox-cec.service files/tvbox-remote.service \
  files/cec_vendor_shim.c \
  files/tvbox-flatpak-update.service files/tvbox-flatpak-update.timer \
  "${ROOTFS_DIR}${USER_HOME}/.tvbox/"

# 2) device access + polkit + OS auto-updates (no auto-reboot) - see conf/
install -m 644 conf/99-tvbox.rules "${ROOTFS_DIR}/etc/udev/rules.d/"
install -m 644 conf/50-tvbox-networkmanager.rules conf/51-tvbox-locale.rules "${ROOTFS_DIR}/etc/polkit-1/rules.d/"
install -m 644 conf/20auto-upgrades conf/52tvbox-unattended-upgrades "${ROOTFS_DIR}/etc/apt/apt.conf.d/"
# logind: a BT remote's Power button reaches the box as KEY_POWER; without this
# drop-in logind would power the whole box off (default HandlePowerKey=poweroff)
# before the remote bridge can act on it. Same content deploy/provision.sh
# writes - KEEP IN SYNC (conf/10-tvbox-logind.conf).
install -d "${ROOTFS_DIR}/etc/systemd/logind.conf.d"
install -m 644 conf/10-tvbox-logind.conf "${ROOTFS_DIR}/etc/systemd/logind.conf.d/10-tvbox.conf"

# 2b) WiFi usable on a fresh boot with NO ethernet and NO keyboard. This image
#     has no first-boot config hook (custom.toml is NOT processed - see
#     docs/sd-image.md), so a WiFi-only box can't be preseeded and can't
#     self-heal over OTA (no network yet) - it must come up WiFi-ready.
#     The real blocker (confirmed on a real flash) is that Raspberry Pi OS ships
#     NetworkManager with the WiFi RADIO OFF (WirelessEnabled=false); a plain
#     `rfkill unblock` does NOT flip that, so nmcli never scans. And the Pi's
#     brcmfmac is a self-managed regulatory device that ignores the cmdline
#     regdom - the country has to be set the way the driver honours it. So do
#     exactly what raspi-config/Imager do:
#       - persist WirelessEnabled=true in NetworkManager.state (radio on at boot),
#       - set the regdom on the cmdline (belt for non-self-managed adapters),
#       - and at boot run Raspberry Pi's own `do_wifi_country` (country + nmcli
#         radio on + rfkill unblock + rfkill state), self-healing every boot.
#     Then the owner just picks a network from the TV (Settings → Network).
#     Country defaults to HU (the box's locale); the planned on-TV first-boot
#     wizard will make it selectable + persist a change.
WIFI_COUNTRY=HU
CMDLINE="${ROOTFS_DIR}/boot/firmware/cmdline.txt"
[ -f "$CMDLINE" ] || CMDLINE="${ROOTFS_DIR}/boot/cmdline.txt"
if [ -f "$CMDLINE" ] && ! grep -q ieee80211_regdom "$CMDLINE"; then
  # cmdline.txt must stay a single space-separated line - append to line 1 only
  sed -i "1s|\$| cfg80211.ieee80211_regdom=${WIFI_COUNTRY}|" "$CMDLINE"
fi
# NM ships the WiFi radio off - turn it on persistently so the very first boot
# scans (before/without the boot service even running).
NMSTATE="${ROOTFS_DIR}/var/lib/NetworkManager/NetworkManager.state"
if [ -f "$NMSTATE" ] && grep -q '^WirelessEnabled=' "$NMSTATE"; then
  sed -i 's/^WirelessEnabled=.*/WirelessEnabled=true/' "$NMSTATE"
fi
cat > "${ROOTFS_DIR}/etc/systemd/system/tvbox-wifi-unblock.service" <<'EOF'
[Unit]
Description=tvbox: enable + localise WiFi on a fresh box (radio on, country set, rfkill cleared)
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
# `-` prefixes: a failing step must not block the others. do_wifi_country is
# Raspberry Pi's own routine (sets the driver-honoured country + `nmcli radio
# wifi on` when NM is active + clears rfkill); the retry loop is a belt for the
# case where NM isn't "active" yet when the unit runs.
ExecStart=-/usr/sbin/rfkill unblock wifi
ExecStart=-/usr/bin/raspi-config nonint do_wifi_country HU
ExecStart=-/bin/sh -c 'for i in 1 2 3 4 5; do nmcli radio wifi on && exit 0; sleep 2; done; exit 0'

[Install]
WantedBy=multi-user.target
EOF
install -d "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants"
ln -sf ../tvbox-wifi-unblock.service \
  "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/tvbox-wifi-unblock.service"

# 2c) Headless provisioning WITHOUT custom.toml (which this image can't process).
#     The account password is locked, so there's no way into a fresh box until
#     an SSH key is present. First-boot config is driven by ONE file on the boot
#     (FAT) partition - tvbox.conf (KEY=value, editable on any OS; there's a
#     click-together generator under docs/config/) - applied every boot by
#     tvbox-firstboot:
#       HOSTNAME=  WIFI_SSID=/WIFI_PASSWORD=  SUDO=true  PASSWORD=  SSH_AUTHORIZED_KEY=
#     Legacy standalone files (authorized_keys, tvbox-wifi.conf) still work.
#     Runs every boot, idempotent; the config may stay on the card.

# Default hostname: RPi OS Lite ships "raspberrypi"; several boxes would collide
# on the LAN. Ship "tvbox"; tvbox-firstboot overrides it per box from tvbox.conf.
echo "tvbox" > "${ROOTFS_DIR}/etc/hostname"
if grep -q '^127.0.1.1' "${ROOTFS_DIR}/etc/hosts" 2>/dev/null; then
  sed -i 's/^127.0.1.1.*/127.0.1.1\ttvbox/' "${ROOTFS_DIR}/etc/hosts"
else
  printf '127.0.1.1\ttvbox\n' >> "${ROOTFS_DIR}/etc/hosts"
fi

cat > "${ROOTFS_DIR}/usr/local/sbin/tvbox-firstboot" <<'FIRSTBOOT'
#!/bin/sh
# tvbox headless provisioning from the boot partition (see stage-tvbox 00-run.sh).
# Everything is driven by ONE optional file: tvbox.conf (KEY=value, '#' comments),
# dropped on the boot (FAT) partition, editable on any OS. Runs every boot,
# idempotent. The legacy single-purpose files (authorized_keys, tvbox-wifi.conf,
# tvbox-sudo) are still honoured as fallbacks.
BOOT=/boot/firmware
[ -d "$BOOT" ] || BOOT=/boot
CONF="$BOOT/tvbox.conf"

# Read one KEY from tvbox.conf: everything after the first '=' on the first
# matching line, CR stripped. NOT sourced - a value may contain spaces, '#',
# '$', '/' etc. (e.g. a WiFi password or an SSH key) with no quoting and no code
# execution.
conf_get() { [ -f "$CONF" ] && sed -n "s/^$1=//p" "$CONF" | head -n1 | tr -d '\r'; }

# --- SSH: authorised key for the (locked-by-default) tv account ---
KEY=$(conf_get SSH_AUTHORIZED_KEY)
if [ -n "$KEY" ]; then
  install -d -m 700 -o tv -g tv /home/tv/.ssh
  printf '%s\n' "$KEY" > /home/tv/.ssh/authorized_keys
  chown tv:tv /home/tv/.ssh/authorized_keys && chmod 600 /home/tv/.ssh/authorized_keys
elif [ -f "$BOOT/authorized_keys" ]; then          # legacy standalone file (allows many keys)
  install -d -m 700 -o tv -g tv /home/tv/.ssh
  install -m 600 -o tv -g tv "$BOOT/authorized_keys" /home/tv/.ssh/authorized_keys
fi

# --- Account password (optional): unlock tv for password login (console/SSH).
# Absent = the account stays locked (key-only). Set-only: removing it later does
# NOT re-lock (we never surprise-lock a box). ---
PASSWORD=$(conf_get PASSWORD)
if [ -n "$PASSWORD" ]; then
  printf 'tv:%s\n' "$PASSWORD" | chpasswd 2>/dev/null && passwd -u tv >/dev/null 2>&1
fi

# --- Power-user sudo: SUDO=true grants the tv account passwordless sudo (for an
# SSH admin). Default (absent/false) = no sudo at all, a hardened kiosk. NOPASSWD
# is the only option when the account is locked (mirrors Raspberry Pi OS's
# 010_pi-nopasswd); the tvbox shell stays rootless regardless (hard rule #1) -
# this is a human affordance only. Toggles both ways every boot. ---
SUDO=$(conf_get SUDO)
SUDOERS=/etc/sudoers.d/010-tvbox
if [ "$SUDO" = "true" ] || [ "$SUDO" = "1" ] || [ "$SUDO" = "yes" ] || [ -f "$BOOT/tvbox-sudo" ]; then
  printf 'tv ALL=(ALL) NOPASSWD: ALL\n' > "$SUDOERS.tmp"
  if visudo -cf "$SUDOERS.tmp" >/dev/null 2>&1; then
    chmod 440 "$SUDOERS.tmp" && mv "$SUDOERS.tmp" "$SUDOERS"
  else
    rm -f "$SUDOERS.tmp"
  fi
elif [ -f "$SUDOERS" ]; then
  rm -f "$SUDOERS"
fi

# --- Hostname: name this box (several would otherwise all be "tvbox" and clash
# on the LAN). Sanitised to a valid label; applied only on a real change. ---
NAME=$(conf_get HOSTNAME | tr -cd 'A-Za-z0-9-' | cut -c1-63 | sed 's/^-*//; s/-*$//')
if [ -n "$NAME" ] && [ "$NAME" != "$(cat /etc/hostname 2>/dev/null)" ]; then
  hostnamectl set-hostname "$NAME" 2>/dev/null || { printf '%s\n' "$NAME" > /etc/hostname; hostname "$NAME"; }
  if grep -q '^127.0.1.1' /etc/hosts 2>/dev/null; then
    sed -i "s/^127.0.1.1.*/127.0.1.1\t$NAME/" /etc/hosts
  else
    printf '127.0.1.1\t%s\n' "$NAME" >> /etc/hosts
  fi
fi

# --- WiFi: auto-connect for an ethernet-less box (else set it up from the TV:
# Settings -> Network). From tvbox.conf WIFI_SSID/WIFI_PASSWORD, or the legacy
# tvbox-wifi.conf (SSID=/PSK=). Written once; edit/remove the NM file to change. ---
SSID=$(conf_get WIFI_SSID)
PSK=$(conf_get WIFI_PASSWORD)
if [ -z "$SSID" ] && [ -f "$BOOT/tvbox-wifi.conf" ]; then
  SSID=; PSK=
  . "$BOOT/tvbox-wifi.conf" 2>/dev/null || true    # legacy: sources SSID=/PSK=
fi
KF=/etc/NetworkManager/system-connections/tvbox-preseed.nmconnection
if [ -n "$SSID" ] && [ ! -f "$KF" ]; then
  if [ -n "$PSK" ]; then SEC="[wifi-security]
key-mgmt=wpa-psk
psk=$PSK"; else SEC=""; fi
  cat > "$KF" <<EOF2
[connection]
id=tvbox-preseed
type=wifi
autoconnect=true
[wifi]
mode=infrastructure
ssid=$SSID
$SEC
[ipv4]
method=auto
[ipv6]
method=auto
EOF2
  chmod 600 "$KF"
  nmcli con reload 2>/dev/null || true
fi

# --- Secret hygiene: once PASSWORD / WIFI_PASSWORD have been CONSUMED above,
# blank ONLY those two value lines in tvbox.conf so the plaintext secrets don't
# linger indefinitely on the FAT boot partition (world/tv-readable, so any app
# plugin can read them). Everything else (HOSTNAME, SUDO, WIFI_SSID,
# SSH_AUTHORIZED_KEY) is preserved, so the documented "the config may stay on
# the card" re-run behaviour is unchanged: PASSWORD is set-only (already applied
# via chpasswd; a blank value just no-ops next boot) and WIFI_PASSWORD is only
# blanked once the NM keyfile exists (the WiFi block above is write-once and
# no-ops while $KF is present), so we never strip a PSK that was not actually
# written into a connection. Atomic rewrite via a temp file on the same
# partition; any failure leaves the original untouched. ---
SCRUB_WIFI=""
[ -f "$KF" ] && SCRUB_WIFI="s/^WIFI_PASSWORD=.*/WIFI_PASSWORD=/"
if [ -f "$CONF" ] && grep -Eq '^(PASSWORD|WIFI_PASSWORD)=.' "$CONF"; then
  TMP="$CONF.tvbox-scrub.$$"
  if sed "s/^PASSWORD=.*/PASSWORD=/; $SCRUB_WIFI" "$CONF" > "$TMP" 2>/dev/null && [ -s "$TMP" ]; then
    mv -f "$TMP" "$CONF"
  else
    rm -f "$TMP"
  fi
fi
FIRSTBOOT
chmod 755 "${ROOTFS_DIR}/usr/local/sbin/tvbox-firstboot"
cat > "${ROOTFS_DIR}/etc/systemd/system/tvbox-firstboot.service" <<'EOF'
[Unit]
Description=tvbox: headless provisioning from the boot partition (SSH key, WiFi)
After=NetworkManager.service tvbox-wifi-unblock.service
Wants=NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/tvbox-firstboot

[Install]
WantedBy=multi-user.target
EOF
ln -sf ../tvbox-firstboot.service \
  "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/tvbox-firstboot.service"

# 2d) Default keyboard layout = US (Raspberry Pi OS Lite defaults to gb). Written
#     to /etc/default/keyboard, which labwc + the console read at login; the setup
#     wizard / Settings can change it later (localectl set-x11-keymap via the
#     locale1 polkit grant above).
cat > "${ROOTFS_DIR}/etc/default/keyboard" <<'EOF'
XKBMODEL="pc105"
XKBLAYOUT="us"
XKBVARIANT=""
XKBOPTIONS=""
BACKSPACE="guess"
EOF

# 3) boot straight into labwc as the box user (greetd autologin, kiosk - no
#    desktop, no login prompt; the account password can stay locked)
install -d "${ROOTFS_DIR}/etc/greetd"
cat > "${ROOTFS_DIR}/etc/greetd/config.toml" <<EOF
[terminal]
vt = 7

[default_session]
command = "labwc"
user = "${FIRST_USER_NAME}"
EOF

# Kiosk labwc session: the tvbox shell owns the screen, so the Pi desktop (panel
# wf-panel-pi + file-manager/wallpaper/icons pcmanfm-pi) must never start -
# otherwise it flashes behind the shell on a restart. Replace the system labwc
# autostart so those never launch (kept in sync with deploy/provision.sh); the
# box user's ~/.config/labwc/autostart runs kanshi/audio/black-bg/the shell.
install -d "${ROOTFS_DIR}/etc/xdg/labwc"
cat > "${ROOTFS_DIR}/etc/xdg/labwc/autostart" <<'EOF'
# tvbox kiosk - the Pi desktop is intentionally NOT started; the tvbox shell owns
# the screen. See the box user's ~/.config/labwc/autostart.
/usr/bin/lxsession-xdg-autostart
EOF

# 4) user lingering so the CEC bridge user unit starts at boot (loginctl
#    enable-linger can't run in a chroot - the flag file is its whole effect)
install -d "${ROOTFS_DIR}/var/lib/systemd/linger"
touch "${ROOTFS_DIR}/var/lib/systemd/linger/${FIRST_USER_NAME}"

on_chroot <<CHROOT
set -e
usermod -aG input,video,netdev ${FIRST_USER_NAME}
chown -R ${FIRST_USER_NAME}:${FIRST_USER_NAME} ${USER_HOME}/.tvbox

# NB: librespot (Spotify Connect) is NOT preinstalled - it's a per-app
# requires.download binary the Spotify app installs from the UI, no root
# (Kodi binary-addon style). NOTE: this on_chroot heredoc is UNQUOTED so the
# FIRST_USER_NAME / USER_HOME variables expand at build time - keep backticks
# and command substitution OUT of these comments, or the build shell runs them.
# The image only ships the shared media stack it
# needs: mpv + the runtime libs libpulse0/libasound2 (via 00-packages), like
# Kodi's core provides ffmpeg/system libs while addons ship their own binaries.

# The random build-time FIRST_USER_PASS (see image/config) must never ship
# usable: lock the account. greetd autologin doesn't authenticate, and a
# Raspberry Pi Imager password preseed (userconf) replaces the hash anyway.
passwd -l ${FIRST_USER_NAME}

# Electron npm install INSIDE the arm64 chroot - a host-side install would
# fetch the x86_64 Electron binary. Slowest custom step (~200 MB download).
# `npm ci` (not `npm install`) for a reproducible tree: shell/ ships a committed
# package-lock.json and node_modules is excluded from the copied tree, so ci
# installs exactly the locked versions.
su - ${FIRST_USER_NAME} -c 'cd ~/.tvbox/shell && npm ci --no-audit --no-fund'

# tvbox CLI on PATH
su - ${FIRST_USER_NAME} -c 'mkdir -p ~/.local/bin && ln -sf ~/.tvbox/tvbox ~/.local/bin/tvbox'

# user units: systemctl --user can't run in a chroot - "enable" by creating
# the WantedBy symlinks directly (CEC bridge + remote-input bridge + nightly
# flatpak-update timer)
su - ${FIRST_USER_NAME} -c '
  mkdir -p ~/.config/systemd/user/default.target.wants ~/.config/systemd/user/timers.target.wants
  cp ~/.tvbox/tvbox-cec.service ~/.tvbox/tvbox-remote.service ~/.tvbox/tvbox-flatpak-update.service ~/.tvbox/tvbox-flatpak-update.timer ~/.config/systemd/user/
  ln -sf ../tvbox-cec.service ~/.config/systemd/user/default.target.wants/tvbox-cec.service
  ln -sf ../tvbox-remote.service ~/.config/systemd/user/default.target.wants/tvbox-remote.service
  ln -sf ../tvbox-flatpak-update.timer ~/.config/systemd/user/timers.target.wants/tvbox-flatpak-update.timer'

# session autostart + flathub user remote (network works in the chroot;
# harmless to skip - the deploy path re-adds it too)
su - ${FIRST_USER_NAME} -c 'mkdir -p ~/.config/labwc && cp ~/.tvbox/labwc-autostart ~/.config/labwc/autostart && chmod +x ~/.config/labwc/autostart'
su - ${FIRST_USER_NAME} -c 'flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo || true'

# kiosk session manager; graphical.target so greetd actually starts at boot
systemctl enable greetd
systemctl set-default graphical.target
CHROOT
