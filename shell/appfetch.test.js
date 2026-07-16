// Unit tests for the scoped fetch capability (node --test, no Electron).
// Covers the SSRF boundary: origin allowlisting, IP classification + DNS-resolve
// guard (loopback/link-local/metadata/rebinding), header filtering, the proxy
// orchestration (redirect re-guard + Authorization drop) with injected
// lookup/transport, and the real HTTP transport against a local server.
// Run: node --test shell/appfetch.test.js
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const af = require("./appfetch");

// ---- classifyIp ----
test("classifyIp: IPv4 ranges", () => {
  assert.equal(af.classifyIp("127.0.0.1"), "loopback");
  assert.equal(af.classifyIp("10.0.0.5"), "private");
  assert.equal(af.classifyIp("192.168.1.50"), "private");
  assert.equal(af.classifyIp("172.16.0.1"), "private");
  assert.equal(af.classifyIp("100.64.0.1"), "private"); // CGNAT
  assert.equal(af.classifyIp("169.254.1.1"), "linklocal");
  assert.equal(af.classifyIp("169.254.169.254"), "metadata");
  assert.equal(af.classifyIp("0.0.0.0"), "unspecified");
  assert.equal(af.classifyIp("8.8.8.8"), "public");
});
test("classifyIp: IPv6 incl. mapped + zone/brackets", () => {
  assert.equal(af.classifyIp("::1"), "loopback");
  assert.equal(af.classifyIp("[::1]"), "loopback");
  assert.equal(af.classifyIp("fe80::1%eth0"), "linklocal");
  assert.equal(af.classifyIp("fc00::1"), "private");
  assert.equal(af.classifyIp("::ffff:127.0.0.1"), "loopback"); // IPv4-mapped loopback (dotted)
  assert.equal(af.classifyIp("2606:4700::1111"), "public");
  // IPv4-mapped in HEX form must NOT slip through as public (rewrite-bug guard)
  assert.equal(af.classifyIp("::ffff:7f00:1"), "loopback"); // 127.0.0.1
  assert.equal(af.classifyIp("::ffff:a9fe:a9fe"), "metadata"); // 169.254.169.254
  assert.equal(af.classifyIp("::ffff:c0a8:0101"), "private"); // 192.168.1.1
  assert.equal(af.classifyIp("::7f00:1"), "loopback"); // IPv4-compatible loopback
  // non-canonical / translated forms must fail closed, not resolve to "public"
  assert.equal(af.classifyIp("0:0:0:0:0:0:0:1"), "loopback"); // fully-expanded ::1
  assert.equal(af.classifyIp("0:0:0:0:0:0:0:0"), "unspecified"); // fully-expanded ::
  assert.equal(af.classifyIp("64:ff9b::7f00:1"), "loopback"); // NAT64-embedded 127.0.0.1
  assert.equal(af.classifyIp("64:ff9b::a9fe:a9fe"), "metadata"); // NAT64-embedded metadata
});

// ---- isPrivateName ----
test("isPrivateName: LAN names/IPs yes, loopback no", () => {
  assert.equal(af.isPrivateName("mediabox.local"), true);
  assert.equal(af.isPrivateName("192.168.1.50"), true);
  assert.equal(af.isPrivateName("10.1.2.3"), true);
  assert.equal(af.isPrivateName("localhost"), false); // loopback alias, never a "LAN server"
  assert.equal(af.isPrivateName("box.localhost"), false);
  assert.equal(af.isPrivateName("example.com"), false);
  assert.equal(af.isPrivateName("127.0.0.1"), false);
});

