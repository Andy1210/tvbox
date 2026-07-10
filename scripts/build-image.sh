#!/usr/bin/env bash
# Build the tvbox SD-card image LOCALLY - faster than the ~1-1.5 h CI run and
# lets you iterate. Mirrors .github/workflows/image.yml exactly: builds the
# launcher, assembles stage-tvbox/files/, sets up static-qemu arm64 binfmt,
# then runs pi-gen's build-docker.sh. Output: a flashable .img.xz.
#
# The FIRST run does a full build (bootstraps Raspberry Pi OS Lite; ~30-60 min).
# Every run after that is INCREMENTAL by default: pi-gen's build-docker.sh reuses
# the prior container's work volume (the built stage0-2 rootfs) via CONTINUE=1,
# and we drop a SKIP file in stage0/1/2 so only stage-tvbox rebuilds (a few
# minutes + the in-chroot Electron npm install). ALL of tvbox's own image content
# lives in stage-tvbox (00-packages, 01-tvbox/00-run.sh, the copied deploy/ infra
# + built launcher), and build-docker.sh re-bakes the source into the pi-gen image
# every run, so an incremental build always reflects your latest edits. If a
# rebuild ever looks stale or the base is broken, force a clean full build with
# --fresh.
#
#   ./scripts/build-image.sh [--fresh] [--skip-launcher] [--build-dir DIR]
#
#     --fresh          wipe the pi-gen work container + clone and rebuild from
#                      scratch (also the recovery path if a build was interrupted)
#     --skip-launcher  reuse the existing shell/launcher-dist (skip npm run build)
#     --build-dir DIR  where to keep the pi-gen clone + output (default
#                      tvbox/.image-build, gitignored)
#
# Requirements: Docker (running, usable without sudo), sudo once (to install
# qemu-user-static + binfmt), and ~25 GB free disk in the build dir.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)" # tvbox/scripts
TVBOX="$(dirname "$HERE")"            # tvbox/
BUILD_DIR="$TVBOX/.image-build"
FRESH=0
SKIP_LAUNCHER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh) FRESH=1; shift ;;
    --skip-launcher) SKIP_LAUNCHER=1; shift ;;
    --build-dir)
      BUILD_DIR="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,29p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 1
      ;;
  esac
done
PIGEN="$BUILD_DIR/pi-gen"

command -v docker >/dev/null || {
  echo "docker not found - install Docker first" >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo "docker daemon not reachable (is it running? are you in the docker group?)" >&2
  exit 1
}

# free-space sanity (pi-gen + the in-chroot Electron install need ~20 GB)
mkdir -p "$BUILD_DIR"
AVAIL_GB="$(df -BG --output=avail "$BUILD_DIR" | tail -1 | tr -dc '0-9')"
if [ "${AVAIL_GB:-0}" -lt 25 ]; then
  echo "   [warn] only ${AVAIL_GB}G free in $BUILD_DIR - pi-gen wants ~25G, the build may fail" >&2
fi

# static arm64 binfmt: build-docker.sh greps for a HOST `qemu-aarch64` and the
# interpreter must be STATIC to work inside its build container (same recipe as
# image.yml). One-time host setup; needs sudo.
if [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ] || [ ! -x /usr/bin/qemu-aarch64 ]; then
  echo "==> setting up static arm64 binfmt (qemu-user-static + binfmt-support) - needs sudo, once"
  sudo apt-get update -qq
  sudo apt-get install -y -qq qemu-user-static binfmt-support
  sudo ln -sf /usr/bin/qemu-aarch64-static /usr/bin/qemu-aarch64
fi
ls /proc/sys/fs/binfmt_misc/ | grep -qi aarch64 || {
  echo "arm64 binfmt still not registered - see docs/sd-image.md" >&2
  exit 1
}

# 1) launcher (host-side static bundle; arch-independent)
if [ "$SKIP_LAUNCHER" = 0 ]; then
  echo "==> building launcher -> shell/launcher-dist"
  (cd "$TVBOX/launcher" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build)
fi
[ -d "$TVBOX/shell/launcher-dist" ] || {
  echo "shell/launcher-dist missing - drop --skip-launcher or build the launcher first" >&2
  exit 1
}

