#!/usr/bin/env bash
# Smoke-test a built SD image: does it hold together, and does its userspace boot?
#
# The image is the ONE channel no other test covers. CI builds an ~840 MB .img.xz,
# uploads it, and nothing ever starts it - which is how a rootfs with 174 MB of
# usable space shipped across several releases, and how a zero-byte cmdline.txt
# could have. Every other channel (dev deploy, OTA) is exercised by the unit tests
# and by a real box; this one was exercised by whoever flashed it first.
#
# Two phases, and it is worth being precise about what each one proves:
#
#   1. GEOMETRY + PAYLOAD - the image mounted, not running. Partition table,
#      filesystem free space, the boot partition's kernel/cmdline, fstab's
#      PARTUUIDs against the real ones, and every file the box needs at runtime.
#      This is where a too-small rootfs or a missing infra file is caught.
#
#   2. BOOT - the image's OWN systemd, started under systemd-nspawn with arm64
#      binfmt. Real init: generators, unit ordering, first-boot units, ssh host
#      key generation. Assertions run INSIDE the booted system and it powers
#      itself off. **CI runs phase 1 only** (SKIP_BOOT=1 in image.yml): under the
#      runner's emulation the container never produced a single line of output and
#      only ended when BOOT_TIMEOUT killed it, so it cost 7 minutes a build and
#      proved nothing. Flashing a card is the honest test. Phase 2 is kept for
#      local runs, where the emulation is yours to fix.
#
# What this deliberately does NOT do, so nobody reads a pass as more than it is:
# it does not run the Raspberry Pi's own kernel, its firmware, or a graphical
# session. QEMU's raspi machines are too flaky to gate a build on, and a Wayland
# compositor plus an emulated GPU is not a CI job. So a kernel that panics on real
# hardware still passes here; a rootfs that cannot boot its own userspace does not.
#
# Usage:  scripts/image-smoke.sh <image.img.xz | image.img>
#         scripts/image-smoke.sh --self-test     # do the checks actually fire?
#         SKIP_BOOT=1 scripts/image-smoke.sh …   # phase 1 only
# Needs root (loop mounts + nspawn) and: systemd-container, qemu-user-static with
# the F-flag binfmt entry registered, e2fsprogs, dosfstools, xz-utils.
set -eu

MIN_ROOT_GB="${MIN_ROOT_GB:-3}"    # the rootfs partition itself
MIN_FREE_MB="${MIN_FREE_MB:-390}"  # free space on a freshly flashed box, BEFORE its
                                   # first-boot expand. This is dumpe2fs "Free blocks",
                                   # so it INCLUDES the ~5% root reserve: the v1.18.0
                                   # regression that prompted the check left 174 MB for
                                   # everything else, which is ~348 MB by this metric.
                                   # The floor is measured, not derived: pi-gen sizes the
                                   # rootfs as used + (0.2 * used + 200 MB), but ext4
                                   # metadata eats about half of that margin, and a real
                                   # build measured 369 MB free while MISSING a ~300 MB
                                   # Electron install - so a whole image lands near 430.
                                   # 390 sits between the two with room either way, and
                                   # it moves up on its own as the image grows. The real
                                   # headroom comes from tvbox-expand-rootfs on first boot.
BOOT_TIMEOUT="${BOOT_TIMEOUT:-420}" # arm64 userspace under emulation is slow
# ...and a hard deadline on top of it: the injected unit powers the container off,
# but a container process that will not terminate would otherwise outlive the
# timeout's polite signal and hang the job rather than fail it.
BOOT_KILL_AFTER="${BOOT_KILL_AFTER:-30}"

IMG_IN="${1:-}"
[ -n "$IMG_IN" ] || {
  echo "usage: $0 <image.img.xz | image.img> | --self-test" >&2
  exit 2
}
[ "$(id -u)" = 0 ] || {
  echo "must run as root (loop mounts + systemd-nspawn)" >&2
  exit 2
}

