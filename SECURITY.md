# Security policy

## Reporting

Please report vulnerabilities privately via **GitHub Security Advisories**
(Security → Report a vulnerability) rather than a public issue. You'll get a
response within a week.

## Threat model (what's worth reporting)

tvbox is a LAN device with no cloud account. The interesting boundaries:

- **The capability bridge** - an app manifest must not be able to reach preload
  surfaces it didn't declare (`runtime.capabilities`), and a remote site must
  stay inside its isolated, sandboxed window and declared `origins`. The
  brokered capabilities (`player`, `fetch`, `storage`) are the app SDK
  ([docs/capabilities.md](docs/capabilities.md)); a bug that lets an app reach a
  capability, an origin, or another app's data it didn't declare is a
  vulnerability. In particular the `fetch` data proxy
  ([shell/appfetch.js](shell/appfetch.js)) must stay origin-locked and never
  become a general SSRF proxy - protocol rules, metadata-host denial, credential
  stripping, per-hop redirect re-validation, and size/time caps are all part of
  the boundary.
- **The install paths** - manifests drive user-space installs
  (flatpak/url/git/download) and, via `tvbox deps`, a root apt step. Anything
  that lets a manifest smuggle extra privileges past the validators
  (package-name/URL/path checks, sha256 verification) is a vulnerability.
- **The pairing server** (`:8099`, LAN, only while pairing) - gated by an
  on-screen code with lockout + TTL; bypasses matter.
- **The local API** (`:8097`, loopback-only) - assumed reachable only by local
  processes; anything that exposes it beyond loopback matters.
- **The IR link service** (`~/.tvbox/firetv-ir.sock`, mode 0600) - a resident
  process holding the BLE link to a paired Fire TV remote, so the box can fire
  that remote's own infrared LED. Same assumption as the local API: reachable by
  anything running as the box user, which includes installed apps. It is bounded
  by what it accepts rather than by who connects, and the bound is on the request's
  SHAPE, not on the box's saved plan: `check_blast_request` in
  `remote/firetv_remote_ir.py` holds a request to the fields, ranges, timing count
  and time-on-air a real code has, so resource abuse is closed - but a well-formed
  code the plan does not contain IS accepted, and anything running as the box user
  can therefore fire arbitrary consumer IR while the link is held. A way to widen
  that (past the shape checks, past the length or time-on-air bounds), or to reach
  the socket from off the box, matters.
- **Secrets** - `~/.tvbox/config.json` and Spotify tokens are chmod 600; leaks
  into logs/API responses matter.
- **The system updater** (`deploy/tvbox-sysupdate`) - the one path by which code
  from the network runs as root. The box user may start its unit and nothing
  else, and may pass it nothing: it reads a root-owned config, verifies a
  detached ed25519 signature against a key pinned in `/etc/tvbox/release-keys.d`,
  and runs the staged release's `provision.sh` - never the copy in `~/.tvbox`,
  which the box user can write. Anything that lets unprivileged code choose what
  it fetches, verifies or executes is a vulnerability, and so is a **replay**: a
  validly signed but older release must be refused, because the artifacts stay
  public and the box user can set the box's DNS.

Shell-side **plugins are trusted code by design** (they run in the host
process) - "a malicious plugin can do X" is expected, not a vulnerability;
review plugins before installing them. The same goes for an app package's
**bridge** (`runtime.bridge: "./bridge.js"`), which runs in the app's own
non-isolated renderer: it reaches only the capabilities that app declared, so
it is strictly less than a plugin, but it is still code the package ships and
review is what gates it.
