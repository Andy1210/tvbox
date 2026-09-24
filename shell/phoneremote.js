// A phone acting as the remote, on the LAN.
//
// This is the one surface on the box that injects keys into whatever is on
// screen, so most of what follows is about who is allowed to ask.
//
// WHY IT LISTENS AT ALL. Every other phone flow here is a pairing session: the
// TV shows a QR, the phone does one job, the server stops. That model cannot
// carry a remote, because opening the QR needs the remote you are trying to
// replace. So a phone is ADOPTED once - with a code shown on the TV, which keeps
// "you were in the room" as the thing that grants access - and afterwards
// reconnects on its own. The listener is therefore persistent, and that is
// exactly why it is opt-in and off until someone turns it on: a box nobody asked
// gains no new surface.
//
// WHAT A PHONE HOLDS. A 32-byte key of its own, handed over once at adoption and
// never sent again: every request carries an HMAC under it (seal.js) over the
// method, the URL and the body, plus a time and a nonce, so a request read off
// the air can neither be altered, replayed nor turned into a different one. The
// adoption itself is sealed with a one-time key the TV's QR carries in its URL
// fragment, and a screen frame goes back sealed under the phone's key. The box
// keeps the key in config.json (0600, never served), because checking a MAC
// needs it. Forgetting a phone is deleting its row. A phone that typed the short
// address instead of scanning adopts without the one-time key, so ITS key crosses
// the network once, in clear; that is the accepted limit.
//
// THE INJECTION THAT MATTERS. An action ends up on the remote bridge's command
// FIFO as `key <action>\n`. That FIFO also carries `learn <id>` and `native on`,
// so an action carrying a newline would not be a bad keypress - it would be a
// second command of the caller's choosing. Actions are therefore checked against
// a fixed vocabulary rather than sanitised, which is the difference between a
// list of what is allowed and a guess at what is dangerous.
const apigate = require("./apigate"); // the Host check
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");

const screenframe = require("./screenframe");
const seal = require("./pairing/seal");

const PORT = 8100;
const PAGE = path.join(__dirname, "pairing", "pages", "remote.html");

// How long the TV's code is good for, and how many wrong ones end the window.
// Same shape as the pairing server's gate: a four-digit code is guessable on its
// own, and the lockout plus the short window is what makes it not.
const ADOPT_TTL_MS = 5 * 60 * 1000;
const ADOPT_MAX_FAILS = 8;

// How stale a picture a phone will be handed before a new one is taken. The
// readback is half a second, so anything under this would spend the box's time
// rather than save the phone's.
const FRAME_MAX_AGE_MS = 1500;

const MAX_BODY = 4096; // a keypress is a few dozen bytes
// A signed request carries the phone's clock; one further from the box's than
// this is refused, with the box's time in the answer so the page can correct.
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const MAX_PHONES = 16;
const MAX_NAME = 40;
// lastSeen is written to config, so it is not written per keypress: a remote
// held down would otherwise rewrite config.json twenty times a second.
const SEEN_WRITE_MS = 60 * 1000;

// Exactly what the bridge understands (remote/remote_input_bridge.py ACTION_KEY
// and SPECIAL_ACTIONS). Kept here rather than derived, because the point of the
// check is that this side decides - a vocabulary read from somewhere else could
// grow without anyone reviewing what it now permits.
const ACTIONS = new Set([
  "up",
  "down",
  "left",
  "right",
  "ok",
  "back",
  "home",
  "playpause",
  "stop",
  "rewind",
  "fastforward",
  "prev",
  "next",
  "volume_up",
  "volume_down",
  "mute",
  "power",
  "settings",
  "appswitcher",
]);
const APP_ACTION = /^app:[a-z0-9_-]{1,32}$/;

const isAction = (a) => typeof a === "string" && (ACTIONS.has(a) || APP_ACTION.test(a));

