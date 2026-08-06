// The compositor's own control socket (tvbox-wc), and the shape display.js
// expects.
//
// tvbox-wc answers on a unix socket with one JSON object per line, the same
// framing mpv uses, so this is a small client rather than a protocol. It replaces
// what wlr-randr did by shelling out, and it does things wlr-randr cannot: claim
// the output's colour space for HDR content, tell the compositor which of the
// launcher and an app owns the screen, and type a string into a focused field.
//
// Everything degrades: with no socket - which is every box still on labwc -
// available() is false and the callers fall back to the old path. That is
// deliberate for the transition, not a permanent second implementation.
const net = require("net");
const path = require("path");

const SOCKET =
  process.env.TVBOX_WC_SOCKET || path.join(process.env.XDG_RUNTIME_DIR || "/run/user/1000", "tvbox-wc.sock");

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
  const payload = { request: "place_window", app_id: appId };
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
  list,
  listSync,
  apply,
  setHdr,
  setFocus,
  placeWindow,
  typeText,
  toDisplayInfo,
  SOCKET,
};