// ---- hostAllowed / urlAllowed ----
test("hostAllowed: subdomains yes, lookalikes/empty no", () => {
  assert.equal(af.hostAllowed(["example.com"], "example.com"), true);
  assert.equal(af.hostAllowed(["example.com"], "api.example.com"), true);
  assert.equal(af.hostAllowed(["example.com"], "notexample.com"), false);
  assert.equal(af.hostAllowed(["example.com"], "example.com.evil.com"), false);
  assert.equal(af.hostAllowed([""], "evil.com."), false); // empty origin must not wildcard (H2)
  assert.equal(af.hostAllowed([""], "evil.com"), false);
});
test("hostAllowed: IP origins match exactly, never as a dotted suffix", () => {
  assert.equal(af.hostAllowed(["192.168.1.50"], "192.168.1.50"), true); // exact IP ok
  assert.equal(af.hostAllowed(["0.0.1"], "10.0.0.1"), false); // IP octets are NOT DNS labels
  assert.equal(af.hostAllowed(["168.1.1"], "192.168.1.1"), false);
  assert.equal(af.hostAllowed(["1"], "10.0.0.1"), false); // ".1" suffix must not match an IP
  assert.equal(af.hostAllowed(["example.com"], "10.0.example.com"), true); // real subdomain still ok
  assert.equal(af.urlAllowed(["0.0.1"], "http://10.0.0.1/").ok, false);
});
test("urlAllowed: empty/blank origins reject (H2)", () => {
  assert.equal(af.urlAllowed([], "https://example.com/").ok, false);
  assert.equal(af.urlAllowed([""], "https://evil.com./").ok, false);
  assert.equal(af.urlAllowed(["  "], "https://evil.com/").ok, false);
});
test("urlAllowed: proto + origin rules", () => {
  assert.equal(af.urlAllowed(["example.com"], "https://example.com/x").ok, true);
  assert.equal(af.urlAllowed(["example.com"], "https://evil.com/x").ok, false);
  assert.equal(af.urlAllowed(["provider.tv"], "http://provider.tv/x").ok, false); // public http
  assert.equal(af.urlAllowed(["192.168.1.50"], "http://192.168.1.50:8080/x").ok, true); // declared LAN http
  assert.equal(af.urlAllowed(["box.local"], "http://box.local/x").ok, true);
  assert.equal(af.urlAllowed(["example.com"], "file:///etc/passwd").ok, false);
});

// ---- resolutionError (the DNS-resolve SSRF gate) ----
test("resolutionError: forbidden resolved categories always rejected", () => {
  const ip = (a) => [{ address: a, family: net4(a) }];
  assert.match(af.resolutionError("evil.com", ip("127.0.0.1")), /forbidden/); // rebinding to loopback
  assert.match(af.resolutionError("box.local", ip("127.0.0.1")), /forbidden/); // .local -> loopback (closes C1)
  assert.match(af.resolutionError("x.com", ip("169.254.169.254")), /forbidden/); // metadata
  assert.match(af.resolutionError("x.com", ip("169.254.1.2")), /forbidden/); // link-local
  assert.match(af.resolutionError("x.com", ip("0.0.0.0")), /forbidden/);
  assert.equal(af.resolutionError("x.com", []), "dns resolution failed");
});
test("resolutionError: private allowed only for a private literal (else rebinding)", () => {
  const ip = (a) => [{ address: a, family: 4 }];
  assert.match(af.resolutionError("public.example", ip("192.168.1.9")), /rebinding/); // public name -> private IP
  assert.equal(af.resolutionError("mediabox.local", ip("192.168.1.9")), null); // declared LAN name -> private OK
  assert.equal(af.resolutionError("192.168.1.9", ip("192.168.1.9")), null);
  assert.equal(af.resolutionError("example.com", ip("8.8.8.8")), null); // public OK
});
function net4(a) {
  return require("node:net").isIPv6(a) ? 6 : 4;
}

// ---- header filters ----
test("sanitizeReqHeaders: keeps allowlisted, drops cookie/host/referer", () => {
  const h = af.sanitizeReqHeaders({
    Accept: "application/json",
    Cookie: "session=abc",
    Host: "evil.com",
    Referer: "https://evil.com",
    "X-Custom": "1",
  });
  assert.equal(h.accept, "application/json");
  assert.equal(h.cookie, undefined);
  assert.equal(h.host, undefined);
  assert.equal(h.referer, undefined);
  assert.equal(h["x-custom"], undefined);
});
test("pickResHeaders: only the safe subset, never set-cookie", () => {
  const out = af.pickResHeaders({ "content-type": "text/xml", "set-cookie": "s=1", "x-secret": "n" });
  assert.equal(out["content-type"], "text/xml");
  assert.equal(out["set-cookie"], undefined);
  assert.equal(out["x-secret"], undefined);
});

// ---- proxy orchestration (injected lookup + transport) ----
const okLookup = (host) => Promise.resolve([{ address: "8.8.8.8", family: 4 }]); // public, safe
function transportOnce(body, headers) {
  return () => Promise.resolve({ status: 200, headers: headers || { "content-type": "text/plain" }, body });
}

