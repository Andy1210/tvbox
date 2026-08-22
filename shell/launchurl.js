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

/**
 * What a LOCAL app is asked to look for, on a `play_media` command.
 *
 * The other half of the same question: a remote site can only be handed url
 * parameters, and one of ours is handed words. Same reasoning about the
 * boundary - this arrives over MQTT, reaches an app's search box and a log line
 * - so control characters are replaced rather than stripped (removing them
 * would join two words into one that was never asked for) and the length is
 * capped. Empty means there was nothing to look for.
 */
const MAX_PLAY_QUERY = 200;
// The same set textinput.js strips from what a phone types, and for the same
// reason: C0 and DEL are the obvious ones, but the C1 block, the Arabic letter
// mark and the bidi and zero-width controls are the ones that survive a glance
// at a television two metres away - and this text reaches a log line and an
// app's search box. Replaced with a space rather than removed, so two words
// separated by one do not become a word nobody asked for.
// eslint-disable-next-line no-control-regex
const PLAY_QUERY_STRIP = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
function playQuery(raw) {
  return String(raw == null ? "" : raw)
    .replace(PLAY_QUERY_STRIP, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PLAY_QUERY)
    .trim();
}

/**
 * Would this launch data put ANY parameter on the url?
 *
 * `withLaunchQuery` drops what it cannot use and hands the base url back
 * unchanged, so a caller checking only "is the string non-empty" opens the app's
 * front page for `"   "` or `"a b"` - and, for `play_media`, silences the room
 * to do it. This is the same rule, asked before anything is taken away.
 */
function hasUsableLaunch(query) {
  if (!query) return false;
  for (const [k, v] of new URLSearchParams(String(query))) {
    if (k.length > MAX_LAUNCH_KEY || !LAUNCH_KEY_RE.test(k)) continue;
    if (v.length > MAX_LAUNCH_VALUE) continue;
    return true;
  }
  return false;
}

module.exports = {
  withLaunchQuery,
  playQuery,
  hasUsableLaunch,
  MAX_LAUNCH_PARAMS,
  MAX_LAUNCH_KEY,
  MAX_LAUNCH_VALUE,
  MAX_PLAY_QUERY,
};
