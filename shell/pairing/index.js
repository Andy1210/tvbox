// tvbox phone pairing - a small, on-demand config server on the LAN so you can
// set things up from your phone (real keyboard, camera, file picker) instead of
// on the TV. The TV shows a QR (short URL + 4-digit code); the phone opens the
// page and submits. Every write carries the 4-digit code shown on the TV (the QR
// pre-fills it) so a stray LAN device can't drive the box. The server runs only
// while pairing and auto-stops on success or after a timeout.
//
// This module is the GENERIC infrastructure only: server lifecycle, the code
// gate, QR/URL, and a page-template renderer. The actual pages are APP-SPECIFIC
// and live in pairing/<kind>.js providers (with pages/<kind>.html), registered
// via register() - core registers the built-in ones, plugins register theirs.
// A provider is { page(ctx) -> html, routes: { "METHOD /sub": handler | {handler,maxBody,bulk} }, v2? }.
//
// `v2: true` says the provider's page follows the seal.js contract: it reads the
// code from the URL fragment and authenticates every request itself. The QR then
// carries the code only in the fragment. A provider without it (a page written
// before) gets the code in the query as well, which is where such a page reads it.
// The shell's own providers are all v2.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const netguard = require("../netguard"); // shared lanIp (the QR must show the box's LAN address)
const apigate = require("../apigate"); // the Host check
const seal = require("./seal"); // end-to-end sealed bodies (key in the QR fragment)

let PORT = 8099; // a test moves it off a port the dev host may already use
const TTL_MS = 5 * 60 * 1000;
const MAX_FAILS = 8; // stop the server after this many wrong codes (anti-brute-force)
const PAGES_DIR = path.join(__dirname, "pages");
const DEFAULT_MAX_BODY = 1e5; // per-write body cap; a provider route can raise it (e.g. photo uploads)

// kind -> { page, routes }. Registered by core (built-in kinds) or by plugins.
// `owner` is the app whose plugin registered the kind (null for a built-in
// one), which is what decides which app's screen may open it.
const providers = new Map();
function register(kind, provider, owner) {
  if (!kind || !provider || typeof provider.page !== "function")
    throw new Error("pairing.register: bad provider for '" + kind + "'");
  providers.set(kind, {
    page: provider.page,
    routes: provider.routes || {},
    owner: owner || null,
    v2: provider.v2 === true || !owner,
  });
}

// The kind start() would really open for `kind`, the same fallback included.
function resolveKind(kind) {
  return providers.has(kind) ? kind : providers.has("iptv") ? "iptv" : providers.keys().next().value || null;
}

/** Who registered the kind start(kind) would open: an app id, null for built-in, undefined for none. */
function ownerOf(kind) {
  const k = resolveKind(kind);
  return k ? providers.get(k).owner : undefined;
}

let server = null;
let code = null;
let timer = null;
let fails = 0;
let activeKind = null;
let activeLocale = "en";
let pageOpened = false;
let sessionKey = null; // this session's sealing key; travels only in the QR URL fragment
let seenNonces = new Set(); // sealed bodies and signed writes already accepted, so one cannot be replayed
let sealedSeen = false; // this session's phone has proved the key, so unauthenticated plain writes are refused

function armTimeout() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(stop, TTL_MS);
}

// A wrong answer counts toward the lockout: the 4-digit code alone is guessable,
// the lockout + short TTL is what makes it safe.
function failed() {
  if (++fails >= MAX_FAILS) {
    console.warn("[pairing] too many wrong codes - stopping");
    stop();
  }
}

// A request that proved itself extends the window (active use); wrong ones DON'T,
// so an attacker cannot hold it open.
function proved() {
  fails = 0;
  armTimeout();
}

