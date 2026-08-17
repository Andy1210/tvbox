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
  // Only a page. Both call sites check this again on the result, but a module that
  // promises "parameters on the app's own url" must not quietly decorate a
  // `javascript:` or `file:` base and hand it back looking merged.
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (!query) return base;
  // Collected first, applied after: a body with more parameters than the cap is
  // refused WHOLE. Truncating it looks tidier and is the worst outcome available -
  // it can drop the one parameter the launch is about (the pairing code) while
  // keeping the decoration, so the app opens and joins nothing while the sender is
  // told it worked.
  const keep = [];
  for (const [k, v] of new URLSearchParams(String(query))) {
    if (k.length > MAX_LAUNCH_KEY || !LAUNCH_KEY_RE.test(k)) continue; // decoration, not a launch
    if (v.length > MAX_LAUNCH_VALUE) continue;
    keep.push([k, v]);
  }
  if (keep.length > MAX_LAUNCH_PARAMS) return "";
  for (const [k, v] of keep) u.searchParams.set(k, v);
  return u.toString();
}

module.exports = { withLaunchQuery, MAX_LAUNCH_PARAMS, MAX_LAUNCH_KEY, MAX_LAUNCH_VALUE };
