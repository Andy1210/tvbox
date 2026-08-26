// The note that appears over everything.
//
// A notification (MQTT, an app, a plugin, the voice satellite's answer) has to be
// visible while an app is fullscreen, and the launcher's window is not: it is
// BEHIND that app. Raising the launcher would show the note and cover the app,
// which is the opposite of what a note is for.
//
// So the note gets a window of its own, and the compositor is told two things about
// it (tvbox-wc >= 0.1.7): the title `tvbox-overlay` puts it in front of everything
// including the rest of the shell, and a placement keeps it SMALL. Small matters -
// every surface here is a scan-out candidate, so a strip at the bottom can take a
// hardware plane, while a fullscreen translucent one over a 4K film is the
// composited pass the whole compositor exists to avoid.
const path = require("path");

const OVERLAY_TITLE = "tvbox-overlay";
// How much of the screen the strip takes. Enough for two lines at the box's own
// text size, and no more: what is not covered stays the film's.
const OVERLAY_HEIGHT_FRACTION = 0.28;
const OVERLAY_MIN_HEIGHT = 160;
// A backstop only: the renderer says when it has finished fading out.
const DEFAULT_DURATION_MS = 6000;
const MIN_DURATION_MS = 1500;
const MAX_DURATION_MS = 60000;
const HIDE_GRACE_MS = 2000;

let deps = {
  BrowserWindow: null,
  screen: null,
  compositor: null,
  // The launcher is where a note goes when the strip cannot take it.
  sendToLauncher: () => false,
  raiseWindow: () => {},
};

function init(d) {
  deps = { ...deps, ...d };
}

let overlayWin = null;
let overlayHideTimer = null;
// Whether this box's compositor understands a placement by title. A box on an
// older one would map the note FULLSCREEN - a translucent surface over the whole
// film, which is exactly the cost this design exists to avoid - so the note stays
// in the launcher there instead. null until asked.
let overlayPlaceable = null;

function screenHeight() {
  return deps.screen.getPrimaryDisplay().size.height;
}

function overlayRect() {
  const { width, height } = deps.screen.getPrimaryDisplay().size;
  const h = Math.max(OVERLAY_MIN_HEIGHT, Math.round(height * OVERLAY_HEIGHT_FRACTION));
  return { x: 0, y: Math.max(0, height - h), w: width, h };
}

// Ask for the strip once, and remember the answer. Placed BEFORE the window maps:
// a window is positioned as it appears, so asking afterwards would show it
// fullscreen for a frame first.
function claimOverlayPlacement(done) {
  if (overlayPlaceable !== null) return done(overlayPlaceable);
  if (!deps.compositor.available()) {
    overlayPlaceable = false;
    return done(false);
  }
  deps.compositor.placeWindowByTitle(OVERLAY_TITLE, overlayRect(), (ok, err) => {
    overlayPlaceable = !!ok;
    if (!ok) console.warn("[notify] no overlay window (compositor: " + (err || "refused") + ")");
    done(overlayPlaceable);
  });
}

function ensureOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const rect = overlayRect();
  overlayWin = new deps.BrowserWindow({
    width: rect.w,
    height: rect.h,
    x: rect.x,
    y: rect.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    // Never takes the remote: the compositor keeps key events away from this
    // window as well, but a focusable window would still steal them from the app
    // on any box running an older compositor.
    focusable: false,
    skipTaskbar: true,
    title: OVERLAY_TITLE,
    webPreferences: {
      preload: path.join(__dirname, "overlay", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // a note must draw at once, not at the next tick
    },
  });
  overlayWin.setIgnoreMouseEvents(true);
  // Electron sets the Wayland title from the window title, and a page's <title>
  // would otherwise win: set it again after load so the compositor's rule holds.
  overlayWin.on("page-title-updated", (e) => e.preventDefault());
  // The page sizes its text against the SCREEN, not against this strip: a strip is
  // a fraction of the screen, so a size expressed in the window's own units comes
  // out a fraction of a fraction - the first attempt drew a four-pixel letter.
  overlayWin.loadFile(path.join(__dirname, "overlay", "toast.html"), {
    query: { sh: String(screenHeight()) },
  });
  overlayWin.on("closed", () => {
    overlayWin = null;
  });
  // A renderer that died or never loaded is a window that will never show a note
  // again, and one that may be sitting on screen while it fails. Drop it: the next
  // note builds a fresh one, which is the whole cost of recovering here.
  const scrap = (why) => {
    console.warn("[notify] overlay renderer gone (" + why + ") - it will be rebuilt");
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    const dying = overlayWin;
    overlayWin = null;
    try {
      if (dying && !dying.isDestroyed()) dying.destroy();
    } catch (e) {}
  };
  overlayWin.webContents.on("render-process-gone", (_e, details) => scrap((details && details.reason) || "crashed"));
  overlayWin.webContents.on("did-fail-load", (_e, code, description) => scrap(description || String(code)));
  return overlayWin;
}