test("proxy: blocks an off-allowlist URL without resolving or fetching", async () => {
  let touched = false;
  const r = await af.proxy(
    { origins: ["example.com"], url: "https://evil.com/" },
    { lookup: () => ((touched = true), Promise.resolve([])), transport: () => ((touched = true), Promise.reject()) },
  );
  assert.equal(r.ok, false);
  assert.equal(touched, false);
});

test("proxy: refuses DNS-rebinding (allowed name resolving to loopback) before any fetch", async () => {
  let fetched = false;
  const r = await af.proxy(
    { origins: ["evil.com"], url: "https://evil.com/" },
    {
      lookup: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      transport: () => ((fetched = true), Promise.resolve({ status: 200, headers: {}, body: "x" })),
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /forbidden/);
  assert.equal(fetched, false);
});

test("proxy: success returns body + safe headers", async () => {
  const r = await af.proxy(
    { origins: ["example.com"], url: "https://example.com/x" },
    { lookup: okLookup, transport: transportOnce("hello", { "content-type": "text/plain", "set-cookie": "x=1" }) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.body, "hello");
  assert.equal(r.headers["content-type"], "text/plain");
  assert.equal(r.headers["set-cookie"], undefined);
});

test("proxy: follows an allowed redirect, re-guards, and drops Authorization on host change", async () => {
  const seen = [];
  const transport = (url, o) => {
    seen.push({ url, auth: o.headers.authorization });
    if (url === "https://example.com/a")
      return Promise.resolve({ status: 302, headers: {}, body: "", location: "https://api.other.com/b" });
    return Promise.resolve({ status: 200, headers: { "content-type": "text/plain" }, body: "final" });
  };
  const r = await af.proxy(
    { origins: ["example.com", "other.com"], url: "https://example.com/a", headers: { Authorization: "Bearer T" } },
    { lookup: okLookup, transport },
  );
  assert.equal(r.ok, true);
  assert.equal(r.body, "final");
  assert.equal(seen[0].auth, "Bearer T"); // sent to the original host
  assert.equal(seen[1].auth, undefined); // dropped on the cross-host redirect (M3)
});

test("proxy: refuses a redirect that leaves the allowlist", async () => {
  const transport = () => Promise.resolve({ status: 302, headers: {}, body: "", location: "https://evil.com/x" });
  const r = await af.proxy({ origins: ["example.com"], url: "https://example.com/a" }, { lookup: okLookup, transport });
  assert.equal(r.ok, false);
  assert.match(r.error, /origins/);
});

test("proxy: rejects disallowed method and oversized body without side effects", async () => {
  let touched = false;
  const dep = {
    lookup: () => ((touched = true), Promise.resolve([])),
    transport: () => ((touched = true), Promise.reject()),
  };
  assert.equal((await af.proxy({ origins: ["x.com"], url: "https://x.com/", method: "DELETE" }, dep)).ok, false);
  assert.equal(
    (
      await af.proxy(
        { origins: ["x.com"], url: "https://x.com/", method: "POST", body: "x".repeat(af.MAX_REQ_BYTES + 1) },
        dep,
      )
    ).ok,
    false,
  );
  assert.equal(touched, false);
});

test("proxy: caps redirects", async () => {
  const transport = (url) =>
    Promise.resolve({ status: 302, headers: {}, body: "", location: "https://example.com/next" });
  const r = await af.proxy({ origins: ["example.com"], url: "https://example.com/a" }, { lookup: okLookup, transport });
  assert.equal(r.ok, false);
  assert.match(r.error, /too many redirects/);
});

// ---- realTransport against a live local server (functional, this runtime) ----
test("realTransport: fetches a local server pinned to 127.0.0.1", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(af.MAX_RES_BYTES + 1024));
      return;
    }
    if (req.url === "/redir") {
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("live-body");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const addr = [{ address: "127.0.0.1", family: 4 }];
  const call = (path) =>
    af.realTransport("http://127.0.0.1:" + port + path, {
      method: "GET",
      headers: {},
      addresses: addr,
      maxBytes: af.MAX_RES_BYTES,
      timeoutMs: 5000,
    });
  try {
    const ok = await call("/ok");
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "live-body");

    const redir = await call("/redir");
    assert.equal(redir.status, 302);
    assert.equal(redir.location, "/ok"); // transport does NOT follow; proxy re-guards

    await assert.rejects(() => call("/big"), /too large/); // size cap enforced on the wire
  } finally {
    server.close();
  }
});