// Timing-safe code check. An EMPTY code is not an attempt: a page that could not
// find the code (an older page opened from a URL that carries it elsewhere) would
// otherwise lock the session out by loading its own lists.
function codeOk(presented) {
  if (!code) return false;
  const p = presented == null ? "" : String(presented);
  if (!p) return false;
  const a = Buffer.from(p);
  const b = Buffer.from(code);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    proved();
    return true;
  }
  failed();
  return false;
}

// A request carrying the page's MAC (seal.js). Answers null when it carries none,
// else whether it verified. A write must also carry a nonce not seen before.
//
// A MAC that does not verify is not a guess at the code: a 128-bit MAC cannot be
// guessed, so a mismatch is a page that signed something other than what it sent,
// and counting it would turn that into a lockout. A GET can be replayed by
// whoever saw it, so only a fresh write keeps the session open.
function signedOk(req, method, raw, u, isWrite) {
  if (!seal.splitMac(req.url)) return null;
  let ok = !!sessionKey && seal.macOk(sessionKey, method, req.url, raw);
  if (ok && isWrite) {
    const n = u.searchParams.get("n");
    if (!n || !/^[A-Za-z0-9_-]{8,32}$/.test(n) || seenNonces.has("n:" + n)) ok = false;
    else seenNonces.add("n:" + n);
  }
  if (!ok) return false;
  sealedSeen = true;
  if (isWrite) proved();
  return true;
}

// Render a page template file with {{token}} substitution (missing token -> "").
function renderPage(name, vars) {
  const tpl = fs.readFileSync(path.join(PAGES_DIR, name), "utf8");
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}

function jsonRes(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// The context every provider page() + route handler receives.
function baseCtx(u) {
  return {
    locale: activeLocale,
    render: renderPage,
    json: jsonRes,
    query: u.searchParams,
    stopSoon: (ms) => setTimeout(stop, ms || 1500),
  };
}

function handle(req, res) {
  // A name that is not the box's is a page on some other site rebound to this
  // address (see apigate.hostAllowed).
  if (!apigate.lanHostAllowed(req, PORT)) {
    res.writeHead(421);
    return res.end();
  }
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "GET" && u.pathname === "/tvbox-seal.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(seal.script());
  }
  const prov = providers.get(activeKind);
  if (!prov) {
    res.writeHead(503);
    return res.end("no active pairing kind");
  }
  const ctx = baseCtx(u);
  const entry = prov.routes[req.method + " " + u.pathname];
  if (!entry) {
    // no matching route -> serve the provider's page (GET /), ungated
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(prov.page(ctx));
      pageOpened = true;
    } catch (e) {
      console.warn("[pairing] page render:", e.message);
      res.writeHead(500);
      res.end();
    }
    return;
  }
  const handler = typeof entry === "function" ? entry : entry.handler;
  const maxBody = (typeof entry === "object" && entry.maxBody) || DEFAULT_MAX_BODY;
  // A bulk route (a photo, a ROM chunk) takes a plain body authenticated by the
  // page's MAC, because sealing megabytes twice over on a phone buys little.
  // Only a route that says so: anything else carries its body sealed.
  const bulk = typeof entry === "object" && entry.bulk === true;
  if (req.method === "GET") {
    // A data GET (a list, a thumbnail): the page's MAC, or the code in the query.
    const signed = signedOk(req, "GET", Buffer.alloc(0), u, false);
    if (signed === false || (signed === null && !codeOk(u.searchParams.get("c")))) {
      res.writeHead(403);
      return res.end();
    }
    try {
      handler(req, res, ctx);
    } catch (e) {
      console.warn("[pairing] route:", e.message);
      res.writeHead(500);
      res.end();
    }
    return;
  }
  // body-bearing write: read (capped) as bytes, since a MAC covers the exact
  // bytes and a multi-byte character may straddle two chunks.
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    // A sealed body is base64, a third larger than what it carries.
    if (size > Math.ceil(maxBody * 1.4) + 1024) return req.destroy();
    chunks.push(c);
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const body = raw.toString("utf8");
    let d = {};
    try {
      d = JSON.parse(body || "{}");
    } catch (e) {}
    if (!d || typeof d !== "object" || Array.isArray(d)) d = {};
    const isSealed = typeof d.sealed === "string";
    if (!isSealed && raw.length > maxBody) {
      res.writeHead(413, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "too large" }));
    }
    const refuse = (status, error) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error }));
    };
    let allowed;
    if (isSealed) {
      const opened = seal.open(d.sealed, sessionKey, seenNonces);
      if (!opened) return refuse(400, "sealed");
      // The route the page sealed it for. A v2 page always names it, so a body
      // lifted off one request cannot be sent to another route.
      const route = req.method + " " + u.pathname;
      if (opened._r !== undefined ? opened._r !== route : prov.v2) return refuse(400, "sealed-route");
      delete opened._r;
      d = opened;
      sealedSeen = true;
      allowed = codeOk(d.code != null ? d.code : u.searchParams.get("c"));
    } else if (seal.splitMac(req.url)) {
      // A signed plain body is for a bulk route only: anything else may carry a
      // secret, and goes sealed.
      if (!bulk) return refuse(403, "sealed-required");
      allowed = signedOk(req, req.method, raw, u, true);
    } else if (sealedSeen) {
      // The phone in this session has the key. An unauthenticated write now is not it.
      return refuse(403, "sealed-required");
    } else {
      allowed = codeOk(d.code != null ? d.code : u.searchParams.get("c"));
    }
    if (!allowed) return refuse(403, "code");
    // A handler may be async (the restore one renames the box before applying).
    // Without following the promise, a rejection after the first await would go
    // unhandled and the phone would sit on a request that never answers. Only
    // answer if nothing was sent yet - a handler that already replied and then
    // threw must not have a second response written over it.
    const fail = (e) => {
      console.warn("[pairing] route:", e && e.message);
      if (res.headersSent) return res.end();
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    };
    try {
      const r = handler(req, res, { ...ctx, body: d });
      if (r && typeof r.catch === "function") r.catch(fail);
    } catch (e) {
      fail(e);
    }
  });
}

