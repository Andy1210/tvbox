#!/usr/bin/env bash
# Mint the ed25519 pair that signs the OTA feed.
#
#   ./scripts/gen-release-key.sh <out-dir>
#
# Produces <out-dir>/release-key.priv.pem (KEEP IT SECRET) and
# <out-dir>/release-key.pem (the public half).
#
# What each half is for:
#
#   public   ships as deploy/release-key.pem, is pinned on the box at
#            /etc/tvbox/release-keys.d/ by provision.sh or the image build, and
#            is what tvbox-sysupdate checks a feed against. It is the ONLY thing
#            standing between "the box user can point DNS wherever they like"
#            and "root runs whatever answers".
#   private  lives in the release pipeline and nowhere else. For the project's
#            own releases that is the TVBOX_RELEASE_KEY GitHub Actions secret
#            (see .github/workflows/release.yml); for a self-hosted feed, pass it
#            to make-release.sh with --sign-key.
#
# Rotation is deliberately awkward. A box pins the first key it is given and
# provision will not silently replace it - `TVBOX_ROTATE_KEY=1` is the explicit
# act - because a key that could be swapped by whatever ships the next update is
# not a trust anchor. That also means a LOST private key cannot be replaced
# remotely: keys are read from a DIRECTORY (/etc/tvbox/release-keys.d/*.pem) so a
# second one can be added before the first is retired, and doing it in that order
# is what keeps a fleet updatable.
set -euo pipefail

OUT="${1:-}"
if [ -z "$OUT" ]; then
  echo "usage: gen-release-key.sh <out-dir>" >&2
  exit 1
fi
mkdir -p "$OUT"

PRIV="$OUT/release-key.priv.pem"
PUB="$OUT/release-key.pem"
[ -e "$PRIV" ] && { echo "$PRIV already exists - refusing to overwrite a signing key" >&2; exit 1; }

umask 077
openssl genpkey -algorithm ed25519 -out "$PRIV"
umask 022
openssl pkey -in "$PRIV" -pubout -out "$PUB"

echo "==> $PRIV   (secret - add as the TVBOX_RELEASE_KEY Actions secret, then delete this file)"
echo "==> $PUB    (public - copy to deploy/release-key.pem)"
echo
echo "Boxes already in the field pin whatever key they were provisioned with, so"
echo "replacing deploy/release-key.pem alone does not reach them."
