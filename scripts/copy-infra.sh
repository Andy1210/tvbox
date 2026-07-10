#!/usr/bin/env bash
# tvbox shared infra-file copier - the ONE place the "infra file set" comes from.
#
#   scripts/copy-infra.sh <dest-dir>
#
# Reads deploy/infra.list (repo-relative paths, one per line; '#' comments and
# blank lines ignored) and copies each listed file into <dest-dir>, FLAT (by
# basename) - matching the historical hand-written `cp ... "$DEST/"` behaviour.
# Fail-closed: a missing infra file aborts the copy (a release must never ship
# an incomplete file set - that is exactly the drift this script exists to kill).
# Dependency-free (no jq/rsync); safe to run from anywhere.
#
# Consumers (all now share this ONE list, so they can never drift apart):
#   scripts/make-release.sh        OTA tarball  -> infra/
#   scripts/build-image.sh         SD image     -> stage-tvbox/01-tvbox/files/
#   .github/workflows/image.yml    SD image (CI, byte-for-byte the same step)
# deploy/deploy.sh reads the same list for its rsync; shell/updater.js
# cross-checks its INFRA_FILES allowlist against it (shell/updater.test.js).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"   # tvbox/scripts
TVBOX="$(dirname "$HERE")"              # tvbox/
LIST="$TVBOX/deploy/infra.list"

DEST="${1:-}"
if [ -z "$DEST" ]; then
  echo "usage: copy-infra.sh <dest-dir>" >&2
  exit 1
fi
[ -f "$LIST" ] || { echo "copy-infra: infra list missing: $LIST" >&2; exit 1; }
mkdir -p "$DEST"

n=0
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"                  # tolerate CRLF-edited lists
  case "$line" in
    ''|'#'*) continue ;;                # skip blank lines and comments
  esac
  src="$TVBOX/$line"
  [ -f "$src" ] || { echo "copy-infra: listed infra file is missing: $line ($src)" >&2; exit 1; }
  cp "$src" "$DEST/"
  n=$((n + 1))
done < "$LIST"

echo "copy-infra: copied $n infra file(s) from infra.list -> $DEST" >&2
