// Background-app window registry. Every app runs in its OWN BrowserWindow
// (created and wired by main.js, registered here); leaving an app HIDES its
// window - page state survives, resume is instant - instead of the old model
// (local apps page-swapped the main window, remote windows were destroyed).
//
// This module owns the registry and the hidden-set policy: mute + best-effort
// media pause on background, a hidden-window cap (LRU by last-shown), and a
// RAM guard. Foreground orchestration (focus/stacking, mpv, video-mode,
// currentAppId) stays in main.js.
//
// Limits scale with the box's actual RAM (a Pi 5 ships as 2/4/8/16GB): a
// hidden Chromium window costs ~200-500MB, so a small box keeps at most one
// around while a big one can afford several. The floor is where MemAvailable
// triggers eviction of hidden apps.
const wins = new Map(); // id -> BrowserWindow (w.tvboxLastShown drives LRU eviction)
let deps = {
  enabled: () => true, // config.apps.background !== false (the rollback lever)
  memInfo: () => null, // () => { totalKb, availableKb } from main.js
  foregroundId: () => null, // () => currentAppId, so eviction spares the active app
};
let limits = null; // computed once from total RAM on first use

function init(d) {
  deps = { ...deps, ...d };
}

function limitsFor() {
  if (limits) return limits;
  const mi = deps.memInfo();
  const totalKb = (mi && mi.totalKb) || 4 * 1024 * 1024; // conservative default if /proc/meminfo failed
  limits = {
    // eviction floor: 12% of RAM, but never under 384MB (system+foreground
    // headroom is roughly constant) and never over 1GB (a 16GB box shouldn't
    // hoard a giant idle floor)
    floorKb: Math.min(Math.max(Math.round(totalKb * 0.12), 384 * 1024), 1024 * 1024),
    maxHidden: totalKb >= 7 * 1024 * 1024 ? 6 : totalKb >= 3.5 * 1024 * 1024 ? 3 : 1,
  };
  console.log(
    "[apps] background limits: maxHidden=" +
      limits.maxHidden +
      ", ramFloor=" +
      Math.round(limits.floorKb / 1024) +
      "MB",
  );
  return limits;
}

function register(id, w) {
  w.tvboxAppId = id;
  w.tvboxLastShown = Date.now();
  wins.set(id, w);
}

// The live window of a running app, or null.
function get(id) {
  const w = id ? wins.get(id) : null;
  return w && !w.isDestroyed() ? w : null;
}
function all() {
  return [...wins.entries()].filter(([, w]) => !w.isDestroyed());
}
function runningIds() {
  return all().map(([id]) => id);
}
function touch(id) {
  const w = get(id);
  if (w) w.tvboxLastShown = Date.now();
}

// Hide (or, with backgrounding disabled, destroy) an app window when the user
// leaves it. Hidden apps must be silent: mute the renderer and best-effort
// pause any in-page <video>/<audio> (YouTube/Plex web players are independent
// of the shared mpv, which main.js's leave paths already stop).
function background(id) {
  const w = get(id);
  if (!w) return;
  if (!deps.enabled()) return destroy(id);
  try {
    w.webContents.setAudioMuted(true);
  } catch (e) {}
  try {
    w.webContents
      .executeJavaScript(
        'document.querySelectorAll("video,audio").forEach(function(m){try{m.pause()}catch(e){}})',
        true,
      )
      .catch(() => {});
  } catch (e) {}
  try {
    w.hide();
  } catch (e) {}
  enforceCap();
}

function destroy(id) {
  const w = get(id);
  wins.delete(id);
  if (w) {
    try {
      w.destroy(); // not close(): skip beforeunload games from app pages
    } catch (e) {}
  }
}

// Hidden windows, least-recently-shown first (never the foreground app).
function hiddenLru() {
  const fg = deps.foregroundId();
  return all()
    .filter(([id, w]) => !w.isVisible() && id !== fg)
    .sort((a, b) => (a[1].tvboxLastShown || 0) - (b[1].tvboxLastShown || 0));
}
function enforceCap() {
  const hidden = hiddenLru();
  for (let i = 0; i < hidden.length - limitsFor().maxHidden; i++) {
    console.log("[apps] dropping background app (cap):", hidden[i][0]);
    destroy(hidden[i][0]);
  }
}
// Called on a timer from main.js: under memory pressure, drop the oldest
// hidden app (one per tick - MemAvailable needs a beat to reflect the kill).
function ramGuardTick() {
  const mi = deps.memInfo();
  if (!mi || !mi.availableKb || mi.availableKb >= limitsFor().floorKb) return;
  const hidden = hiddenLru();
  if (!hidden.length) return;
  console.warn("[apps] low memory (" + Math.round(mi.availableKb / 1024) + "MB) - dropping", hidden[0][0]);
  destroy(hidden[0][0]);
}

module.exports = { init, register, get, all, runningIds, touch, background, destroy, ramGuardTick };
