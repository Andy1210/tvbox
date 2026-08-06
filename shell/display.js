// tvbox display control, over the compositor's own control socket: lists the connected
// output's modes, picks which one to be at, and switches. Who wants what and when
// lives in displaymode.js; this file is the compositor surface plus the pure
// selection rules. The compositor tracks the output size for fullscreen surfaces, so the
// shell window follows a mode change with no extra work.
const compositor = require("./compositor");

const UI_MAX_HEIGHT = 1080; // a 4K panel still draws the UI at 1080p
const UI_MAX_REFRESH = 60.5; // 60 Hz plus rounding slack (59.94 and 60 both qualify)

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
// What the panel can show, as opposed to what it is showing. The UI runs at 1080p
// on a 4K set, so anything that asks the window system how big the screen is gets
// told 1080p and decides accordingly - a streaming client picks its stream that
// way, and picks it before the mode switch for the video has happened.
//
// The PREFERRED mode is the answer rather than the largest one: a TV may advertise
// a DCI-4K mode (4096 wide) that this hardware cannot drive, and claiming it would
// be a worse lie than the one being corrected.
function panelResolution(modes) {
  const usable = (modes || []).filter((m) => m.width > 0 && m.height > 0);
  if (!usable.length) return null;
  const preferred = usable.find((m) => m.preferred);
  const best = preferred || usable.reduce((a, m) => (m.width * m.height > a.width * a.height ? m : a));
  return { width: best.width, height: best.height };
}

function pickUiMode(modes, maxHeight = UI_MAX_HEIGHT) {
  if (!modes || !modes.length) return null;
  const fits = modes.filter((m) => m.height <= maxHeight);
  const pool = fits.length ? fits : modes; // a panel with nothing under the cap
  const pref = pool.find((m) => m.preferred);
  const area = (m) => m.width * m.height;
  const target = pref || pool.reduce((a, b) => (area(b) > area(a) ? b : a));
  const same = pool.filter((m) => m.width === target.width && m.height === target.height);
  // Not the highest refresh the panel offers: the UI is drawn by Chromium, which
  // paints at the output's rate, and on a Pi 5 that is what the GPU runs out of -
  // the Plex client alone measured 104% of the V3D at 1080p120 against 64% at
  // 1080p60, for a UI that cannot render 120 frames a second anyway.
  const capped = same.filter((m) => m.refreshExact <= UI_MAX_REFRESH);
  return (capped.length ? capped : same).reduce((a, b) => (b.refreshExact > a.refreshExact ? b : a));
}

// The mode to play THIS content at. Refresh comes first: a matching refresh is
// what removes judder, and on real TVs the film rates (23.976/24/25/29.97/30)
// are often only offered at 1080p - so "smallest resolution that fits the video"
// would force 720p60 and keep the judder. Resolution then picks the smallest
// mode that still covers the video (never below 720p, never above the panel).
// Returns null when the panel has no matching refresh at all; the caller then
// stays put and lets mpv resample.
// How far a mode is from the picture, as the factor the player would resize by -
// symmetric, so a 6% shrink counts as small and a 1.9x blow-up counts as large.
//
// The mode does NOT have to cover the content, and that is the point. A DCI-2K
// broadcast is 2048x1080, six percent wider than 1080p and ordinary on IPTV, and
// no mode below 4K is wider than it: "the smallest mode that covers it" put such a
// stream on a 3840x2160 output, where mpv upscales and renders every frame at 8.3
// Mpixels. Measured on the box with a live channel: 1318 dropped frames with the
// decoder keeping up. Six percent of horizontal detail is the cheaper half of that
// trade by a wide margin - and the same rule keeps a DCI-4K film (4096x2160) on a
// 3840-wide panel at 4K instead of dropping it to 1080p, which is what "covers"
// did when nothing covered it.
function scaleDistance(mode, w, h) {
  const fit = Math.min(mode.width / w, mode.height / h); // how the player fits the picture
  return Math.abs(Math.log(fit));
}

function pickContentMode(modes, content) {
  if (!modes || !modes.length || !content || !(content.fps > 0)) return null;
  // An unknown (or nonsense) size means "assume the floor": mpv can report the
  // framerate before dwidth/dheight are available, and a nearest-size rule would
  // otherwise happily drop a film to 640x480 because nothing said not to.
  const w = content.width > 0 ? content.width : 1280;
  const h = content.height > 0 ? content.height : 720;
  const cands = [];
  for (const m of modes) {
    const rank = cadenceRank(m.refreshExact, content.fps);
    if (rank === null) continue;
    if (m.height < 720) continue; // 720p floor, whatever the content claims to be
    cands.push({ m, rank, distance: scaleDistance(m, w, h) });
  }
  if (!cands.length) return null;
  cands.sort(
    (a, b) =>
      a.rank - b.rank || // exact cadence beats a drifting one
      a.distance - b.distance || // then the mode the picture has to be resized least for
      a.m.width * a.m.height - b.m.width * b.m.height || // then the least work
      a.m.refreshExact - b.m.refreshExact,
  );
  return cands[0].m;
}

function list(cb) {
  compositor.list(cb);
}

// The same read, blocking. Only for startup, and only because of what needs it:
// an app window is told the panel's resolution at preload time and never asks
// again, so an answer that arrives a few milliseconds later is no answer at all.
function listSync() {
  return compositor.listSync();
}

// Apply a mode object as this module reports them, using its EXACT refresh: a
// rounded 60 picks the wrong mode out of a 59.94/60 pair.
function apply(output, mode, cb) {
  compositor.apply(output, mode, cb);
}

module.exports = {
  list,
  listSync,
  apply,
  pickUiMode,
  pickContentMode,
  panelResolution,
  cadenceRank,
  UI_MAX_HEIGHT,
  UI_MAX_REFRESH,
};
