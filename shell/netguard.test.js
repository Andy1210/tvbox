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
      ok: status < 400,
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
});

test("guardedFetch: follows allowed https redirects to the final response", async () => {
  const impl = fakeFetch({
    "https://a.example/feed": { status: 302, location: "https://b.example/feed" },
    "https://b.example/feed": { status: 200 },
  });
  const res = await ng.guardedFetch("https://a.example/feed", {}, impl);
  assert.equal(res.status, 200);
  assert.equal(impl.calls.length, 2);
  assert.equal(impl.calls[0].redirect, "manual"); // never delegate following to undici
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