function timingEq(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

let deps = {
  press: () => false, // (action) -> wrote to the bridge
  lanIp: () => "127.0.0.1",
  rawPhoneRemote: () => ({}),
  setPhoneRemote: () => {},
  // The port is a dep so the tests can each bind their own: on one fixed port
  // they race the previous test's close, and a listener that failed to bind is
  // indistinguishable from one that refused the request.
  port: PORT,
};
function init(d) {
  deps = { ...deps, ...d };
}

let server = null;
let adopt = null; // { code, expires, fails } while the TV is showing one
let seenAt = new Map(); // phone id -> when its lastSeen was last written
let nonces = new Map(); // phone id -> Map(nonce -> when), the signed requests already answered

// ------------------------------------------------------------------ the store

// Seeing the screen is a SECOND permission, not part of the remote. A frame shows
// whatever is on the TV - a wifi password on the on-screen keyboard, the pairing
// code itself - so it is asked for separately and it runs out on its own. A
// switch left on is the failure mode here, not a switch nobody found.
function screenUntil() {
  return Number(deps.rawPhoneRemote().screenUntil) || 0;
}
// Reading this is also where an expiry is NOTICED, since nothing else ticks: the
// files are the sensitive part, so they go the moment the window has closed.
function screenOn() {
  const on = screenUntil() > Date.now();
  if (!on && screenUntil()) {
    deps.setPhoneRemote({ screenUntil: 0 });
    screenframe.forget();
  }
  return on;
}

function shareScreen(minutes) {
  const mins = Math.max(0, Math.min(120, Number(minutes) || 0));
  const until = mins ? Date.now() + mins * 60000 : 0;
  deps.setPhoneRemote({ screenUntil: until });
  if (!until) screenframe.forget();
  return until;
}

const phones = () => {
  const p = deps.rawPhoneRemote().phones;
  return Array.isArray(p) ? p : [];
};
const enabled = () => !!deps.rawPhoneRemote().enabled;

// What the launcher may show: names and times, never a key.
function list() {
  return phones().map((p) => ({ id: p.id, name: p.name, addedAt: p.addedAt, lastSeenAt: p.lastSeenAt || null }));
}

function forget(id) {
  const left = phones().filter((p) => p.id !== String(id || ""));
  if (left.length === phones().length) return false;
  deps.setPhoneRemote({ phones: left });
  return true;
}

function forgetAll() {
  const n = phones().length;
  if (n) deps.setPhoneRemote({ phones: [] });
  return n;
}

// The phone a signed request comes from, or a reason it is not one. A row
// written before phones held keys has none, and such a phone pairs again.
function signedBy(req, u, method, raw) {
  const id = u.searchParams.get("p");
  const row = typeof id === "string" && id ? phones().find((p) => p.id === id) : null;
  const key = row && typeof row.key === "string" ? Buffer.from(row.key, "base64url") : null;
  if (!key || key.length !== seal.KEY_BYTES || !seal.macOk(new Uint8Array(key), method, req.url, raw)) {
    return { error: "token" };
  }
  const ts = Number(u.searchParams.get("ts"));
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > CLOCK_SKEW_MS) return { error: "time" };
  const n = u.searchParams.get("n");
  if (!n || !/^[A-Za-z0-9_-]{8,32}$/.test(n)) return { error: "token" };
  let seen = nonces.get(row.id);
  if (!seen) nonces.set(row.id, (seen = new Map()));
  if (seen.has(n)) return { error: "replay" };
  // Kept for twice the clock window, which is as long as a copy could be accepted.
  const now = Date.now();
  for (const [k, at] of seen) {
    if (now - at <= 2 * CLOCK_SKEW_MS && seen.size < 20000) break;
    seen.delete(k);
  }
  seen.set(n, now);
  return { phone: row, key: new Uint8Array(key) };
}

// ---------------------------------------------------------------- the listener

function start(cb) {
  if (server || !enabled()) return void (cb && cb());
  const s = http.createServer(handle);
  server = s;
  let answered = false;
  const answer = (err) => {
    if (answered) return;
    answered = true;
    if (cb) cb(err);
  };
  s.on("error", (e) => {
    console.warn("[phoneremote] server error:", e.message);
    if (server === s) server = null;
    // A listen that fails (port taken) never reaches the listening callback, and
    // a caller waiting on it would wait for ever.
    answer(e);
  });
  s.listen(deps.port, "0.0.0.0", () => {
    console.log("[phoneremote] listening on :" + boundPort());
    answer();
  });
}

function stop(cb) {
  adopt = null;
  const s = server;
  server = null; // dropped first, so a request arriving mid-close finds nothing
  if (!s) return void (cb && cb());
  // A phone holds its connection open between presses, and `close` alone only
  // stops NEW ones - it would wait for that phone to go away. Turning the remote
  // off has to mean off.
  try {
    s.closeAllConnections();
  } catch (e) {}
  s.close(() => {
    console.log("[phoneremote] stopped");
    if (cb) cb();
  });
}