# ---- self-test ----
# A smoke test nobody exercises is a smoke test that passes on anything, and the
# real one only runs in the (1+ hour) image build. So: build a SYNTHETIC image that
# satisfies every phase-1 check, assert it passes, then break one thing and assert
# it fails. Cheap enough to run on every push, and it is the only thing standing
# between a typo here and a green build over a broken image.
if [ "$IMG_IN" = "--self-test" ]; then
  W="$(mktemp -d /tmp/tvbox-smoke-self.XXXXXX)"
  L=""
  B="$W/b"
  R="$W/r"
  # Defensive: an early exit under `set -e` must not leave a loop device attached
  # on a runner that then builds an image.
  trap 'umount "$B" "$R" 2>/dev/null || true; [ -n "$L" ] && losetup -d "$L" 2>/dev/null || true; rm -rf "$W"' EXIT
  IMG="$W/fake.img"
  # Big enough to satisfy MIN_ROOT_GB after the 260 MB boot partition, and sparse:
  # only ext4's metadata is really written.
  truncate -s 4400M "$IMG"
  sfdisk --quiet "$IMG" <<'PARTS'
label: dos
start=8192, size=524288, type=c
start=532480, type=83
PARTS
  L="$(losetup -Pf --show "$IMG")"
  udevadm settle 2>/dev/null || sleep 2
  mkfs.vfat -n bootfs "${L}p1" >/dev/null
  mkfs.ext4 -q -L rootfs "${L}p2"
  mkdir -p "$B" "$R"
  mount "${L}p1" "$B"
  mount "${L}p2" "$R"
  BU="$(blkid -o value -s PARTUUID "${L}p1")"
  RU="$(blkid -o value -s PARTUUID "${L}p2")"
  printf 'console=serial0,115200 root=PARTUUID=%s rootfstype=ext4 vc4.force_hotplug=1 rootwait\n' "$RU" >"$B/cmdline.txt"
  echo "arm_64bit=1" >"$B/config.txt"
  echo fake >"$B/kernel8.img"
  echo fake >"$B/bcm2712-rpi-5-b.dtb"
  mkdir -p "$R/etc/ssh" "$R/usr/local/sbin" "$R/usr/local/bin" "$R/etc/greetd" \
    "$R/etc/systemd/system" "$R/etc/polkit-1/rules.d" "$R/etc/tvbox/release-keys.d" \
    "$R/home/tv/.tvbox/shell/launcher-dist/assets" \
    "$R/home/tv/.tvbox/shell/node_modules/electron/dist"
  printf 'PARTUUID=%s /boot/firmware vfat defaults 0 2\nPARTUUID=%s / ext4 defaults,noatime 0 1\n' "$BU" "$RU" >"$R/etc/fstab"
  echo 'tv:x:1000:1000::/home/tv:/bin/bash' >"$R/etc/passwd"
  echo 'tv:!:20000:0:99999:7:::' >"$R/etc/shadow"
  for f in usr/local/sbin/tvbox-diag usr/local/sbin/tvbox-safemode usr/local/sbin/tvbox-radio \
    usr/local/sbin/tvbox-sysupdate usr/local/sbin/tvbox-miracast \
    etc/systemd/system/tvbox-miracast.service etc/polkit-1/rules.d/52-tvbox-miracast.rules \
    etc/systemd/system/tvbox-diag.service etc/systemd/system/tvbox-safemode.service \
    etc/systemd/system/tvbox-radio@.service etc/polkit-1/rules.d/53-tvbox-radio.rules \
    etc/polkit-1/rules.d/54-tvbox-power.rules \
    etc/systemd/system/tvbox-sysupdate.service etc/polkit-1/rules.d/54-tvbox-sysupdate.rules \
    etc/tvbox/sysupdate.conf etc/tvbox/release-keys.d/tvbox-release.pem \
    usr/local/bin/tvbox-wc usr/local/bin/tvbox-session home/tv/.tvbox/session.sh \
    home/tv/.tvbox/shell/main.js home/tv/.tvbox/run-shell.sh \
    home/tv/.tvbox/shell/launcher-dist/index.html \
    home/tv/.tvbox/shell/launcher-dist/assets/index-fake.js; do
    echo placeholder >"$R/$f"
  done
  # Two of those are checked for CONTENT, not just presence, so the fixture has to
  # carry the real shape or the self-test would only ever prove the checks fire.
  printf 'FEED_URL=https://example.invalid/update.json\nTVBOX_USER=tv\n' >"$R/etc/tvbox/sysupdate.conf"
  printf -- '-----BEGIN PUBLIC KEY-----\nplaceholder\n-----END PUBLIC KEY-----\n' \
    >"$R/etc/tvbox/release-keys.d/tvbox-release.pem"
  chmod 755 "$R/usr/local/bin/tvbox-wc" "$R/usr/local/bin/tvbox-session" "$R/home/tv/.tvbox/session.sh"
  printf '[default_session]\ncommand = "tvbox-wc -- /usr/local/bin/tvbox-session"\nuser = "tv"\n' \
    >"$R/etc/greetd/config.toml"
  # Not a real Electron - the arch check skips without file(1) and phase 2 is off.
  printf '#!/bin/true\n' >"$R/home/tv/.tvbox/shell/node_modules/electron/dist/electron"
  chmod 755 "$R/home/tv/.tvbox/shell/node_modules/electron/dist/electron"
  umount "$B" "$R"
  losetup -d "$L"
  L=""

  echo "==> self-test: a well-formed image must PASS phase 1"
  # file(1) would call the fake Electron "ASCII text" and fail a check that has
  # nothing to do with what the self-test is proving.
  if ! SKIP_BOOT=1 NO_FILE_CHECK=1 "$0" "$IMG"; then
    echo "SELF-TEST FAILED: a valid image was rejected" >&2
    exit 1
  fi

  echo
  echo "==> self-test: a zero-byte cmdline.txt must FAIL"
  L="$(losetup -Pf --show "$IMG")"
  udevadm settle 2>/dev/null || sleep 2
  mount "${L}p1" "$B"
  : >"$B/cmdline.txt" # exactly the failure a real box was found in
  umount "$B"
  losetup -d "$L"
  L=""
  if SKIP_BOOT=1 NO_FILE_CHECK=1 "$0" "$IMG"; then
    echo "SELF-TEST FAILED: an empty cmdline.txt was accepted" >&2
    exit 1
  fi
  echo
  echo "==> self-test passed: the checks fire in both directions"
  exit 0