function hideOverlay() {
  clearTimeout(overlayHideTimer);
  overlayHideTimer = null;
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) overlayWin.hide();
}

// The note has finished fading out (the renderer says so). Hiding it is the
// shell's job, not the page's: a window it cannot hide is a surface the compositor
// still has to deal with.
function overlayDone(sender) {
  if (overlayWin && !overlayWin.isDestroyed() && sender === overlayWin.webContents) hideOverlay();
}

/**
 * A notification arrived (MQTT `notify`, POST /tvbox/api/notify, host.notify).
 *
 * Drawn in the overlay window so it is seen over whatever is running; `raise`
 * still brings the launcher forward, for the notes that are meant to interrupt.
 */
function handleTvNotify(payload) {
  const note = payload || {};
  // A note with no text of its own is one the LAUNCHER writes: `{kind:"lowBattery"}`
  // carries a name and a percentage, and the sentence around them is a localized
  // string that lives there, not here. Drawing it in the overlay would put an empty
  // dark bar over the film - worse than the note staying where it can be read.
  const hasText = !!(String(note.message || "").trim() || String(note.title || "").trim());
  // The launcher draws it only when the strip will not: a compositor that cannot
  // place the strip, or a note the launcher itself writes. Both at once would be
  // two notes on one screen.
  const toLauncher = () => deps.sendToLauncher("tv-notify", note);
  claimOverlayPlacement((placeable) => {
    if (!placeable || !hasText) return toLauncher();
    try {
      const w = ensureOverlayWindow();
      const show = () => {
        // Re-assert the title, and force it to CHANGE so it is actually sent.
        // Hiding a window tears its xdg_toplevel down; showing it builds a new one,
        // and Chromium does not repeat a title it believes is unchanged - so the
        // second note of a session arrived on a nameless window, which the
        // compositor rightly treated as an ordinary one. Measured: the note then
        // sat in front of the app AND took the remote from it.
        w.setTitle(OVERLAY_TITLE + " ");
        w.setTitle(OVERLAY_TITLE);
        w.showInactive(); // never takes focus, even for a moment
        w.webContents.send("overlay-note", note);
        clearTimeout(overlayHideTimer);
        // Without the backstop a renderer that died mid-note would leave a surface
        // on screen.
        const ms = Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, Number(note.duration) || DEFAULT_DURATION_MS));
        // unref: a note waiting to be taken down is not a reason for a process to
        // stay up. Electron's main loop is kept alive by the app itself, so this
        // changes nothing on the box - it is what lets this be tested in node.
        overlayHideTimer = setTimeout(hideOverlay, ms + HIDE_GRACE_MS);
        if (overlayHideTimer.unref) overlayHideTimer.unref();
      };
      if (w.webContents.isLoading()) w.webContents.once("did-finish-load", show);
      else show();
    } catch (e) {
      console.warn("[notify] overlay:", e.message);
    }
  });
  if (note.raise) deps.raiseWindow();
}

// What a plugin or a local app's POST may put on screen, capped before it gets
// anywhere near a window.
const TITLE_MAX = 120;
const MESSAGE_MAX = 400;
function sanitize(n) {
  return {
    title: String((n && n.title) || "").slice(0, TITLE_MAX),
    message: String((n && n.message) || "").slice(0, MESSAGE_MAX),
    duration: Math.max(0, Math.min(MAX_DURATION_MS, Number(n && n.duration) || 0)),
    raise: !!(n && n.raise),
  };
}

module.exports = {
  init,
  handleTvNotify,
  overlayDone,
  hideOverlay,
  overlayRect,
  sanitize,
  OVERLAY_TITLE,
  OVERLAY_HEIGHT_FRACTION,
  MIN_DURATION_MS,
  MAX_DURATION_MS,
};
