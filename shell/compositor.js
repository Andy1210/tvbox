// The compositor's own control socket (tvbox-wc), and the shape display.js
// expects.
//
// tvbox-wc answers on a unix socket with one JSON object per line, the same
// framing mpv uses, so this is a small client rather than a protocol. It replaces
// what wlr-randr did by shelling out, and it does things wlr-randr cannot: claim
// the output's colour space for HDR content, tell the compositor which of the
// launcher and an app owns the screen, and type a string into a focused field.
//
// There is no fallback behind it: the display, HDR and typing paths call the socket
// and nothing else. `available()` exists for one caller - the updater, which refuses
// a release that needs a compositor this box has not got.
const net = require("net");
const path = require("path");

// The runtime dir from the environment, and the uid's own when there is none:
// hardcoding 1000 breaks a box whose first user is not (a Pi Imager custom user),
// which is the same reason main.js derives WL_ENV that way.
const SOCKET =
  process.env.TVBOX_WC_SOCKET ||
  path.join(process.env.XDG_RUNTIME_DIR || "/run/user/" + process.getuid(), "tvbox-wc.sock");

const TIMEOUT_MS = 4000;

let nextId = 1;

// Is the compositor there? Cheap enough to ask per call: it is a stat, and the
// answer changes exactly once, when the box switches compositors.
function available() {
  try {
    return require("fs").statSync(SOCKET).isSocket();
  } catch {
    return false;
  }
}

// One request, one response. A connection per call keeps this stateless; these
// are rare (a mode change, an HDR claim), not a stream.
function request(payload, cb) {
  const done = once(cb);
  let socket;
  try {
    socket = net.createConnection(SOCKET);
  } catch (e) {
    return done(e, null);
  }

  let buffer = "";
  const timer = setTimeout(() => {
    socket.destroy();
    done(new Error("timeout"), null);
  }, TIMEOUT_MS);

  socket.on("error", (e) => {
    clearTimeout(timer);
    done(e, null);
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    clearTimeout(timer);
    socket.end();
    let reply;
    try {
      reply = JSON.parse(buffer.slice(0, end));
    } catch (e) {
      return done(e, null);
    }
    if (reply.error) return done(new Error(reply.error), null);
    done(null, reply.ok);
  });
  socket.on("connect", () => {
    socket.write(JSON.stringify({ id: nextId++, ...payload }) + "\n");
  });
}

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    fn(...args);
  };
}

// The compositor reports refresh in mHz, which is the Wayland unit. display.js
// works in Hz with the exact value kept, because a rounded 60 can pick the wrong
// mode out of a 59.94/60 pair.
function toDisplayInfo(ok) {
  const out = ok && ok.outputs && ok.outputs[0];
  if (!out) return null;
  const modes = (out.modes || []).map((m) => ({
    // The key rounds on purpose: two modes that share it (23.976 and 24) are
    // meant to collide there and be told apart by refreshExact.
    key: m.w + "x" + m.h + "@" + Math.round(m.refresh / 1000),
    width: m.w,
    height: m.h,
    refresh: Math.round(m.refresh / 1000),
    refreshExact: m.refresh / 1000,
    current: !!(out.current && out.current.w === m.w && out.current.h === m.h && out.current.refresh === m.refresh),
    preferred: !!m.preferred,
  }));
  return { output: out.name, modes, connected: out.connected !== false, hdr: out.hdr || null };
}

function list(cb) {
  request({ request: "get_outputs" }, (e, ok) => cb(e ? null : toDisplayInfo(ok)));
}

