// The query a plugin adds to a remote app's URL for ONE launch: the DIAL launch
// data a phone hands the box when it casts (YouTube's pairing code), which has to
// reach the page or the sender waits for a screen that never joins its session.
//
// Those values arrive over the LAN in an unauthenticated POST, so this merge is
// the boundary. Parameters are set on the manifest's OWN url through
// URLSearchParams, which can change neither the origin, nor the path, nor the
// fragment - the worst a sender can do is add query parameters to the site the
// manifest already declared. Count and size are capped, and a key that is not a
// plain parameter name is dropped rather than escaped: no real sender needs one,
// and dropping keeps the resulting url readable in a log.
const MAX_LAUNCH_PARAMS = 8;
const MAX_LAUNCH_KEY = 40;
const MAX_LAUNCH_VALUE = 256;
const LAUNCH_KEY_RE = /^[A-Za-z0-9_.-]+$/;

// (url, "pairingCode=…&theme=cl") -> url with those parameters set.
// Returns the url unchanged when there is nothing to add, and "" only if the url
// itself is unusable - the caller treats that as "do not open a window".
function withLaunchQuery(url, query) {
  const base = String(url || "");
  if (!base) return "";
  let u;
  try {
    u = new URL(base);
  } catch (e) {
    return "";
  }
  if (!query) return base;
  let n = 0;
  // A leading "?" is what a DIAL launch body does NOT have, but a caller building
  // the string by hand easily writes one; URLSearchParams would then read the
  // first key with the "?" glued on.
  for (const [k, v] of new URLSearchParams(String(query).replace(/^\?/, ""))) {
    if (k.length > MAX_LAUNCH_KEY || !LAUNCH_KEY_RE.test(k)) continue;
    if (v.length > MAX_LAUNCH_VALUE) continue;
    if (n >= MAX_LAUNCH_PARAMS) break;
    n++;
    u.searchParams.set(k, v);
  }
  return u.toString();
}

module.exports = { withLaunchQuery, MAX_LAUNCH_PARAMS, MAX_LAUNCH_KEY, MAX_LAUNCH_VALUE };