function start(locale, kind) {
  code = String(crypto.randomInt(1000, 10000));
  activeLocale = locale === "hu" ? "hu" : "en"; // default en; hu when the launcher runs Hungarian
  activeKind = resolveKind(kind);
  fails = 0;
  pageOpened = false;
  sessionKey = seal.newKey();
  seenNonces = new Set();
  sealedSeen = false;
  if (!server) {
    server = http.createServer(handle);
    server.on("error", (e) => console.warn("[pairing] server error:", e.message));
    server.listen(PORT, "0.0.0.0", () => console.log("[pairing] listening on :" + PORT));
  }
  armTimeout();
  const ip = netguard.lanIp() || "127.0.0.1"; // no external IPv4: a useless-but-valid QR beats a broken one
  // The code and the key ride in the fragment: a browser never sends that part
  // of a URL, so they go from the QR to the page without crossing the network.
  // A page written before that reads the code from the query, so for its
  // provider the code goes there too - its limit, not the session's.
  const k = seal.keyParam(sessionKey);
  const v2 = !!(activeKind && providers.get(activeKind) && providers.get(activeKind).v2);
  const url = v2 ? `http://${ip}:${PORT}/#c=${code}&k=${k}` : `http://${ip}:${PORT}/?c=${code}#k=${k}`;
  return { url, shortUrl: `http://${ip}:${PORT}`, ip, port: PORT, code };
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  code = null;
  sessionKey = null;
  sealedSeen = false;
  seenNonces = new Set();
  if (server) {
    try {
      server.close();
    } catch (e) {}
    server = null;
    console.log("[pairing] stopped");
  }
}

module.exports = {
  start,
  stop,
  register,
  ownerOf,
  phoneConnected: () => pageOpened,
  _setPortForTest: (p) => (PORT = p),
};
