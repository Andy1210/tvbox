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
- **Secrets** - `~/.tvbox/config.json` and Spotify tokens are chmod 600; leaks
  into logs/API responses matter.

Shell-side **plugins are trusted code by design** (they run in the host
process) - "a malicious plugin can do X" is expected, not a vulnerability;
review plugins before installing them.