// The same read, blocking, for the one caller that cannot wait: an app window is
// told the panel's resolution at preload time and never asks again. Node has no
// synchronous unix socket, so this pays for a child process - the same price the
// wlr-randr path paid, and for the same reason.
function listSync() {
  const script =
    "const net=require('net');const s=net.createConnection(process.argv[1]);" +
    "let b='';s.on('connect',()=>s.write(JSON.stringify({id:1,request:'get_outputs'})+String.fromCharCode(10)));" +
    "s.on('data',(c)=>{b+=c;if(b.indexOf(String.fromCharCode(10))<0)return;" +
    "process.stdout.write(b.split(String.fromCharCode(10))[0]);s.end();process.exit(0)});" +
    "s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000);";
  try {
    const out = require("child_process").execFileSync(process.execPath, ["-e", script, SOCKET], {
      timeout: 5000,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const reply = JSON.parse(out);
    return reply && reply.ok ? toDisplayInfo(reply.ok) : null;
  } catch {
    return null;
  }
}

// Which compositor is RUNNING, and what it can be relied on to do.
//
// Not the same question as "which binary is installed": the compositor IS the
// session, so a newly installed one is only a file until greetd restarts, and
// asking the file would answer yes during exactly the window where the answer is
// no. `get_state` carries the running version from tvbox-wc 0.1.10; an older one
// sends no such field, which is the honest answer for it.
//
// Cached because it changes at most once in the life of this process - a session
// restart takes the shell with it. The cache starts EMPTY and every comparison
// against an empty version is false, so a caller gated on this degrades to the
// behaviour it had before the compositor could do the thing at all.
let runningVersion = "";
let versionAt = 0;
let versionGoodFor = 0;
let versionPending = false;
let versionWaiting = [];
const VERSION_TTL_MS = 5 * 60 * 1000;
// A failed read is worth asking about again soon. Marking it fresh for the full TTL
// would let one timed-out socket read cost five minutes of the feature it gates.
const VERSION_RETRY_MS = 30 * 1000;

// One question at a time, and every caller parks on the one in flight rather than
// adding another. Not just tidiness: `atLeast` refreshes whenever the cache is cold,
// and it is asked once per focused field, so a slow socket would otherwise turn a
// page moving focus between inputs into a queue of identical reads.
function refreshVersion(cb) {
  if (cb) versionWaiting.push(cb);
  if (versionPending) return;
  versionPending = true;
  request({ request: "get_state" }, (e, ok) => {
    versionPending = false;
    // A version we cannot place is not an answer: storing it would leave the cache
    // holding something no comparison can use, and marking it fresh for the full TTL
    // would buy five minutes of that. It gets the retry cooldown a failed read gets,
    // and `runningVersion` only ever holds a version or nothing.
    const answered = !e && ok && parseVersion(ok.version) !== null;
    if (answered) runningVersion = ok.version;
    // Stamped when the ANSWER lands rather than when the question went out, or a
    // read that takes its time would be counted as fresh from before it started.
    //
    // A failed read deliberately does NOT clear what we already know. The running
    // compositor cannot get older without taking this process with it - it IS the
    // session - so a version that dropped is not a case that exists, while a busy
    // or briefly unreachable socket certainly is, and forgetting on one of those
    // would switch a working feature off for no reason.
    versionAt = Date.now();
    versionGoodFor = answered ? VERSION_TTL_MS : VERSION_RETRY_MS;
    const waiting = versionWaiting;
    versionWaiting = [];
    for (const waiter of waiting) {
      // One caller's throw must not swallow the next one's answer: this runs from a
      // socket callback, which has nothing above it to catch anything.
      try {
        waiter(runningVersion);
      } catch (err) {
        console.warn("[compositor] version waiter threw:", err.message);
      }
    }
  });
}

// Exactly three numeric components, or it is not a version this can place.
//
// Not a semver library: what arrives here is CARGO_PKG_VERSION from a release whose
// tag CI has already checked against Cargo.toml, so three integers is the only shape
// there is - and a gate whose job is to fail closed has no business inferring the
// rest of one. Two ways that inference went wrong before this was pinned down:
// parseInt stops at the first thing it cannot read, so "0.1.10-dev" passed as
// 0.1.10; and padding a missing component with zero made "0.2" outrank "0.1.10" on
// the strength of a component nobody sent.
function parseVersion(v) {
  const parts = String(v == null ? "" : v)
    .trim()
    .split(".");
  if (parts.length !== 3 || !parts.every((n) => /^\d+$/.test(n))) return null;
  return parts.map((n) => parseInt(n, 10));
}

// `a >= b`, with anything unplaceable losing to everything.
function versionAtLeast(have, want) {
  const a = parseVersion(have);
  const b = parseVersion(want);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

// Is the running compositor at least this version? Answers from the cache, and
// refreshes it in the background when it is stale - so a read that failed at
// startup costs the caller one turn rather than the rest of the session.
function atLeast(want) {
  if (!runningVersion || Date.now() - versionAt > versionGoodFor) refreshVersion();
  return versionAtLeast(runningVersion, want);
}

// A mode object as display.js parses them, so callers do not care which backend
// applied it.
function apply(output, mode, cb) {
  if (!output || !mode) return cb(false, "bad mode");
  request(
    {
      request: "set_mode",
      output,
      w: mode.width,
      h: mode.height,
      refresh: Math.round(mode.refreshExact * 1000),
    },
    (e) => cb(!e, e ? String(e.message || e).slice(0, 160) : ""),
  );
}

// A claim for the duration of PQ content, not a setting: the colour space covers
// the whole output, so an SDR UI is read as PQ while it is held.
function setHdr(output, on, cb) {
  request({ request: "set_hdr", output, on: !!on }, (e) => cb(!e, e ? String(e.message || e) : ""));
}

// Which of the launcher and an app owns the screen. The compositor cannot work
// this out: both can be windows of the same process. It decides whether the
// remote's Back key is rewritten for the app UIs that only understand Backspace.
function setFocus(owner, app, cb) {
  request({ request: "set_focus", owner, app: app || undefined }, (e) => cb && cb(!e));
}

// Where a client's windows go. A Wayland client cannot place itself, which is why
// the player used to run under XWayland for picture-in-picture; the compositor can.
// A null rect puts the client back on the whole output.
//
// Set it BEFORE the client starts: a window is placed as it maps, so a player
// launched into a rectangle never appears fullscreen first.
function placeWindow(appId, rect, cb) {
  place({ app_id: appId }, rect, cb);
}

// The same, for ONE window named by its title. An app id covers every window a
// client has, and every window of this process carries the shell's - so the title
// is the only way to place the notification overlay without moving the launcher
// into the same little rectangle.
function placeWindowByTitle(title, rect, cb) {
  place({ title: String(title) }, rect, cb);
}

function place(named, rect, cb) {
  const payload = { request: "place_window", ...named };
  if (rect && rect.w > 0 && rect.h > 0) {
    payload.x = Math.round(rect.x);
    payload.y = Math.round(rect.y);
    payload.w = Math.round(rect.w);
    payload.h = Math.round(rect.h);
  }
  request(payload, (e) => cb && cb(!e, e ? String(e.message || e) : ""));
}

// Type a string into whatever holds the keyboard, as real key events. `selectAll`
// replaces what the field already holds rather than appending to it.
function typeText(text, opts, cb) {
  request({ request: "type_text", text: String(text), select_all: !!(opts && opts.selectAll) }, (e, ok) => {
    if (cb) cb(!e, ok && ok.keys);
  });
}

module.exports = {
  available,
  request,
  refreshVersion,
  atLeast,
  _test: { versionAtLeast },
  list,
  listSync,
  apply,
  setHdr,
  setFocus,
  placeWindow,
  placeWindowByTitle,
  typeText,
  toDisplayInfo,
  SOCKET,
};