fi
[ -f "$IMG_IN" ] || {
  echo "no such image: $IMG_IN" >&2
  exit 2
}

WORK="$(mktemp -d /tmp/tvbox-smoke.XXXXXX)"
BOOTMNT="$WORK/boot"
ROOTMNT="$WORK/root"
LOOP=""
FAILS=0

cleanup() {
  set +e
  # Order matters: the injected files live on the mount, so they go first.
  rm -f "$ROOTMNT/usr/local/sbin/tvbox-image-smoke" \
    "$ROOTMNT/etc/systemd/system/tvbox-image-smoke.service" \
    "$ROOTMNT/etc/systemd/system/multi-user.target.wants/tvbox-image-smoke.service" \
    "$ROOTMNT/var/tmp/tvbox-smoke-result" 2>/dev/null
  umount -R "$BOOTMNT" "$ROOTMNT" 2>/dev/null
  [ -n "$LOOP" ] && losetup -d "$LOOP" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

ok() { printf '  ok    %s\n' "$*"; }
bad() {
  printf '  FAIL  %s\n' "$*"
  FAILS=$((FAILS + 1))
}
check() { # check <description> <test...>
  desc="$1"
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

# ---- unpack ----
case "$IMG_IN" in
*.xz)
  # conv=sparse, because this runs on a runner pi-gen has already largely filled and
  # an SD image is mostly holes: a fully-allocated 4 GB temp file is how this step
  # would run the disk out instead of testing anything.
  echo "==> decompressing $(basename "$IMG_IN")"
  IMG="$WORK/image.img"
  xz -dc "$IMG_IN" | dd of="$IMG" bs=4M conv=sparse status=none
  # dd exits 0 on a short stream, so without this a truncated .img.xz would be
  # checked as if it were an image - and phase 1 would report a partition table
  # problem instead of a corrupt download.
  [ "${PIPESTATUS[0]}" = 0 ] || {
    echo "decompression failed - $IMG_IN is not a complete .xz" >&2
    exit 1
  }
  ;;
*)
  # A copy, not the original: phase 2 injects a unit and boots it, and the file
  # handed to us may be the very artifact about to be published. --sparse=always
  # because an SD image is mostly holes and the runner's disk is not.
  echo "==> copying $(basename "$IMG_IN")"
  IMG="$WORK/image.img"
  cp --sparse=always "$IMG_IN" "$IMG"
  ;;
