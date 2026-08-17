// What a cast may add to a remote app's url, and what it may not.
//
// The launch data is a POST body from an unauthenticated LAN sender, and it ends up
// in the address of a window that is already logged into the site. So the cases
// that matter are not the pairing code - it is every OTHER thing a sender could try
// to write into that address.
// Run: node --test shell/launchurl.test.js
const test = require("node:test");
const assert = require("node:assert");
const { withLaunchQuery, MAX_LAUNCH_PARAMS } = require("./launchurl");

const YT = "https://www.youtube.com/tv";

test("a DIAL launch body becomes query parameters of the app's own url", () => {
  const u = new URL(withLaunchQuery(YT, "pairingCode=88f1e2b0-1f0a-4d5a-9c1e-3f1f9b2c7d10&theme=cl"));
  assert.equal(u.origin + u.pathname, YT);
  assert.equal(u.searchParams.get("pairingCode"), "88f1e2b0-1f0a-4d5a-9c1e-3f1f9b2c7d10");
  assert.equal(u.searchParams.get("theme"), "cl");
});

test("a body a caller wrote with a leading ? still parses", () => {
  const u = new URL(withLaunchQuery(YT, "?pairingCode=abc"));
  assert.equal(u.searchParams.get("pairingCode"), "abc");
});

test("no launch data leaves the url exactly as it was", () => {
  assert.equal(withLaunchQuery(YT, ""), YT);
  assert.equal(withLaunchQuery(YT, null), YT);
  assert.equal(withLaunchQuery(YT + "?hl=hu", undefined), YT + "?hl=hu");
});

test("the manifest's own query survives, and a launch parameter of the same name wins", () => {
  const u = new URL(withLaunchQuery(YT + "?hl=hu&theme=old", "theme=cl"));
  assert.equal(u.searchParams.get("hl"), "hu");
  assert.equal(u.searchParams.get("theme"), "cl");
  assert.equal(u.searchParams.getAll("theme").length, 1, "set, not appended - two would leave the old one in place");
});

test("a sender cannot move the window off the app's url", () => {
  // Each of these is a whole different page if it lands anywhere but a parameter
  // VALUE: another origin, another path, or a fragment the site routes on (the
  // leanback player reads its own state out of the hash).
  for (const evil of [
    "pairingCode=x#@evil.example/",
    "pairingCode=x&next=https://evil.example",
    "https://evil.example/=1",
    "/../../account=1",
    "pairingCode=x%23%2F..%2Faccount",
  ]) {
    const u = new URL(withLaunchQuery(YT, evil));
    assert.equal(u.origin, "https://www.youtube.com", evil);
    assert.equal(u.pathname, "/tv", evil);
    assert.equal(u.hash, "", evil);
  }
});

test("a key that is not a plain parameter name is dropped, not escaped", () => {
  const u = new URL(withLaunchQuery(YT, "pairingCode=ok&" + encodeURIComponent("a b") + "=1&%3Cscript%3E=2"));
  assert.equal(u.searchParams.get("pairingCode"), "ok");
  assert.equal(u.searchParams.get("a b"), null);
  assert.equal(u.searchParams.get("<script>"), null);
});

test("count and size are capped, and the cap keeps the parameters it took whole", () => {
  const many = Array.from({ length: MAX_LAUNCH_PARAMS + 5 }, (_, i) => "k" + i + "=" + i).join("&");
  const u = new URL(withLaunchQuery(YT, many));
  assert.equal([...u.searchParams.keys()].length, MAX_LAUNCH_PARAMS);
  assert.equal(u.searchParams.get("k0"), "0");

  const long = new URL(withLaunchQuery(YT, "pairingCode=" + "x".repeat(300) + "&theme=cl"));
  assert.equal(long.searchParams.get("pairingCode"), null, "an oversized value is dropped");
  assert.equal(long.searchParams.get("theme"), "cl", "and the rest of the body still applies");
});

test("an unusable url answers empty, so a caller opens no window", () => {
  assert.equal(withLaunchQuery("", "pairingCode=x"), "");
  assert.equal(withLaunchQuery("not a url", "pairingCode=x"), "");
});