# 2) assemble stage-tvbox/files (byte-for-byte the same as image.yml's step)
echo "==> assembling stage-tvbox/files"
F="$TVBOX/image/stage-tvbox/01-tvbox/files"
mkdir -p "$F"
# clear previously assembled flat infra files first - 00-run.sh installs
# EVERYTHING flat in files/, so a file dropped from infra.list must not keep
# shipping from a stale local assembly (CI always assembles into a clean tree)
find "$F" -maxdepth 1 -type f -delete
rsync -a --delete --exclude node_modules --exclude apps-data --exclude '*.log' "$TVBOX/shell" "$F/"
# The infra files come from the ONE shared list (deploy/infra.list) via
# copy-infra.sh - byte-for-byte the same set image.yml assembles, so a local
# build and CI produce identical payloads (this is how remote_input_bridge.py,
# tvbox-remote.service and cec_vendor_shim.c reach the SD image).
"$HERE/copy-infra.sh" "$F"

# 3) pi-gen checkout (reused across runs) + our stage/config (re-copied each run
#    so edits always land, since build-docker.sh re-bakes the source every build)
if [ "$FRESH" = 1 ]; then
  echo "==> --fresh: removing prior build container + clone"
  docker rm -f pigen_work >/dev/null 2>&1 || true
  rm -rf "$PIGEN"
fi
# Pinned for reproducible builds: pi-gen's `arm64` branch is a moving target,
# so two builds weeks apart could otherwise bootstrap different base images.
# PIGEN_REF is the arm64 head verified with the current stage (bump it
# deliberately, and keep it in sync with .github/workflows/image.yml). We clone
# the branch (full history so the ref stays reachable after arm64 advances)
# then detach onto the exact commit.
PIGEN_REF="ca8aeed0ae300c2a89f55ce9617d5f96a27e99e5" # pi-gen arm64 @ 2026-07
if [ ! -d "$PIGEN/.git" ]; then
  echo "==> cloning pi-gen (arm64 @ ${PIGEN_REF})"
  git clone --branch arm64 https://github.com/RPi-Distro/pi-gen.git "$PIGEN"
fi
# apply the pin to REUSED checkouts too - a clone from before a pin bump would
# otherwise silently keep building the old base until someone runs --fresh
if [ "$(git -C "$PIGEN" rev-parse HEAD)" != "$PIGEN_REF" ]; then
  echo "==> pinning pi-gen checkout to ${PIGEN_REF}"
  git -C "$PIGEN" fetch origin arm64
  git -C "$PIGEN" checkout --detach "$PIGEN_REF"
fi
rm -rf "$PIGEN/stage-tvbox"
cp -r "$TVBOX/image/stage-tvbox" "$PIGEN/"
cp "$TVBOX/image/config" "$PIGEN/config"
touch "$PIGEN/stage2/SKIP_IMAGES" # export only the tvbox stage's image

# Incremental if a prior build container exists: SKIP the upstream Lite base
# (stage0-2 never change on our side) and reuse its rootfs via CONTINUE=1, so
# only stage-tvbox rebuilds. First run (no container) is a full build.
if docker ps -a --format '{{.Names}}' | grep -qx pigen_work; then
  echo "==> incremental build - reusing pigen_work, skipping stage0-2 (use --fresh for a full rebuild)"
  touch "$PIGEN/stage0/SKIP" "$PIGEN/stage1/SKIP" "$PIGEN/stage2/SKIP"
  export CONTINUE=1
else
  echo "==> full build - first run bootstraps Raspberry Pi OS Lite (~30-60 min)"
  rm -f "$PIGEN/stage0/SKIP" "$PIGEN/stage1/SKIP" "$PIGEN/stage2/SKIP"
  export CONTINUE=0
fi

# 4) build. PRESERVE_CONTAINER=1 keeps the pigen_work container after a
#    successful build (build-docker.sh removes it by default) so the NEXT run
#    can reuse its stage0-2 rootfs and rebuild only stage-tvbox - that's what
#    makes iteration fast instead of a full ~30-60 min bootstrap every time.
echo "==> pi-gen build-docker.sh (CONTINUE=$CONTINUE)"
(cd "$PIGEN" && PRESERVE_CONTAINER=1 ./build-docker.sh)

IMG="$(ls -t "$PIGEN"/deploy/*.img.xz 2>/dev/null | head -1 || true)"
[ -n "$IMG" ] || {
  echo "build finished but no .img.xz in $PIGEN/deploy/ - check the pi-gen output above" >&2
  exit 1
}
cp "$IMG" "$BUILD_DIR/"
echo
echo "==> DONE: $BUILD_DIR/$(basename "$IMG")  ($(du -h "$IMG" | cut -f1))"
echo "    Flash: Raspberry Pi Imager -> 'Use custom image', or"
echo "           xzcat '$BUILD_DIR/$(basename "$IMG")' | sudo dd of=/dev/sdX bs=4M conv=fsync status=progress"