// Called whenever the setting changes: turning it off must take the socket down,
// not merely refuse requests on it.
function apply(cb) {
  if (enabled()) start(cb);
  else stop(cb);
}

// ---------------------------------------------------------------- adoption

// What the socket actually bound to - the same as the configured port unless it
// was asked for an ephemeral one.
function boundPort() {
  const a = server && server.address();
  return (a && a.port) || deps.port;
}

// The TV is showing a code. Returns what the QR should carry.
function arm(cb) {
  if (!enabled()) return void (cb && cb(null));
  // Wait for the bind before describing where to find it. A QR built from an
  // unbound socket carries port 0, and one built from a loopback address points
  // the phone at itself - both are a code someone types in for nothing, which is
  // worse than being told it is not ready.
  start(() => {
    const ip = deps.lanIp();
    const p = boundPort();
    if (!ip || ip === "127.0.0.1" || !p) {
      console.warn("[phoneremote] not arming: no LAN address yet");
      return void (cb && cb(null));
    }
    adopt = {
      code: String(crypto.randomInt(1000, 10000)),
      key: seal.newKey(),
      expires: Date.now() + ADOPT_TTL_MS,
      fails: 0,
    };
    // Both in the fragment, which a browser never sends: the code and the one-time
    // key that seals the adoption reach the phone without crossing the network.
    const frag = `#c=${adopt.code}&k=${seal.keyParam(adopt.key)}`;
    cb && cb({ url: `http://${ip}:${p}/${frag}`, shortUrl: `http://${ip}:${p}`, code: adopt.code, port: p });
  });
}

// The plain address, with no code on it. Empty while the listener is down or the
// box has no LAN address - the same two reasons arm() refuses.
//
// The port comes from the socket rather than from boundPort(), which falls back
// to the CONFIGURED one: `enabled` is a setting, so a listener that never came up
// - the port was taken - would otherwise be handed out as an address nothing
// answers, and on the TV that is indistinguishable from a phone at fault.
function address() {
  const ip = deps.lanIp();
  const bound = server && server.listening && server.address();
  const p = bound && bound.port;
  return enabled() && ip && ip !== "127.0.0.1" && p ? `http://${ip}:${p}` : "";
}

function disarm() {
  adopt = null;
}

// A wrong code does NOT extend the window, so an attacker cannot hold it open by
// guessing; the lockout ends it early.
function codeOk(presented) {
  if (!adopt || Date.now() > adopt.expires) {
    adopt = null;
    return false;
  }
  if (timingEq(presented, adopt.code)) return true;
  if (++adopt.fails >= ADOPT_MAX_FAILS) {
    console.warn("[phoneremote] too many wrong codes - the window is closed");
    adopt = null;
  }
  return false;
}

function adoptPhone(name) {
  const list = phones();
  if (list.length >= MAX_PHONES) throw new Error("full");
  const id = crypto.randomBytes(6).toString("hex");
  const key = crypto.randomBytes(seal.KEY_BYTES).toString("base64url");
  // The name is the phone's own, so it is somebody else's string: control
  // characters out (it ends up in a log line and in config.json), whitespace
  // collapsed, length capped, and never empty - a blank row in the Settings list
  // is a phone nobody can tell from another.
  const safe =
    String(name || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME) || "phone";
  deps.setPhoneRemote({
    phones: [...list, { id, name: safe, key, addedAt: Date.now() }],
  });
  // The one time this value leaves the box. Nothing logs it.
  return { id, key };
}

function touch(p) {
  const now = Date.now();
  if (seenAt.get(p.id) && now - seenAt.get(p.id) < SEEN_WRITE_MS) return;
  seenAt.set(p.id, now);
  deps.setPhoneRemote({ phones: phones().map((x) => (x.id === p.id ? { ...x, lastSeenAt: now } : x)) });
}

// ------------------------------------------------------------------- requests

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

// The body as parsed JSON and as the exact bytes, which the MAC covers.
function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  let over = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      over = true;
      return req.destroy();
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (over) return cb(null);
    const raw = Buffer.concat(chunks);
    try {
      const body = JSON.parse(raw.toString("utf8") || "{}");
      cb(body && typeof body === "object" && !Array.isArray(body) ? body : null, raw);
    } catch (e) {
      cb(null);
    }
  });
  req.on("error", () => {});
}

