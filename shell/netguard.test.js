// Unit tests for the shared network-trust helpers, focused on the fetch layer:
// isAllowedFetchUrl (https anywhere, plain http only to LAN) and guardedFetch's
// manual redirect handling - a 3xx must NOT bounce a vetted feed/registry/
// download onto an internal address (SSRF-via-redirect). Address classification
// itself is covered via appfetch.test.js (same classifyIp).
// Run: node --test shell/netguard.test.js
const test = require("node:test");
const assert = require("node:assert");
const ng = require("./netguard");

// A fake fetch: `routes` maps a url to { status, location } or is a function of
// the url. Records every call so we can assert we never auto-follow.
function fakeFetch(routes) {
  const impl = async (url, opts) => {
    impl.calls.push({ url, redirect: opts && opts.redirect });
    const r = typeof routes === "function" ? routes(url) : routes[url];
    if (!r) throw new Error("unexpected fetch: " + url);
    const status = r.status || 200;
    const location = r.location || null;
    return {
      status,
      ok: status >= 200 && status < 300, // mirror real Response.ok (2xx only), not < 400
      headers: { get: (n) => (String(n).toLowerCase() === "location" ? location : null) },
    };
  };
  impl.calls = [];
  return impl;
}

test("isAllowedFetchUrl: https anywhere, http only to LAN/loopback", () => {
  assert.equal(ng.isAllowedFetchUrl("https://example.com/x"), true);
  assert.equal(ng.isAllowedFetchUrl("http://192.168.1.5/x"), true); // LAN http ok
  assert.equal(ng.isAllowedFetchUrl("http://box.local/x"), true);
  assert.equal(ng.isAllowedFetchUrl("http://127.0.0.1/x"), true); // self-hosted loopback trusted here
  assert.equal(ng.isAllowedFetchUrl("http://example.com/x"), false); // public http
  assert.equal(ng.isAllowedFetchUrl("http://169.254.169.254/latest/"), false); // cloud metadata
  assert.equal(ng.isAllowedFetchUrl("ftp://example.com/x"), false);
  assert.equal(ng.isAllowedFetchUrl(""), false);
  assert.equal(ng.isAllowedFetchUrl("https://"), false); // parseable-URL check, not a prefix test
  assert.equal(ng.isAllowedFetchUrl("http://"), false);
  assert.equal(ng.isAllowedFetchUrl("not a url"), false);
});

test("guardedFetch: follows allowed https redirects to the final response", async () => {
  const impl = fakeFetch({
    "https://a.example/feed": { status: 302, location: "https://b.example/feed" },
    "https://b.example/feed": { status: 200 },
  });
  const res = await ng.guardedFetch("https://a.example/feed", {}, impl);
  assert.equal(res.status, 200);
  assert.equal(impl.calls.length, 2);
  // every hop (not just the first) must use manual mode - never delegate
  // following to undici, which would skip the per-hop re-guard
  assert.deepEqual(
    impl.calls.map((c) => c.redirect),
    ["manual", "manual"],
  );
});

test("guardedFetch: rejects a redirect onto a public http host", async () => {
  const impl = fakeFetch({ "https://a.example/feed": { status: 302, location: "http://evil.example/x" } });
  await assert.rejects(() => ng.guardedFetch("https://a.example/feed", {}, impl), /blocked url/);
});

test("guardedFetch: rejects a redirect onto the cloud metadata address", async () => {
  const impl = fakeFetch({
    "https://a.example/feed": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
  });
  await assert.rejects(() => ng.guardedFetch("https://a.example/feed", {}, impl), /blocked url/);
});

test("guardedFetch: rejects an https->http-LAN downgrade redirect", async () => {
  // a public https feed must NOT be bounced down onto the box's own control API
  const impl = fakeFetch({
    "https://a.example/feed": { status: 302, location: "http://127.0.0.1:8097/tvbox/api/apps" },
  });
  await assert.rejects(() => ng.guardedFetch("https://a.example/feed", {}, impl), /blocked url/);
});

test("guardedFetch: a self-hosted LAN http feed may still redirect within the LAN", async () => {
  const impl = fakeFetch({
    "http://192.168.1.5/feed": { status: 302, location: "http://192.168.1.6/feed" },
    "http://192.168.1.6/feed": { status: 200 },
  });
  const res = await ng.guardedFetch("http://192.168.1.5/feed", {}, impl);
  assert.equal(res.status, 200);
});

test("guardedFetch: an `allow` origin-pin confines redirects to that origin", async () => {
  const pin = (u) => new URL(u).origin === "https://reg.example";
  // same-origin redirect is fine
  const ok = fakeFetch({
    "https://reg.example/apps/x/a.json": { status: 302, location: "https://reg.example/apps/x/b.json" },
    "https://reg.example/apps/x/b.json": { status: 200 },
  });
  assert.equal((await ng.guardedFetch("https://reg.example/apps/x/a.json", { allow: pin }, ok)).status, 200);
  // a cross-origin redirect (even https) is rejected despite passing the generic rule
  const bad = fakeFetch({
    "https://reg.example/apps/x/a.json": { status: 302, location: "https://cdn.evil.example/x" },
  });
  await assert.rejects(() => ng.guardedFetch("https://reg.example/apps/x/a.json", { allow: pin }, bad), /blocked url/);
});

test("guardedFetch: rejects a disallowed initial url before dialing out", async () => {
  const impl = fakeFetch({});
  await assert.rejects(() => ng.guardedFetch("http://evil.example/x", {}, impl), /blocked url/);
  assert.equal(impl.calls.length, 0);
});

test("guardedFetch: caps the redirect chain", async () => {
  const impl = fakeFetch(() => ({ status: 302, location: "https://loop.example/next" }));
  await assert.rejects(
    () => ng.guardedFetch("https://loop.example/start", { maxRedirects: 3 }, impl),
    /too many redirects/,
  );
});
