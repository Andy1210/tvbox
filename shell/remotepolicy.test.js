// Where a remote web app may go, and what its manifest may put in the cookie jar.
//
// A manifest arrives from a registry, so this is a boundary: getting "is this host
// declared" wrong is what lets a site reach an origin its author never named, and
// getting the cookie host wrong lets one plant a cookie for a domain that is not
// its own.
const test = require("node:test");
const assert = require("node:assert");

const remotepolicy = require("./remotepolicy");

function boot(opts) {
  const o = opts || {};
  remotepolicy.init({
    config: {
      uiLocale: () => o.locale || "hu-HU",
      appConfig: (key) => (o.appConfig || {})[key] || null,
    },
    lang: {
      resolve: (ui) => ({ tag: String(ui).split("-")[0], accept: String(ui).split("-")[0] + ",en;q=0.8" }),
      expand: (s, tag) => String(s).replace(/\{locale\}/g, tag),
    },
    netguard: { isLanHost: (h) => /^(localhost|127\.|192\.168\.|10\.)/.test(h) || h.endsWith(".local") },
    systemLocale: () => o.systemLocale || "en-GB",
  });
}

const url = (u) => new URL(u);

// ---- protocol ----

test("https is always fine; plain http only to the LAN", () => {
  boot();
  assert.equal(remotepolicy.remoteProtoOk(url("https://youtube.com/tv")), true);
  assert.equal(remotepolicy.remoteProtoOk(url("http://youtube.com/tv")), false);
  assert.equal(remotepolicy.remoteProtoOk(url("http://192.168.1.5:8123/")), true);
  assert.equal(remotepolicy.remoteProtoOk(url("http://ha.local/")), true);
  assert.equal(remotepolicy.remoteProtoOk(url("http://localhost:8123/")), true);
});

test("no other scheme gets through", () => {
  boot();
  for (const u of ["file:///etc/passwd", "data:text/html,x", "javascript:alert(1)", "ftp://x/"]) {
    assert.equal(remotepolicy.remoteProtoOk(url(u)), false, u);
  }
});

// ---- which hosts ----

test("the declared origins win, lowercased", () => {
  boot();
  assert.deepEqual(remotepolicy.allowedRemoteHosts({ origins: ["YouTube.com", "ytimg.com"] }, "https://x/"), [
    "youtube.com",
    "ytimg.com",
  ]);
});

test("an app that declares none is locked to the host it was opened at", () => {
  boot();
  assert.deepEqual(remotepolicy.allowedRemoteHosts({}, "https://Example.COM/tv"), ["example.com"]);
  assert.deepEqual(remotepolicy.allowedRemoteHosts({}, "not a url"), []);
});

test("a subdomain of a declared host is allowed; a lookalike is not", () => {
  boot();
  const hosts = ["youtube.com"];
  assert.equal(remotepolicy.navigationAllowed("https://youtube.com/tv", hosts), true);
  assert.equal(remotepolicy.navigationAllowed("https://www.youtube.com/tv", hosts), true);
  assert.equal(remotepolicy.navigationAllowed("https://notyoutube.com/", hosts), false);
  assert.equal(remotepolicy.navigationAllowed("https://youtube.com.evil.test/", hosts), false);
  assert.equal(remotepolicy.navigationAllowed("https://evil.test/?x=youtube.com", hosts), false);
});

test("the protocol rule applies to a navigation too, and an empty host list allows nothing", () => {
  boot();
  assert.equal(remotepolicy.navigationAllowed("http://youtube.com/", ["youtube.com"]), false);
  assert.equal(remotepolicy.navigationAllowed("https://youtube.com/", []), false);
});

test("something that is not a URL at all is refused rather than throwing", () => {
  boot();
  for (const u of ["", "about:blank", "///", null, undefined, 42]) {
    assert.equal(remotepolicy.navigationAllowed(u, ["youtube.com"]), false, String(u));
  }
});

// ---- the url an app starts at ----

