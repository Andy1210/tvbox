// tvbox capability: scoped server-side fetch ("data proxy").
//
// Why it exists: a sandboxed app (the isolated window) can't do cross-origin
// requests (CORS) or parse a big XMLTV/M3U feed comfortably - the only reason a
// Live-TV-class app needs shell-side help today (playback already goes through
// the app-agnostic `player` capability). This broker lets an app whose manifest
// declares `capabilities: ["fetch"]` GET/POST to the hosts it declared in
// `runtime.origins`, and nothing else.
//
// SECURITY (this file is the SSRF boundary - see SECURITY.md / docs/capabilities.md):
// the broker runs in the Electron MAIN process, so an unguarded request would
// originate from the box's own loopback and could hit the unauthenticated local
// API on :8097 (reboot, parental PIN, app install) or any LAN host. So every
// request is guarded by RESOLVED IP, not just by name:
//   1. urlAllowed - the URL host must equal/subdomain a NON-EMPTY declared
//      origin; https always, plain http only to a declared private/LAN name.
//   2. resolve the host (dns.lookup, all addresses) and classify each IP:
//      loopback / link-local / metadata / unspecified are ALWAYS refused (this
//      is what stops "origins:[127.0.0.1]" and a "*.local" that resolves to
//      loopback); a private/CGNAT IP is allowed only when the declared literal
//      host is itself private (a LAN server the user opted into) - a public name
//      resolving to a private IP is DNS-rebinding and is refused.
//   3. PIN the connection to those vetted IPs (custom `lookup`), so the socket
//      can't be re-resolved to a different address (no TOCTOU).
// Plus: no ambient credentials (cookies never sent, Set-Cookie never returned),
// a request/response header allowlist, Authorization dropped across a host
// change, and capped body size / timeout / redirects (each hop re-guarded).
//
// The pure guards (classifyIp/urlAllowed/resolutionError/sanitizeReqHeaders/…)
// and the real transport (against a local server) are unit-tested in
// appfetch.test.js; proxy() takes injectable lookup+transport for tests.
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");

const MAX_RES_BYTES = 5 * 1024 * 1024; // 5 MB response cap
const MAX_REQ_BYTES = 256 * 1024; // 256 KB request-body cap
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;
const METHODS = ["GET", "POST", "HEAD"];

// Request headers an app may set. Everything else (Cookie, Host, Referer,
// Proxy-*, …) is dropped. Authorization is allowed to the app's OWN declared
// origin but stripped when a redirect changes host (see proxy).
const REQ_HEADER_ALLOW = new Set(["accept", "accept-language", "content-type", "authorization", "range", "user-agent"]);
// Response headers passed back to the app. Set-Cookie is intentionally absent.
const RES_HEADER_ALLOW = new Set([
  "content-type",
  "content-length",
  "content-range",
  "last-modified",
  "etag",
  "date",
  "cache-control",
]);

// Normalize a hostname for comparison/classification: lowercase, strip one
// trailing dot (FQDN root), strip IPv6 brackets and any zone id.
function normHost(h) {
  let s = String(h || "").toLowerCase();
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  return s;
}

// Pull the embedded IPv4 out of an IPv4-mapped/-compatible/NAT64 IPv6 address
// (`::ffff:x`, `::x`, or the `64:ff9b::/96` well-known NAT64 prefix), in dotted
// OR hex-group form. Returns "a.b.c.d" or null. These ranges aren't publicly
// routable as-is, so treating any match as its embedded v4 fails closed.
function embeddedV4(s) {
  const m = /^(?:::(?:ffff:)?|64:ff9b::)([0-9a-f.:]+)$/i.exec(s);
  if (!m) return null;
  const tail = m[1];
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(tail)) return tail; // dotted: ::ffff:127.0.0.1
  const g = tail.split(":");
  if (g.length === 2 && g.every((h) => /^[0-9a-f]{1,4}$/i.test(h))) {
    const hi = parseInt(g[0], 16);
    const lo = parseInt(g[1], 16);
    return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join("."); // hex: ::ffff:7f00:1
  }
  return null;
}

