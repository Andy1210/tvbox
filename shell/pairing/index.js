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
// A provider is { page(ctx) -> html, routes: { "METHOD /sub": handler | {handler,maxBody} } }.
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 8099;
const TTL_MS = 5 * 60 * 1000;
const MAX_FAILS = 8; // stop the server after this many wrong codes (anti-brute-force)
const PAGES_DIR = path.join(__dirname, "pages");
const DEFAULT_MAX_BODY = 1e5; // per-write body cap; a provider route can raise it (e.g. photo uploads)

// kind -> { page, routes }. Registered by core (built-in kinds) or by plugins.
const providers = new Map();
function register(kind, provider) {
  if (!kind || !provider || typeof provider.page !== "function")
    throw new Error("pairing.register: bad provider for '" + kind + "'");
  providers.set(kind, { page: provider.page, routes: provider.routes || {} });
}

let server = null;
let code = null;
let timer = null;
let fails = 0;
let activeKind = null;
let activeLocale = "en";
let pageOpened = false; // the phone has loaded the current session's page (e.g. to auto-advance the TV)

function lanIp() {
  const ifs = os.networkInterfaces();
  let fallback = null;
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === "IPv4" && !a.internal) {
        if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
        fallback = fallback || a.address;
      }
    }
  }
  return fallback || "127.0.0.1";
}

function armTimeout() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(stop, TTL_MS);
}

// Timing-safe code check that gates every write (and data GETs). A correct code
// extends the window (active use); wrong codes DON'T (so an attacker can't hold
// it open) and trip a lockout after MAX_FAILS - the 4-digit code alone is
// guessable, the lockout + short TTL is what makes it safe.
function codeOk(presented) {
  if (!code) return false;
  const a = Buffer.from(String(presented || ""));
  const b = Buffer.from(code);
  const good = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (good) {
    fails = 0;
    armTimeout();
    return true;
  }
  if (++fails >= MAX_FAILS) {
    console.warn("[pairing] too many wrong codes - stopping");
    stop();
  }
  return false;
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
  const u = new URL(req.url, `http://localhost:${PORT}`);
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
  if (req.method === "GET") {
    // data GET (e.g. list/thumbnail): gate by the ?c= code
    if (!codeOk(u.searchParams.get("c"))) {
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
  // body-bearing write: read (capped), gate by the code (in body or query), dispatch
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > maxBody) req.destroy();
  });
  req.on("end", () => {
    let d = {};
    try {
      d = JSON.parse(body || "{}");
    } catch (e) {}
    const presented = d.code != null ? d.code : u.searchParams.get("c");
    if (!codeOk(presented)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "code" }));
    }
    try {
      handler(req, res, { ...ctx, body: d });
    } catch (e) {
      console.warn("[pairing] route:", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    }
  });
}

function start(locale, kind) {
  code = String(crypto.randomInt(1000, 10000));
  activeLocale = locale === "hu" ? "hu" : "en"; // default en; hu when the launcher runs Hungarian
  activeKind = providers.has(kind) ? kind : providers.has("iptv") ? "iptv" : providers.keys().next().value || null;
  fails = 0;
  pageOpened = false;
  if (!server) {
    server = http.createServer(handle);
    server.on("error", (e) => console.warn("[pairing] server error:", e.message));
    server.listen(PORT, "0.0.0.0", () => console.log("[pairing] listening on :" + PORT));
  }
  armTimeout();
  const ip = lanIp();
  return { url: `http://${ip}:${PORT}/?c=${code}`, shortUrl: `http://${ip}:${PORT}`, ip, port: PORT, code };
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  code = null;
  if (server) {
    try {
      server.close();
    } catch (e) {}
    server = null;
    console.log("[pairing] stopped");
  }
}

module.exports = { start, stop, register, phoneConnected: () => pageOpened };