test("a config-driven url comes from config, and is empty until it is set", () => {
  boot();
  const m = { runtime: { serve: "remote", urlConfig: "homeassistant" } };
  assert.equal(remotepolicy.resolveRemoteUrl(m), "");
  boot({ appConfig: { homeassistant: { baseUrl: "http://ha.local:8123" } } });
  assert.equal(remotepolicy.resolveRemoteUrl(m), "http://ha.local:8123");
});

test("a {locale} in the url follows the box's language rather than pinning a market", () => {
  boot({ locale: "hu-HU" });
  const m = { runtime: { url: "https://xbox.com/{locale}/play" } };
  assert.equal(remotepolicy.resolveRemoteUrl(m), "https://xbox.com/hu/play");
  boot({ locale: "en-GB" });
  assert.equal(remotepolicy.resolveRemoteUrl(m), "https://xbox.com/en/play");
});

test("a manifest with neither resolves to nothing, so the caller can call it unconfigured", () => {
  boot();
  assert.equal(remotepolicy.resolveRemoteUrl({ runtime: {} }), "");
  assert.equal(remotepolicy.resolveRemoteUrl({}), "");
});

// ---- cookies ----

const cookieRt = (cookies) => ({ cookies });

test("a cookie for a declared host is set, with {locale} expanded and secure following the scheme", () => {
  boot({ locale: "hu-HU" });
  const r = remotepolicy.cookiesFor(
    cookieRt([{ url: "https://youtube.com/", name: "PREF", value: "hl={locale}" }]),
    ["youtube.com"],
    "hu",
  );
  assert.deepEqual(r.skipped, []);
  assert.equal(r.set.length, 1);
  assert.equal(r.set[0].value, "hl=hu");
  assert.equal(r.set[0].secure, true);
});

test("a cookie for a host the app never declared is refused", () => {
  boot();
  const r = remotepolicy.cookiesFor(
    cookieRt([
      { url: "https://evil.test/", name: "session" },
      { url: "https://accounts.google.com/", name: "x" },
      { url: "not a url", name: "y" },
    ]),
    ["youtube.com"],
    "hu",
  );
  assert.equal(r.set.length, 0);
  assert.equal(r.skipped.length, 3, "a registry manifest must not plant a cookie for an unrelated domain");
});

test("a subdomain of a declared host is its own", () => {
  boot();
  const r = remotepolicy.cookiesFor(cookieRt([{ url: "https://www.youtube.com/", name: "PREF" }]), ["youtube.com"], "");
  assert.equal(r.set.length, 1);
});

test("a cookie with no name is not a cookie", () => {
  boot();
  const r = remotepolicy.cookiesFor(cookieRt([{ url: "https://youtube.com/" }]), ["youtube.com"], "");
  assert.equal(r.set.length, 0);
  assert.equal(r.skipped.length, 1);
});

test("the list is capped - it comes from a file we did not write", () => {
  boot();
  const many = Array.from({ length: remotepolicy.MAX_COOKIES + 10 }, (_, i) => ({
    url: "https://youtube.com/",
    name: "c" + i,
  }));
  const r = remotepolicy.cookiesFor(cookieRt(many), ["youtube.com"], "");
  assert.equal(r.set.length, remotepolicy.MAX_COOKIES);
});

test("a missing or malformed cookie list is simply no cookies", () => {
  boot();
  assert.equal(remotepolicy.cookiesFor({}, ["youtube.com"], "").set.length, 0);
  assert.equal(remotepolicy.cookiesFor(cookieRt("nope"), ["youtube.com"], "").set.length, 0);
  assert.equal(remotepolicy.cookiesFor(null, ["youtube.com"], "").set.length, 0);
});

test("a null value becomes an empty string rather than the word null", () => {
  boot();
  const r = remotepolicy.cookiesFor(
    cookieRt([{ url: "https://youtube.com/", name: "x", value: null }]),
    ["youtube.com"],
    "",
  );
  assert.equal(r.set[0].value, "");
});

// ---- the language both channels agree on ----

test("the language answer carries both the tag and the header", () => {
  boot({ locale: "hu-HU" });
  const w = remotepolicy.languageFor({});
  assert.equal(w.tag, "hu");
  assert.match(w.accept, /^hu/);
});