// A refusal of a signed request. "time" carries the box's clock, so a phone whose
// clock is off can correct and ask again rather than stop working.
function refuseSigned(res, why) {
  return json(res, 403, why === "time" ? { ok: false, error: "time", now: Date.now() } : { ok: false, error: why });
}

function handle(req, res) {
  // The phone reaches the box by its address; any other name is a page on
  // another site rebound to it (apigate.hostAllowed).
  if (!apigate.lanHostAllowed(req, boundPort())) return json(res, 421, { ok: false });
  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch (e) {
    return json(res, 400, { ok: false });
  }
  if (req.method === "GET" && u.pathname === "/tvbox-seal.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(seal.script());
  }
  // The frame is sealed under the phone's key: it shows whatever is on the TV, a
  // password on the on-screen keyboard included. The page opens it and shows it.
  if (req.method === "GET" && u.pathname === "/screen") {
    const who = signedBy(req, u, "GET", Buffer.alloc(0));
    if (!who.phone) return refuseSigned(res, who.error);
    if (!screenOn()) return json(res, 403, { ok: false, error: "off" });
    // `w` is what the phone is showing it at: pinching into a 960-wide JPEG
    // magnifies its artefacts rather than the screen, so a zoomed page asks for
    // the larger one. It snaps to a size the box offers - the capture is shared
    // either way, so this costs an encode and not another readback.
    return screenframe.frame(FRAME_MAX_AGE_MS, Number(u.searchParams.get("w")) || 0, (err, file) => {
      if (err) return json(res, err === "no_ffmpeg" ? 501 : 503, { ok: false, error: err });
      // Checked again on the way out. Taking a picture is half a second, and the
      // window can close - by hand or by running out - inside it; a frame that
      // arrives after that is exactly the picture nobody agreed to send.
      if (!screenOn()) return json(res, 403, { ok: false, error: "off" });
      fs.readFile(file, (e, jpeg) => {
        if (e) return json(res, 503, { ok: false, error: "frame" });
        // Never cached: the whole point is that the next request is a new picture.
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
        res.end(seal.sealBytes(jpeg, who.key));
      });
    });
  }
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    let html;
    try {
      html = fs.readFileSync(PAGE, "utf8");
    } catch (e) {
      return json(res, 500, { ok: false });
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }
  if (req.method !== "POST") return json(res, 404, { ok: false });

  readBody(req, (body, raw) => {
    if (!body) return json(res, 400, { ok: false });

    if (u.pathname === "/adopt") {
      // Sealed with the one-time key from the QR, or plain from a phone that typed
      // the address. The answer goes back the way the question came.
      const oneTime = adopt && adopt.key;
      let ask = body;
      if (typeof body.sealed === "string") {
        ask = oneTime ? seal.open(body.sealed, oneTime) : null;
        if (!ask) return json(res, 400, { ok: false, error: "sealed" });
      }
      if (!codeOk(ask.code)) return json(res, 403, { ok: false, error: "code" });
      let issued;
      try {
        issued = adoptPhone(ask.name);
      } catch (e) {
        return json(res, 507, { ok: false, error: e.message });
      }
      // One adoption per code. The phone has what it needs; leaving the window
      // open would let a second device onto the same four digits.
      adopt = null;
      const grant = { ...issued, now: Date.now() };
      if (ask !== body) return json(res, 200, { ok: true, sealed: seal.seal(grant, oneTime) });
      return json(res, 200, { ok: true, ...grant });
    }

    const who = signedBy(req, u, "POST", raw);
    if (!who.phone) return refuseSigned(res, who.error);
    const phone = who.phone;

    if (u.pathname === "/key") {
      // Checked against the vocabulary, never sanitised into it: this string is
      // about to become a line on the bridge's command FIFO, which also carries
      // `learn` and `native on`.
      if (!isAction(body.action)) return json(res, 400, { ok: false, error: "action" });
      touch(phone);
      return json(res, 200, { ok: !!deps.press(body.action) });
    }
    if (u.pathname === "/ping") {
      touch(phone);
      return json(res, 200, { ok: true, name: phone.name, screen: screenOn() });
    }
    return json(res, 404, { ok: false });
  });
}

module.exports = {
  PORT,
  address,
  screenOn,
  screenUntil,
  shareScreen,
  boundPort,
  ACTIONS,
  isAction,
  init,
  apply,
  start,
  stop,
  arm,
  disarm,
  list,
  forget,
  forgetAll,
  CLOCK_SKEW_MS,
};
