// tvbox network trust classification - the ONE place that decides what counts
// as loopback / link-local / private LAN / public. Grown out of appfetch.js's
// SSRF classifier (the strongest of three near-duplicate copies that had
// drifted across appfetch.js, updater.js and main.js) so every guard keys off
// the same address logic instead of its own regex subset.
//
// Two DIFFERENT trust questions share these primitives - don't conflate them:
//   • isPrivateName (SSRF flavor - the appfetch broker): a declared literal
//     host that legitimately denotes a LAN service the user opted into. NEVER
//     loopback - for a request broker running in the main process, loopback is
//     the box itself (the unauthenticated :8097 control API).
//   • isLanHost / isLanUrl (self-hosted flavor - updater feed, install
//     sources, remote-app pages): "may this be plain http instead of https?".
//     That's the box owner's own infrastructure, so loopback and localhost ARE
//     trusted here.
const net = require("net");
const os = require("os");

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
// which is only ever the box itself. This is the SSRF-side rule (appfetch).
function isPrivateName(host) {
  const h = normHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return false; // loopback alias - never a "LAN server"
  if (h.endsWith(".local")) return true; // mDNS LAN name
  const cat = classifyIp(h);
  return cat === "private"; // a private IP literal (not loopback/linklocal/metadata)
}

// A host we treat as the box owner's own infrastructure (the self-hosted trust
// rule): loopback/localhost, an mDNS LAN name, or a private/link-local address.
// Used where plain http is acceptable INSTEAD of https (update feed, install
// sources, remote-app URLs) - never for broker SSRF decisions (isPrivateName).
function isLanHost(host) {
  const h = normHost(host);
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const cat = classifyIp(h);
  return cat === "loopback" || cat === "private" || cat === "linklocal";
}

// An http:// URL pointing at the owner's own LAN/loopback infrastructure.
// Unparseable or non-http input is false - callers pair this with their own
// explicit https check ("https anywhere, or LAN http").
function isLanUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "http:" && isLanHost(x.hostname);
  } catch (e) {
    return false;
  }
}

// The self-hosted fetcher trust rule as a URL predicate: https to ANY host, or
// plain http only to the owner's own LAN/loopback infra. The updater feed, the
// app registry and package/download fetches all share this one rule instead of
// each re-deriving it from a local regex. Parses the URL (not a prefix test) so
// a malformed override like "https://" is rejected here - and falls back to the
// shipped default - instead of being accepted and only failing later at fetch().
function isAllowedFetchUrl(u) {
  let x;
  try {
    x = new URL(String(u));
  } catch (e) {
    return false;
  }
  if (x.protocol === "https:") return true; // https to any host
  if (x.protocol === "http:") return isLanHost(x.hostname); // plain http only to LAN/loopback
  return false;
}

// fetch() that follows redirects MANUALLY, re-validating every hop. undici's
// default redirect:"follow" only checks the FIRST url, so a 3xx from a vetted
// feed/registry/download could bounce the request onto an internal address
// (metadata/link-local/arbitrary host) - classic SSRF-via-redirect. This
// mirrors appfetch's "re-guard each hop" stance for the non-broker fetchers so
// the guards can't drift apart. An https chain must additionally STAY https:
// http is accepted only when the request already started as http+LAN, so a
// public https feed can never be redirected down onto http://127.0.0.1/ (the
// box's own control API) or the http metadata service. An origin-pinned caller
// (a package fetch confined to the registry origin) can pass `init.allow`, an
// extra per-hop predicate applied to EVERY target - so a compromised/MITM'd
// registry can't 3xx a pinned fetch off its origin, matching the pin the caller
// documents. `impl` is injectable for tests (defaults to the global fetch).
// Throws on a disallowed target (initial OR redirect) and past `maxRedirects`
// (default 5) hops.
async function guardedFetch(url, init, impl) {
  const doFetch = impl || fetch;
  const opts = { ...(init || {}) };
  const maxRedirects = opts.maxRedirects == null ? 5 : opts.maxRedirects;
  const extraAllow = opts.allow; // optional per-call confinement, e.g. an origin pin
  delete opts.maxRedirects;
  delete opts.allow;
  let target = String(url);
  const noDowngrade = /^https:\/\//i.test(target); // an https chain may not drop to http on any hop
  const allowed = (u) =>
    isAllowedFetchUrl(u) && (!noDowngrade || /^https:\/\//i.test(u)) && (!extraAllow || extraAllow(u));
  for (let hop = 0; ; hop++) {
    if (!allowed(target)) throw new Error("blocked url (need https, or LAN http with no downgrade): " + target);
    const res = await doFetch(target, { ...opts, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 && res.headers && res.headers.get("location");
    if (!loc) return res;
    if (hop >= maxRedirects) throw new Error("too many redirects");
    target = new URL(loc, target).toString();
  }
}

// The box's LAN IPv4 (prefer a private address; skip loopback/virtual).
// Returns "" when the box has no external IPv4 - callers pick their own
// fallback (pairing shows 127.0.0.1, About shows nothing).
function lanIp() {
  const ifs = os.networkInterfaces();
  let fallback = "";
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === "IPv4" && !a.internal) {
        if (classifyIp(a.address) === "private") return a.address;
        fallback = fallback || a.address;
      }
    }
  }
  return fallback;
}

module.exports = { normHost, classifyIp, isPrivateName, isLanHost, isLanUrl, isAllowedFetchUrl, guardedFetch, lanIp };