// Classify a literal IP address into a trust category. Returns one of
// "loopback" | "linklocal" | "metadata" | "unspecified" | "private" | "public".
// Non-IP input returns "" (caller treats a name, not an address).
function classifyIp(ip) {
  const s = normHost(ip);
  if (net.isIPv4(s)) {
    const o = s.split(".").map(Number);
    if (o[0] === 0) return "unspecified"; // 0.0.0.0/8 "this host"
    if (o[0] === 127) return "loopback"; // 127.0.0.0/8
    if (o[0] === 169 && o[1] === 254) return o[2] === 169 && o[3] === 254 ? "metadata" : "linklocal"; // 169.254/16
    if (o[0] === 10) return "private";
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "private";
    if (o[0] === 192 && o[1] === 168) return "private";
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return "private"; // 100.64/10 CGNAT
    return "public";
  }
  if (net.isIPv6(s)) {
    // canonical + fully-expanded / non-canonical zero forms of ::1 and ::
    if (s === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(s)) return "loopback";
    if (s === "::" || /^(0{1,4}:){7}0{1,4}$/.test(s)) return "unspecified";
    // IPv4-mapped (::ffff:…) / -compatible (::…) / NAT64 (64:ff9b::…) - extract
    // the embedded IPv4 in ANY form (dotted "::ffff:127.0.0.1" OR hex
    // "::ffff:7f00:1") and classify it. Missing these would let a hostname
    // resolving to the encoded loopback/metadata address slip through as public.
    const v4 = embeddedV4(s);
    if (v4) return classifyIp(v4);
    if (/^fe[89ab]/.test(s)) return "linklocal"; // fe80::/10
    if (/^f[cd]/.test(s)) return "private"; // fc00::/7 unique-local
    if (/^fec/.test(s)) return "private"; // deprecated site-local, treat as private
    return "public";
  }
  return "";
}

// A declared literal host that legitimately denotes a private/LAN target the
// user opted into (a LAN name or a private IP) - but NEVER loopback/localhost,
// which is only ever the box itself.
function isPrivateName(host) {
  const h = normHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return false; // loopback alias - never a "LAN server"
  if (h.endsWith(".local")) return true; // mDNS LAN name
  const cat = classifyIp(h);
  return cat === "private"; // a private IP literal (not loopback/linklocal/metadata)
}

// host matches a declared origin exactly or as a subdomain. Empty/blank origins
// never match (an "" entry must not become a universal ".<anything>" wildcard).
function hostAllowed(origins, hostname) {
  const n = normHost(hostname);
  if (!n) return false;
  return origins.some((o) => {
    const oo = normHost(o);
    return oo && (n === oo || n.endsWith("." + oo));
  });
}

// Validate a candidate URL against an app's declared origins (name + protocol
// only; IP classification happens after DNS resolution). Returns
// { ok:true, url } or { ok:false, reason }.
function urlAllowed(origins, urlStr) {
  const clean = (Array.isArray(origins) ? origins : []).map(normHost).filter(Boolean);
  if (clean.length === 0) return { ok: false, reason: "no declared origins" };
  let u;
  try {
    u = new URL(String(urlStr));
  } catch (e) {
    return { ok: false, reason: "unparseable url" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "protocol must be http(s)" };
  const host = normHost(u.hostname);
  // plain http only to a declared private/LAN name (never a public host)
  if (u.protocol === "http:" && !isPrivateName(host)) return { ok: false, reason: "http allowed only to LAN hosts" };
  if (!hostAllowed(clean, host)) return { ok: false, reason: "host not in declared origins" };
  return { ok: true, url: u };
}

// Given a literal host and its resolved addresses, decide whether we may
// connect. Returns null when safe, or a rejection reason string.
function resolutionError(literalHost, addresses) {
  const ips = (addresses || []).map((a) => (typeof a === "string" ? a : a && a.address)).filter(Boolean);
  if (ips.length === 0) return "dns resolution failed";
  const literalPrivate = isPrivateName(literalHost);
  for (const ip of ips) {
    const cat = classifyIp(ip);
    if (cat === "loopback" || cat === "linklocal" || cat === "metadata" || cat === "unspecified") {
      return "resolves to a forbidden address (" + cat + ")";
    }
    if (cat === "private" && !literalPrivate) {
      return "public host resolves to a private address (rebinding)"; // DNS-rebinding
    }
  }
  return null;
}

// Keep only allowlisted request headers (case-insensitive keys).
function sanitizeReqHeaders(headers) {
  const out = {};
  if (headers && typeof headers === "object") {
    for (const k of Object.keys(headers)) {
      if (REQ_HEADER_ALLOW.has(k.toLowerCase())) out[k.toLowerCase()] = String(headers[k]);
    }
  }
  return out;
}

// Subset of response headers handed back to the app (plain object, lowercased).
function pickResHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const src = typeof headers.entries === "function" ? headers : Object.entries(headers);
  const it = typeof headers.entries === "function" ? headers.entries() : src;
  for (const [k, v] of it) {
    if (RES_HEADER_ALLOW.has(String(k).toLowerCase())) out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

// Promisified dns.lookup(all) - returns [{address, family}].
function lookupAll(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addrs) => resolve(err ? [] : addrs));
  });
}