esac

LOOP="$(losetup -Pf --show "$IMG")"
echo "==> $IMG on $LOOP"
# The partition nodes appear via udev, so blkid right after losetup can miss them.
udevadm settle 2>/dev/null || sleep 2
mkdir -p "$BOOTMNT" "$ROOTMNT"

echo
echo "=== phase 1: geometry + payload ==="

# Two partitions, FAT boot then ext4 root - pi-gen's layout. Anything else means
# the build produced something we do not understand, and every check below would
# be measuring the wrong thing.
PARTS="$(ls "$LOOP"p* 2>/dev/null | wc -l)"
check "the image has 2 partitions (found $PARTS)" test "$PARTS" = 2
[ "$PARTS" = 2 ] || {
  echo "unusable partition layout - stopping" >&2
  exit 1
}

BOOTDEV="${LOOP}p1"
ROOTDEV="${LOOP}p2"
check "p1 is the FAT boot partition" sh -c "blkid -o value -s TYPE '$BOOTDEV' | grep -q '^vfat$'"
check "p2 is ext4" sh -c "blkid -o value -s TYPE '$ROOTDEV' | grep -q '^ext4$'"

ROOT_BYTES=$(blockdev --getsize64 "$ROOTDEV")
ROOT_GB=$((ROOT_BYTES / 1024 / 1024 / 1024))
check "the rootfs partition is at least ${MIN_ROOT_GB} GB (${ROOT_GB} GB)" test "$ROOT_GB" -ge "$MIN_ROOT_GB"

# THE regression check. A freshly flashed box expands its rootfs on first boot, but
# it has to survive until then - and an image with no headroom cannot install an
# app, keep a journal, or take an OTA update.
FREE_BLOCKS="$(dumpe2fs -h "$ROOTDEV" 2>/dev/null | awk -F: '/Free blocks/ {gsub(/ /,"",$2); print $2; exit}')"
BLOCK_SIZE="$(dumpe2fs -h "$ROOTDEV" 2>/dev/null | awk -F: '/Block size/ {gsub(/ /,"",$2); print $2; exit}')"
# Default to 0 rather than an empty arithmetic expression: an unreadable superblock
# must fail this check loudly, not crash the script before the rest runs.
FREE_MB=$(((${FREE_BLOCKS:-0} * ${BLOCK_SIZE:-4096}) / 1024 / 1024))
check "the rootfs has at least ${MIN_FREE_MB} MB free before expansion (${FREE_MB} MB)" test "$FREE_MB" -ge "$MIN_FREE_MB"

mount -o ro "$BOOTDEV" "$BOOTMNT"
mount "$ROOTDEV" "$ROOTMNT"

# The boot partition is what the firmware reads, and nothing on a running system
# reports a problem with it - a zero-byte cmdline.txt boots on the firmware's
# fallback command line, silently losing the regdom AND vc4.force_hotplug.
check "config.txt exists" test -s "$BOOTMNT/config.txt"
check "cmdline.txt is not empty" test -s "$BOOTMNT/cmdline.txt"
check "a kernel image is present" sh -c "ls '$BOOTMNT'/kernel*.img >/dev/null 2>&1"
check "device trees are present" sh -c "ls '$BOOTMNT'/*.dtb >/dev/null 2>&1"
check "no orphaned FAT recovery file (a torn boot-partition write)" sh -c "! ls '$BOOTMNT'/FSCK*.REC >/dev/null 2>&1"
for want in "root=PARTUUID=" "rootfstype=ext4" "vc4.force_hotplug=1"; do
  check "cmdline.txt carries $want" grep -qF "$want" "$BOOTMNT/cmdline.txt"
