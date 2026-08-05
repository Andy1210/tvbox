#!/bin/sh
# Install the box's compositor, tvbox-wc (root; called by deploy/provision.sh and
# by the SD-image build).
#
# It is not a distro package and never will be: it is the tvbox's own compositor
# (https://github.com/Andy1210/tvbox-wc), and it exists because a general one
# composites everything into one buffer - at 3840x2160 that is a full-screen GPU
# pass per frame on top of the one the player already does, and a Pi 5 fits one of
# the two. This one hands the film to the display hardware instead.
#
# Two ways in, tried in this order:
#
#   1. the release binary pinned in compositor.version, verified by sha256. This is
#      what a flashed box and a provisioned box get.
#   2. a source tree on the box (TVBOX_WC_SRC, default ~/tvbox-wc), built with
#      cargo. This is the development path, and the only one before the first
#      release is cut.
#
# Neither is fatal on its own, but a box with no compositor has no session, so a
# failure here is loud.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
DEST=/usr/local/bin/tvbox-wc
BOX_USER="${SUDO_USER:-${TVBOX_USER:-}}"
[ -n "$BOX_USER" ] || BOX_USER=$(id -un)
BOX_HOME=$(getent passwd "$BOX_USER" | cut -d: -f6)
SRC="${TVBOX_WC_SRC:-$BOX_HOME/tvbox-wc}"

say() { echo "  $*"; }

installed_version() {
	[ -x "$DEST" ] || return 1
	"$DEST" --version 2>/dev/null | awk '{print $2}'
}

# 1) The pinned release.
TAG=""
SHA256=""
# shellcheck source=/dev/null
[ -f "$HERE/compositor.version" ] && . "$HERE/compositor.version"

if [ -n "$TAG" ] && [ -n "$SHA256" ]; then
	have=$(installed_version || true)
	if [ "$have" = "${TAG#v}" ]; then
		say "tvbox-wc $have already installed"
		exit 0
	fi
	url="https://github.com/Andy1210/tvbox-wc/releases/download/$TAG/tvbox-wc-aarch64"
	tmp=$(mktemp) || exit 1
	if curl -fsSL --retry 3 -o "$tmp" "$url"; then
		got=$(sha256sum "$tmp" | cut -d" " -f1)
		if [ "$got" = "$SHA256" ]; then
			install -m 755 -o root -g root "$tmp" "$DEST"
			rm -f "$tmp"
			say "tvbox-wc $TAG installed from the release"
			exit 0
		fi
		echo "  sha256 mismatch for $url (got $got, want $SHA256)" >&2
	else
		echo "  could not download $url" >&2
	fi
	rm -f "$tmp"
fi

# 2) A source tree on the box.
if [ ! -f "$SRC/Cargo.toml" ]; then
	echo "  no pinned release and no source tree at $SRC - the box has no compositor" >&2
	exit 1
fi

command -v cargo >/dev/null 2>&1 || {
	echo "  cargo is not installed - cannot build $SRC" >&2
	exit 1
}

# A 4 GB Pi 5 runs out of memory with a job per core.
say "building tvbox-wc from $SRC (this takes a few minutes)"
if ! su - "$BOX_USER" -c "cd '$SRC' && cargo build --release -j3" >/tmp/tvbox-wc-build.log 2>&1; then
	echo "  build failed - see /tmp/tvbox-wc-build.log" >&2
	tail -20 /tmp/tvbox-wc-build.log >&2
	exit 1
fi

install -m 755 -o root -g root "$SRC/target/release/tvbox-wc" "$DEST"
say "tvbox-wc $(installed_version) installed from source"