// A `lookup` implementation (net/tls signature) that returns ONLY the given
// vetted addresses, so the socket connects exactly where we classified - no
// re-resolution, no TOCTOU.
function pinnedLookup(addresses) {
  const list = addresses.map((a) => ({ address: a.address, family: a.family || (net.isIPv6(a.address) ? 6 : 4) }));
  return function (hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (options && options.all) return callback(null, list);
    const first = list[0];
    return callback(null, first.address, first.family);
  };
}

// Real transport: one HTTP(S) request pinned to `addresses`, NOT following
// redirects (proxy() re-guards each hop). Enforces the response size cap and a
// timeout. Returns { status, headers, body, location }. `deps.request` is
// injectable for tests; defaults to node http/https.
function realTransport(reqUrl, o, deps) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(reqUrl);
    } catch (e) {
      return reject(new Error("bad url"));
    }
    const lib = u.protocol === "https:" ? https : http;
    const requestFn = (deps && deps.request) || lib.request;
    const headers = Object.assign({}, o.headers, {
      // force uncompressed so we never have to decompress; keep it simple + safe
      "accept-encoding": "identity",
      connection: "close",
    });
    const req = requestFn(
      u,
      {
        method: o.method,
        headers,
        lookup: pinnedLookup(o.addresses),
        // https: validate the cert against the real hostname (SNI), while the
        // socket connects to the pinned IP via `lookup`.
        servername: u.hostname,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume(); // drain
          return resolve({ status, headers: {}, body: "", location: res.headers.location || null });
        }
        if (o.method === "HEAD") {
          res.resume();
          return resolve({ status, headers: res.headers, body: "" });
        }
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          total += c.length;
          if (total > o.maxBytes) {
            req.destroy();
            reject(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => reject(e));
      },
    );
    req.on("error", (e) => reject(e));
    req.setTimeout(o.timeoutMs, () => req.destroy(new Error("timeout")));
    if (o.body != null && o.method === "POST") req.write(o.body);
    req.end();
  });
}

// Perform the guarded request. `opts`: { origins, url, method?, headers?, body? }.
// `deps` (tests): { lookup, transport }. Returns { ok, status, headers, body }
// or { ok:false, error }.
async function proxy(opts, deps) {
  const lookup = (deps && deps.lookup) || lookupAll;
  const transport = (deps && deps.transport) || realTransport;
  const origins = opts.origins || [];
  const method = String(opts.method || "GET").toUpperCase();
  if (!METHODS.includes(method)) return { ok: false, error: "method not allowed" };

  let body;
  if (opts.body != null && method === "POST") {
    body = String(opts.body);
    if (Buffer.byteLength(body, "utf8") > MAX_REQ_BYTES) return { ok: false, error: "request body too large" };
  }
  let headers = sanitizeReqHeaders(opts.headers);
  let prevHost = null;

  let current = opts.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = urlAllowed(origins, current);
    if (!check.ok) return { ok: false, error: check.reason };
    const host = check.url.hostname;

    // Drop Authorization once the target host changes (don't replay a bearer to
    // a different declared origin across a redirect).
    if (prevHost && normHost(host) !== normHost(prevHost) && "authorization" in headers) {
      headers = { ...headers };
      delete headers.authorization;
    }
    prevHost = host;

    const addrs = await lookup(host);
    const resErr = resolutionError(host, addrs);
    if (resErr) return { ok: false, error: resErr };

    let res;
    try {
      res = await transport(check.url.href, {
        method,
        headers,
        body,
        addresses: addrs,
        maxBytes: MAX_RES_BYTES,
        timeoutMs: TIMEOUT_MS,
      });
    } catch (e) {
      return { ok: false, error: "fetch failed: " + (e && e.message ? e.message : String(e)) };
    }

    if (res.status >= 300 && res.status < 400) {
      if (!res.location) return { ok: false, error: "redirect without location" };
      try {
        current = new URL(res.location, check.url).href;
      } catch (e) {
        return { ok: false, error: "bad redirect location" };
      }
      continue;
    }
    return { ok: true, status: res.status, headers: pickResHeaders(res.headers), body: res.body || "" };
  }
  return { ok: false, error: "too many redirects" };
}

module.exports = {
  urlAllowed,
  hostAllowed,
  classifyIp,
  isPrivateName,
  resolutionError,
  sanitizeReqHeaders,
  pickResHeaders,
  pinnedLookup,
  realTransport,
  proxy,
  MAX_RES_BYTES,
  MAX_REQ_BYTES,
  TIMEOUT_MS,
  MAX_REDIRECTS,
  METHODS,
};