done

# fstab pointing at a PARTUUID this image does not have is an unbootable image that
# looks perfect from the outside.
for dev in "$BOOTDEV" "$ROOTDEV"; do
  uuid="$(blkid -o value -s PARTUUID "$dev")"
  check "fstab references $(basename "$dev")'s PARTUUID ($uuid)" grep -qF "$uuid" "$ROOTMNT/etc/fstab"
done
cmdline_uuid="$(sed -n 's/.*root=PARTUUID=\([^ ]*\).*/\1/p' "$BOOTMNT/cmdline.txt")"
check "cmdline.txt's root PARTUUID is the real rootfs ($cmdline_uuid)" \
  test "$cmdline_uuid" = "$(blkid -o value -s PARTUUID "$ROOTDEV")"

# The box user, and the locked password the image promises: greetd autologins, and
# SSH must stay unusable until the owner sets one.
check "the tv user exists" grep -q '^tv:' "$ROOTMNT/etc/passwd"
check "the tv account password is locked" sh -c "awk -F: '/^tv:/ {print \$2}' '$ROOTMNT/etc/shadow' | grep -q '^!'"

# Everything the box needs at runtime that OTA can never install - root-side
# diagnostics and safe mode - plus the shell payload itself. A missing one here is
# a box that boots and then cannot say why it is broken.
#
# The tvbox-sysupdate set is here for a sharper reason than the rest. This stage
# does provision.sh's work independently and nothing else fails when the two
# drift, so a forgotten line would ship a flashed box that can never install a
# release's root half - on hardware with no ssh to fix it over. Here it is a
# failed image build instead.
for f in \
  usr/local/sbin/tvbox-diag \
  usr/local/sbin/tvbox-safemode \
  usr/local/sbin/tvbox-radio \
  usr/local/sbin/tvbox-sysupdate \
  usr/local/sbin/tvbox-miracast \
  etc/systemd/system/tvbox-miracast.service \
  etc/polkit-1/rules.d/52-tvbox-miracast.rules \
  etc/systemd/system/tvbox-diag.service \
  etc/systemd/system/tvbox-safemode.service \
  etc/systemd/system/tvbox-radio@.service \
  etc/systemd/system/tvbox-sysupdate.service \
  etc/polkit-1/rules.d/53-tvbox-radio.rules \
  etc/polkit-1/rules.d/54-tvbox-power.rules \
  etc/polkit-1/rules.d/54-tvbox-sysupdate.rules \
  etc/tvbox/sysupdate.conf \
  etc/tvbox/release-keys.d/tvbox-release.pem \
  usr/local/bin/tvbox-wc \
  usr/local/bin/tvbox-session \
  home/tv/.tvbox/session.sh \
  home/tv/.tvbox/shell/main.js \
  home/tv/.tvbox/run-shell.sh \
  home/tv/.tvbox/shell/launcher-dist/index.html; do
  check "shipped: /$f" test -s "$ROOTMNT/$f"
done
# The applier refuses to run without a valid box user, and this file is the only
# place it can learn one - a substitution that silently missed would ship a box
# whose every system update ends in bad-config, with no ssh to find that out over.
# Presence is not enough here; the line has to name the user.
check "the image names the box user for system updates" \
  grep -q "^TVBOX_USER=tv$" "$ROOTMNT/etc/tvbox/sysupdate.conf"
check "the pinned release key is a public key" \
  grep -q "BEGIN PUBLIC KEY" "$ROOTMNT/etc/tvbox/release-keys.d/tvbox-release.pem"
# The session chain, end to end: greetd starts the compositor, the compositor starts
# the wrapper, the wrapper execs the box user's session script. Any one of them
# missing is a flashed box that shows nothing - and tvbox-session deliberately
# sleeps rather than exiting when the script is absent, so there is no crash to
# notice either.
check "greetd starts the compositor" sh -c \
  "grep -q '^command = \"tvbox-wc -- /usr/local/bin/tvbox-session\"' '$ROOTMNT/etc/greetd/config.toml'"
