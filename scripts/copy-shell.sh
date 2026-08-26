#!/usr/bin/env bash
# tvbox shared shell/ copier - the ONE place the "what ships in shell/" answer
# comes from.
#
#   scripts/copy-shell.sh <dest-dir> [extra rsync args...]
#
# Copies tvbox/shell into <dest-dir> (so the result is <dest-dir>/shell), reading
# deploy/shell-exclude.list for what to leave out. Extra arguments are passed to
# rsync, which is how the callers that want --delete or -z ask for it.
#
# It exists for the reason scripts/copy-infra.sh does: the exclude list was
# hand-written in four places and had already drifted - two of them excluded
# electron-web-client and two did not, so the SD image shipped a directory the
# OTA tarball and the dev deploy both left out.
#
# Consumers (all now share this ONE list, so they can never drift apart):
#   scripts/make-release.sh        OTA tarball
#   scripts/build-image.sh         SD image
#   .github/workflows/image.yml    SD image (CI, byte-for-byte the same step)
#   deploy/deploy.sh               dev deploy over ssh
# deploy/copy-shell.test.js asserts that set is complete - a fifth copier that
# writes its own excludes fails the build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)" # tvbox/scripts
TVBOX="$(dirname "$HERE")"            # tvbox/
LIST="$TVBOX/deploy/shell-exclude.list"

DEST="${1:-}"
if [ -z "$DEST" ]; then
  echo "usage: copy-shell.sh <dest-dir> [rsync args...]" >&2
  exit 1
fi
shift
[ -f "$LIST" ] || {
  echo "copy-shell: exclude list missing: $LIST" >&2
  exit 1
}

EXCLUDES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}" # tolerate CRLF-edited lists
  case "$line" in
    '' | '#'*) continue ;;
  esac
  EXCLUDES+=(--exclude "$line")
done <"$LIST"

# Fail-closed, like copy-infra.sh: an empty list would ship node_modules into an
# OTA tarball, which is a 700 MB download nobody asked for.
[ ${#EXCLUDES[@]} -gt 0 ] || {
  echo "copy-shell: exclude list is empty: $LIST" >&2
  exit 1
}

mkdir -p "$DEST"
rsync -a "${EXCLUDES[@]}" "$@" "$TVBOX/shell" "$DEST/"
