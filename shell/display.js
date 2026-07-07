// tvbox display control (Wayland/wlroots via wlr-randr). Lists the connected
// output's modes, switches resolution/refresh, and re-applies the saved mode on
// boot. labwc tracks the output size for fullscreen surfaces, so the shell
// window follows a mode change with no extra work. Callers pass the session's
// Wayland env (main's childEnv) - wlr-randr needs WAYLAND_DISPLAY / XDG_RUNTIME_DIR.
const { execFile } = require("child_process");

// Parse `wlr-randr` text into { output, modes:[{ key,width,height,refresh,refreshExact,current,preferred }] }.
// `refresh` is rounded to whole Hz for a clean list + stable id ("WxH@60", not
// 60.000 vs 59.939 dupes); `refreshExact` is the real value we must hand back to
// wlr-randr - a rounded "@60Hz" can miss a mode whose real refresh is 60.015Hz.
function parse(stdout) {
  let output = null;
  const modes = [];
  const byKey = new Map();
  for (const line of (stdout || "").split("\n")) {
    const oh = /^(\S+) "/.exec(line); // e.g.  HDMI-A-1 "LG Electronics ..."
    if (oh) {
      if (!output) output = oh[1];
      continue;
    }
    const mm = /^\s+(\d+)x(\d+)\s+px,\s+([\d.]+)\s+Hz(.*)$/.exec(line);
    if (!mm) continue;
    const width = Number(mm[1]),
      height = Number(mm[2]);
    const refreshExact = parseFloat(mm[3]);
    const refresh = Math.round(refreshExact);
    const current = /current/.test(mm[4] || "");
    const preferred = /preferred/.test(mm[4] || "");
    const key = width + "x" + height + "@" + refresh;
    const existing = byKey.get(key);
    if (existing) {
      if (current) existing.current = true;
      continue;
    } // keep the first (real 60.000 over 59.94)
    const mode = { key, width, height, refresh, refreshExact, current, preferred };
    byKey.set(key, mode);
    modes.push(mode);
  }
  return output ? { output, modes } : null;
}

function list(env, cb) {
  execFile("wlr-randr", [], { env, timeout: 8000 }, (e, out) => cb(e ? null : parse(out)));
}

// Apply a parsed mode object, using its EXACT refresh so wlr-randr matches.
function apply(env, output, mode, cb) {
  if (!output || !mode) return cb(false, "bad mode");
  const spec = mode.width + "x" + mode.height + "@" + mode.refreshExact.toFixed(3) + "Hz";
  execFile("wlr-randr", ["--output", output, "--mode", spec], { env, timeout: 12000 }, (e, _o, err) =>
    cb(
      !e,
      e
        ? String(err || e.message || "")
            .trim()
            .slice(0, 160)
        : "",
    ),
  );
}

// Resolve a mode key ("WxH@N") against the live mode list and apply it. Shared by
// the apply route and boot re-apply so both go through the same exact-refresh path.
function applyKey(env, key, cb) {
  if (!key) return cb(false, "no mode");
  list(env, (info) => {
    if (!info) return cb(false, "no output");
    const mode = info.modes.find((m) => m.key === key);
    if (!mode) return cb(false, "unknown mode");
    apply(env, info.output, mode, cb);
  });
}

module.exports = { parse, list, apply, applyKey };