check "the compositor is executable" test -x "$ROOTMNT/usr/local/bin/tvbox-wc"
check "the session wrapper is executable" test -x "$ROOTMNT/usr/local/bin/tvbox-session"
check "the session script is executable" test -x "$ROOTMNT/home/tv/.tvbox/session.sh"
check "the launcher bundle's assets are there too" sh -c "ls '$ROOTMNT'/home/tv/.tvbox/shell/launcher-dist/assets/*.js >/dev/null 2>&1"

# The arm64 Electron install is ~100 MB fetched inside the chroot; an interrupted
# one leaves a truncated binary that only fails on the TV.
ELECTRON="$ROOTMNT/home/tv/.tvbox/shell/node_modules/electron/dist/electron"
check "Electron is installed" test -x "$ELECTRON"
if command -v file >/dev/null 2>&1 && [ -z "${NO_FILE_CHECK:-}" ]; then
  check "Electron is an arm64 binary" sh -c "file -b '$ELECTRON' | grep -q 'ARM aarch64'"
else
  echo "  skip  Electron arch (no file(1) here; phase 2 executes it anyway)"
fi

if [ -n "${SKIP_BOOT:-}" ]; then
  echo
  echo "==> SKIP_BOOT set - phase 1 only"
  if [ "$FAILS" -gt 0 ]; then
    echo "==> $FAILS check(s) FAILED"
    exit 1
  fi
  echo "==> geometry + payload checks passed"
  exit 0
fi

echo
echo "=== phase 2: boot the image's own userspace ==="

# The assertions run inside the booted system, because that is the only place that
# can answer them: whether init reached multi-user.target, which units failed, and
# whether the first-boot ssh key generation actually ran.
cat >"$ROOTMNT/usr/local/sbin/tvbox-image-smoke" <<'INNER'
#!/bin/sh
# Injected by scripts/image-smoke.sh, removed afterwards.
#
# Results go to a file on the ROOTFS and, prefixed, to the console. Not /run or
# /tmp: systemd-nspawn mounts a tmpfs over both, so anything written there is gone
# the moment the container exits and the caller would see an empty result every
# time - a phase that always fails is indistinguishable from a phase that never
# checked anything. The console copy is the belt: if the file ever goes missing
# again, the caller parses the boot output instead of reporting a blank failure.
R=/var/tmp/tvbox-smoke-result
: >"$R"
say() {
  echo "$1 $2" >>"$R"
  echo "TVBOX-SMOKE $1 $2"
}
t() { if eval "$2"; then say ok "$1"; else say FAIL "$1"; fi; }

t "init reached multi-user.target" '[ "$(systemctl is-active multi-user.target)" = active ]'
# `degraded` is expected: units that need real hardware (udev, the GPU session,
# the CEC bridge) cannot come up in a container. `running` is fine too.
t "systemd settled (running or degraded)" 'case $(systemctl is-system-running) in running|degraded) true;; *) false;; esac'
# A unit that does not EXIST is a packaging bug and looks the same as a unit that
# failed on missing hardware unless you ask separately.
t "no enabled unit is missing its file" '! systemctl list-units --state=not-found --no-legend --all | grep -q .'
t "ssh host keys were generated" 'ls /etc/ssh/ssh_host_*_key >/dev/null 2>&1'
t "ssh host keys are not empty" '[ -s "$(ls /etc/ssh/ssh_host_*_key | head -1)" ]'
t "the ssh daemon is enabled" 'systemctl is-enabled ssh >/dev/null 2>&1 || systemctl is-enabled sshd >/dev/null 2>&1'
t "the autologin session manager is enabled" 'systemctl is-enabled greetd >/dev/null 2>&1'
t "the diagnostics report unit is enabled" 'systemctl is-enabled tvbox-diag.service >/dev/null 2>&1'
t "the shell launcher script is valid sh" 'sh -n /home/tv/.tvbox/run-shell.sh'
# The closest thing to "the shell starts" that a container can honestly answer:
# the arm64 Electron binary executes and its bundled Node runs our code. A real
# Wayland session is out of scope here (see the header of image-smoke.sh).
t "Electron's runtime executes" 'ELECTRON_RUN_AS_NODE=1 /home/tv/.tvbox/shell/node_modules/electron/dist/electron -p "1+1" >/dev/null 2>&1'
t "the shell's modules load" 'cd /home/tv/.tvbox/shell && ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron -e "require(\"./install.js\");require(\"./netguard.js\");require(\"./config.js\")" >/dev/null 2>&1'
# Report what did fail, so a real regression is diagnosable from the CI log rather
# than only visible as a count.
{
  echo "--- failed units ---"
  systemctl list-units --state=failed --no-legend --all || true
} >>"$R"
INNER
chmod 755 "$ROOTMNT/usr/local/sbin/tvbox-image-smoke"

