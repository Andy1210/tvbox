// What a cast may add to a remote app's url, and what it may not.
//
// The launch data is a POST body from an unauthenticated LAN sender, and it ends up
// in the address of a window that is already logged into the site. So the cases
// that matter are not the pairing code - it is every OTHER thing a sender could try
// to write into that address.
// Run: node --test shell/launchurl.test.js
const test = require("node:test");
const assert = require("node:assert");
const { withLaunchQuery, playQuery, MAX_LAUNCH_PARAMS, MAX_PLAY_QUERY } = require("./launchurl");

const YT = "https://www.youtube.com/tv";

test("a DIAL launch body becomes query parameters of the app's own url", () => {
  const u = new URL(withLaunchQuery(YT, "pairingCode=88f1e2b0-1f0a-4d5a-9c1e-3f1f9b2c7d10&theme=cl"));
  assert.equal(u.origin + u.pathname, YT);
  assert.equal(u.searchParams.get("pairingCode"), "88f1e2b0-1f0a-4d5a-9c1e-3f1f9b2c7d10");
  assert.equal(u.searchParams.get("theme"), "cl");
});

test("a body a caller wrote with a leading ? still parses", () => {
  // URLSearchParams drops the leading "?" itself - asserted so nobody adds a strip
  // for it and believes the strip is what makes this pass.
  const u = new URL(withLaunchQuery(YT, "?pairingCode=abc"));
  assert.equal(u.searchParams.get("pairingCode"), "abc");
  assert.equal(u.searchParams.get("?pairingCode"), null);
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

test("a body with more parameters than the cap is refused whole, not truncated", () => {
  // Truncation is the worst of the three outcomes: it can drop the pairing code -
  // the one parameter the launch is FOR - and keep the padding, so the app opens,
  // joins nothing, and the sender is told the cast worked.
  const many = Array.from({ length: MAX_LAUNCH_PARAMS }, (_, i) => "k" + i + "=" + i).join("&");
  assert.equal(withLaunchQuery(YT, many + "&pairingCode=LOST"), "", "over the cap -> nothing to open");
  const atCap = new URL(withLaunchQuery(YT, many));
  assert.equal([...atCap.searchParams.keys()].length, MAX_LAUNCH_PARAMS, "exactly at the cap still applies");
});

test("a value too long is dropped as decoration, and the rest of the body still applies", () => {
  const long = new URL(withLaunchQuery(YT, "pairingCode=" + "x".repeat(300) + "&theme=cl"));
  assert.equal(long.searchParams.get("pairingCode"), null);
  assert.equal(long.searchParams.get("theme"), "cl");
});

test("an unusable url answers empty, so a caller opens no window", () => {
  assert.equal(withLaunchQuery("", "pairingCode=x"), "");
  assert.equal(withLaunchQuery("not a url", "pairingCode=x"), "");
});

test("a base that is not a page is refused rather than decorated", () => {
  // Both call sites check the protocol again on the result; this is the module
  // keeping the promise its own comment makes.
  for (const base of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x", "chrome://settings"]) {
    assert.equal(withLaunchQuery(base, "pairingCode=x"), "", base);
  }
  assert.ok(
    withLaunchQuery("http://192.168.1.5:8096/web/", "pairingCode=x").startsWith("http://"),
    "plain http is a page",
  );
});

// ---- what a LOCAL app is asked to look for (play_media) ----
// Same boundary, different shape: this arrives over MQTT, reaches an app's search
// box, and is written to the shell log.

test("ordinary words come through as they were said", () => {
  assert.equal(playQuery("Bohemian Rhapsody"), "Bohemian Rhapsody");
  assert.equal(playQuery("  Éjjel-nappal Budapest  "), "Éjjel-nappal Budapest");
});

test("nothing to look for is empty, whatever shape the nothing arrived in", () => {
  for (const nothing of [undefined, null, "", "   ", "\n\t"]) assert.equal(playQuery(nothing), "");
});

test("a control character becomes a space rather than disappearing", () => {
  // Removing it would join two words into one nobody asked for, and a newline in
  // a log line is what lets a search phrase forge a second line.
  assert.equal(playQuery("one\ntwo"), "one two");
  assert.equal(playQuery("a\u0000b"), "a b");
  assert.match(playQuery("x\r\ny"), /^x y$/);
});

test("a very long phrase is cut, and does not end in a stray space", () => {
  const long = playQuery("a".repeat(50) + " " + "b".repeat(400));
  assert.ok(long.length <= MAX_PLAY_QUERY);
  assert.equal(long, long.trim());
});

test("a number is a phrase like any other", () => {
  // The caller may hand a title that is only digits; it must not be dropped.
  assert.equal(playQuery(1984), "1984");
});
