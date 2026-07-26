// tvbox display control (Wayland/wlroots via wlr-randr): lists the connected
// output's modes, picks which one to be at, and switches. Who wants what and when
// lives in displaymode.js; this file is the wlr-randr surface plus the pure
// selection rules. labwc tracks the output size for fullscreen surfaces, so the
// shell window follows a mode change with no extra work. Callers pass the session's
// Wayland env (main's childEnv) - wlr-randr needs WAYLAND_DISPLAY / XDG_RUNTIME_DIR.
const { execFile } = require("child_process");

// Parse `wlr-randr` text into { output, modes:[{ key,width,height,refresh,refreshExact,current,preferred }] }.
// `refresh` is rounded to whole Hz for a stable id ("WxH@60"); `refreshExact` is
// the real value we hand back to wlr-randr - a rounded "@60Hz" can miss a mode
// whose real refresh is 60.015Hz.
//
// EVERY mode is kept, including ones that share a rounded key. 23.976 and 24.000
// both round to "@24" but are NOT interchangeable: 23.976 content on a 24.000 Hz
// output drifts 0.1% (a repeated frame every ~41s), and 29.97 on 60.000 likewise.
// Dropping one of them is why asking for "1920x1080@24" used to hand back 24.000.
// wlr-randr prints no interlace flag, so a 1080i/1080p pair at the same rate is
// indistinguishable here (and to `--mode`); nothing downstream can prefer one.
function parse(stdout) {
  let output = null;
  const modes = [];
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
    modes.push({ key, width, height, refresh, refreshExact, current, preferred });
  }
  return output ? { output, modes } : null;
}

// ---- mode selection -------------------------------------------------------------
// Pure, so shell/display.test.js can pin the behaviour without an output.

const UI_MAX_HEIGHT = 1080; // a 4K panel still draws the UI at 1080p

// How many display refreshes each video frame gets. An INTEGER means every frame
// is held the same length - smooth. 23.976 fps on 60 Hz is 2.5023, so frames
// alternate 2 and 3 refreshes: nothing is dropped, but the motion judders.
function refreshRatio(refreshExact, fps) {
  return fps > 0 ? refreshExact / fps : 0;
}
// 0 = perfect, 1 = drifts slightly (right family, wrong 1000/1001 variant),
// null = not a multiple at all.
// The error is taken PER FRAME (off / k), not on the ratio: 24.000 for 23.976
// content is off by 0.001 at 1x while 60.000 for 29.97 is off by 0.002 at 2x -
// the same 0.1% drift, and both deserve the same rank.
function cadenceRank(refreshExact, fps) {
  const k = refreshRatio(refreshExact, fps);
  if (k < 0.999) return null; // slower than the content - would drop frames
  const n = Math.round(k);
  const drift = Math.abs(k - n) / n;
  if (drift < 0.0002) return 0;
  if (drift < 0.002) return 1;
  return null;
}

// The mode the UI lives at: the panel's own preferred resolution, capped to
// 1080p, at the highest refresh that resolution offers. A 720p set gets 720p, a
// 1080p set 1080p, a 4K set 1080p (the launcher is not worth 8.3 Mpixels).
function pickUiMode(modes, maxHeight = UI_MAX_HEIGHT) {
  if (!modes || !modes.length) return null;
  const fits = modes.filter((m) => m.height <= maxHeight);
  const pool = fits.length ? fits : modes; // a panel with nothing under the cap
  const pref = pool.find((m) => m.preferred);
  const area = (m) => m.width * m.height;
  const target = pref || pool.reduce((a, b) => (area(b) > area(a) ? b : a));
  return pool
    .filter((m) => m.width === target.width && m.height === target.height)
    .reduce((a, b) => (b.refreshExact > a.refreshExact ? b : a));
}

// The mode to play THIS content at. Refresh comes first: a matching refresh is
// what removes judder, and on real TVs the film rates (23.976/24/25/29.97/30)
// are often only offered at 1080p - so "smallest resolution that fits the video"
// would force 720p60 and keep the judder. Resolution then picks the smallest
// mode that still covers the video (never below 720p, never above the panel).
// Returns null when the panel has no matching refresh at all; the caller then
// stays put and lets mpv resample.
function pickContentMode(modes, content) {
  if (!modes || !modes.length || !content || !(content.fps > 0)) return null;
  // An unknown (or nonsense) size means "assume the floor": mpv can report the
  // framerate before dwidth/dheight are available, and the smallest-that-fits rule
  // would otherwise happily drop a film to 640x480 because nothing said not to.
  const w = content.width > 0 ? content.width : 1280;
  const h = content.height > 0 ? content.height : 720;
  const cands = [];
  for (const m of modes) {
    const rank = cadenceRank(m.refreshExact, content.fps);
    if (rank === null) continue;
    if (m.height < 720) continue; // 720p floor, whatever the content claims to be
    cands.push({ m, rank, covers: m.width >= w && m.height >= h });
  }
  if (!cands.length) return null;
  const covering = cands.filter((c) => c.covers);
  const pool = covering.length ? covering : cands; // nothing covers it -> best effort
  pool.sort(
    (a, b) =>
      a.rank - b.rank || // exact cadence beats a drifting one
      a.m.width * a.m.height - b.m.width * b.m.height || // then the smallest that fits
      a.m.refreshExact - b.m.refreshExact, // then the least work
  );
  return pool[0].m;
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

module.exports = { parse, list, apply, pickUiMode, pickContentMode, cadenceRank, UI_MAX_HEIGHT };