cat >"$ROOTMNT/etc/systemd/system/tvbox-image-smoke.service" <<'UNIT'
[Unit]
Description=tvbox image smoke test (injected by CI)
After=multi-user.target
Requires=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tvbox-image-smoke
# journal+console, not the default: only PID 1's own status lines reach the
# --console=pipe fd the caller captures, and journald does not forward to the
# console unless asked. Without this the console fallback below would be inert -
# an empty parse on exactly the day the result file goes missing.
StandardOutput=journal+console
# Powers the container off whether the checks passed or not: the caller reads the
# result file, so a hung boot must not be how a failure is reported.
ExecStopPost=/usr/bin/systemctl poweroff -ff

[Install]
WantedBy=multi-user.target
UNIT
mkdir -p "$ROOTMNT/etc/systemd/system/multi-user.target.wants"
ln -sf ../tvbox-image-smoke.service \
  "$ROOTMNT/etc/systemd/system/multi-user.target.wants/tvbox-image-smoke.service"

echo "==> systemd-nspawn --boot (timeout ${BOOT_TIMEOUT}s)"
# --register=no keeps machined out of it (the host's may not be running);
# --resolv-conf=off leaves the image's own file alone.
CONSOLE="$WORK/boot-console.log"
set +e
timeout --kill-after="$BOOT_KILL_AFTER" "$BOOT_TIMEOUT" systemd-nspawn \
  --directory "$ROOTMNT" \
  --boot \
  --register=no \
  --resolv-conf=off \
  --timezone=off \
  --console=pipe \
  2>&1 | tee "$CONSOLE" | sed 's/^/    | /'
# The pipeline's own status is sed's; the timeout's is what says whether the boot
# finished, so read it out of PIPESTATUS rather than $?.
NSPAWN_RC="${PIPESTATUS[0]}"
set -e
if [ "$NSPAWN_RC" = 124 ]; then
  bad "the boot did not finish within ${BOOT_TIMEOUT}s"
fi

# The rootfs copy first (it carries the failed-unit dump too); the console copy is
# the fallback for the day something mounts over /var/tmp as well.
RESULT="$ROOTMNT/var/tmp/tvbox-smoke-result"
if [ ! -s "$RESULT" ]; then
  RESULT="$WORK/from-console"
  sed -n 's/^.*TVBOX-SMOKE \(ok\|FAIL\) /\1 /p' "$CONSOLE" >"$RESULT" || true
  [ -s "$RESULT" ] && echo "  note  result file missing - read from the boot console instead"
fi
if [ ! -s "$RESULT" ]; then
  bad "the booted system produced no results at all (it never reached the test unit)"
else
  echo
  while IFS= read -r line; do
    case "$line" in
    "ok "*) ok "${line#ok }" ;;
    "FAIL "*) bad "${line#FAIL }" ;;
    *) printf '        %s\n' "$line" ;;
    esac
  done <"$RESULT"
fi

echo
if [ "$FAILS" -gt 0 ]; then
  echo "==> $FAILS check(s) FAILED"
  exit 1
fi
echo "==> image smoke test passed"
