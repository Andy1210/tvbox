// The note that appears over everything.
//
// Two decisions decide whether it is worth having a window of its own at all: the
// strip is SMALL (a fullscreen translucent surface over a 4K film is the composited
// pass the whole compositor exists to avoid), and a box whose compositor cannot
// place it keeps the note in the launcher rather than mapping one fullscreen.
const test = require("node:test");
const assert = require("node:assert");

const notify = require("./notify");

function fakeWindow(log) {
  let destroyed = false;
  const handlers = {};
  const wc = {
    isLoading: () => false,
    once: (ev, cb) => (handlers[ev] = cb),
    on: (ev, cb) => (handlers["wc:" + ev] = cb),
    send: (channel, payload) => log.push(["send", channel, payload]),
  };
  return {
    handlers,
    webContents: wc,
    isDestroyed: () => destroyed,
    isVisible: () => true,
    setIgnoreMouseEvents: () => {},
    on: (ev, cb) => (handlers[ev] = cb),
    loadFile: (f, opts) => log.push(["load", opts && opts.query]),
    setTitle: (t) => log.push(["title", t]),
    showInactive: () => log.push(["show"]),
    hide: () => log.push(["hide"]),
    destroy: () => (destroyed = true),
  };
}

function boot(opts) {
  const o = opts || {};
  const log = [];
  let made = null;
  notify.init({
    BrowserWindow: function () {
      made = fakeWindow(log);
      log.push(["new", arguments[0]]);
      return made;
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: o.w || 3840, height: o.h || 2160 } }) },
    compositor: {
      available: () => o.compositor !== false,
      placeWindowByTitle: (title, rect, cb) => {
        log.push(["place", title, rect]);
        cb(o.places !== false, o.places === false ? "too old" : null);
      },
    },
    sendToLauncher: (channel, payload) => (log.push(["launcher", channel, payload]), true),
    raiseWindow: () => log.push(["raise"]),
  });
  return { log, window: () => made };
}

// The placement answer is remembered for the life of the process, so each case
// gets a fresh module.
function fresh() {
  delete require.cache[require.resolve("./notify")];
  return require("./notify");
}

// ---- the strip ----

test("the strip is a slice at the bottom, and never thinner than two lines", () => {
  boot({ w: 3840, h: 2160 });
  const r = notify.overlayRect();
  assert.equal(r.x, 0);
  assert.equal(r.w, 3840);
  assert.equal(r.h, Math.round(2160 * notify.OVERLAY_HEIGHT_FRACTION));
  assert.equal(r.y, 2160 - r.h);
  boot({ w: 640, h: 200 });
  assert.equal(notify.overlayRect().h, 160, "a floor, so two lines still fit on a small output");
  assert.equal(notify.overlayRect().y, 40);
});

test("a screen shorter than the floor still gives a rect that starts on screen", () => {
  boot({ w: 640, h: 100 });
  const r = notify.overlayRect();
  assert.equal(r.y, 0);
});

// ---- where a note is drawn ----

test("with a compositor that can place it, the note goes to the strip", () => {
  const n = fresh();
  const { log } = (() => {
    const b = boot();
    return b;
  })();
  n.init({
    BrowserWindow: function () {
      return fakeWindow(log);
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
    compositor: { available: () => true, placeWindowByTitle: (t, r, cb) => cb(true, null) },
    sendToLauncher: (c, p) => log.push(["launcher", c, p]),
    raiseWindow: () => {},
  });
  n.handleTvNotify({ title: "Doorbell", message: "Somebody is at the door" });
  assert.ok(
    log.find((l) => l[0] === "show"),
    "the note is shown without taking focus",
  );
  assert.ok(log.find((l) => l[0] === "send" && l[1] === "overlay-note"));
  assert.equal(log.filter((l) => l[0] === "launcher").length, 0, "two notes on one screen would be one too many");
});

test("a compositor that cannot place it keeps the note in the launcher", () => {
  const n = fresh();
  const log = [];
  n.init({
    BrowserWindow: function () {
      log.push(["new"]);
      return fakeWindow(log);
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
    compositor: { available: () => true, placeWindowByTitle: (t, r, cb) => cb(false, "too old") },
    sendToLauncher: (c, p) => log.push(["launcher", c, p]),
    raiseWindow: () => {},
  });
  n.handleTvNotify({ message: "hello" });
  assert.deepEqual(
    log.filter((l) => l[0] === "new"),
    [],
    "a box on an older compositor would map it FULLSCREEN",
  );
  assert.ok(log.find((l) => l[0] === "launcher" && l[1] === "tv-notify"));
});

test("no compositor at all is the same answer", () => {
  const n = fresh();
  const log = [];
  n.init({
    BrowserWindow: function () {
      log.push(["new"]);
      return fakeWindow(log);
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
    compositor: { available: () => false, placeWindowByTitle: () => assert.fail("should not be asked") },
    sendToLauncher: (c, p) => log.push(["launcher", c, p]),
    raiseWindow: () => {},
  });
  n.handleTvNotify({ message: "hello" });
  assert.ok(log.find((l) => l[0] === "launcher"));
});

test("a note with no text of its own is the launcher's to write", () => {
  // `{kind:"lowBattery"}` carries a name and a percentage; the sentence around them
  // is a localized string that lives there. In the strip it would be an empty bar.
  const n = fresh();
  const log = [];
  n.init({
    BrowserWindow: function () {
      log.push(["new"]);
      return fakeWindow(log);
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
    compositor: { available: () => true, placeWindowByTitle: (t, r, cb) => cb(true, null) },
    sendToLauncher: (c, p) => log.push(["launcher", c, p]),
    raiseWindow: () => {},
  });
  n.handleTvNotify({ kind: "lowBattery", name: "Remote", battery: 9 });
  n.handleTvNotify({ title: "   ", message: "  " });
  assert.deepEqual(
    log.filter((l) => l[0] === "new"),
    [],
  );
  assert.equal(log.filter((l) => l[0] === "launcher").length, 2);
});

test("a note that asks to interrupt raises the launcher as well", () => {
  const n = fresh();
  const log = [];
  n.init({
    BrowserWindow: function () {
      return fakeWindow(log);
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
    compositor: { available: () => true, placeWindowByTitle: (t, r, cb) => cb(true, null) },
    sendToLauncher: () => {},
    raiseWindow: () => log.push(["raise"]),
  });
  n.handleTvNotify({ message: "x", raise: true });
  assert.ok(log.find((l) => l[0] === "raise"));
  n.handleTvNotify({ message: "y" });
  assert.equal(log.filter((l) => l[0] === "raise").length, 1);
});

test("the title is re-asserted and forced to CHANGE, or the second note lands nameless", () => {
  // Hiding a window tears its xdg_toplevel down and Chromium does not repeat a
  // title it believes is unchanged - the note then sits in front of the app AND
  // takes the remote from it.
  const n = fresh();
  const log = [];
  n.init({
    BrowserWindow: function () {
      return fakeWindow(log);
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
    compositor: { available: () => true, placeWindowByTitle: (t, r, cb) => cb(true, null) },
    sendToLauncher: () => {},
    raiseWindow: () => {},
  });
  n.handleTvNotify({ message: "x" });
  const titles = log.filter((l) => l[0] === "title").map((l) => l[1]);
  // The first of the three is the name being asked for at all: no window may be
  // BORN with it, so this one takes it a moment after construction instead of
  // through a constructor option. The pair after it is the forced change.
  assert.deepEqual(titles, [n.OVERLAY_TITLE, n.OVERLAY_TITLE + " ", n.OVERLAY_TITLE]);
});

test("the window is placed before it maps, and asked for only once", () => {
  const n = fresh();
  const log = [];
  n.init({
    BrowserWindow: function () {
      return fakeWindow(log);
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
    compositor: { available: () => true, placeWindowByTitle: (t, r, cb) => (log.push(["place"]), cb(true, null)) },
    sendToLauncher: () => {},
    raiseWindow: () => {},
  });
  n.handleTvNotify({ message: "a" });
  n.handleTvNotify({ message: "b" });
  assert.equal(log.filter((l) => l[0] === "place").length, 1, "a window is positioned as it appears");
});

// ---- what a plugin or a page may put on screen ----

test("a note from a plugin is capped before it gets near a window", () => {
  const n = notify.sanitize({ title: "t".repeat(500), message: "m".repeat(9999), duration: 99999999, raise: 1 });
  assert.equal(n.title.length, 120);
  assert.equal(n.message.length, 400);
  assert.equal(n.duration, notify.MAX_DURATION_MS);
  assert.equal(n.raise, true);
});

test("a note with nothing in it sanitizes to empty rather than to `undefined`", () => {
  assert.deepEqual(notify.sanitize(null), { title: "", message: "", duration: 0, raise: false });
  assert.deepEqual(notify.sanitize({ duration: "soon" }), { title: "", message: "", duration: 0, raise: false });
});

test("a negative duration is not a negative timeout", () => {
  assert.equal(notify.sanitize({ duration: -5 }).duration, 0);
});

// ---- the one window title that is not the page's to take ----

test("a page may not name its window into the compositor's overlay slot", () => {
  // Every Electron window here presents the same Wayland app id, so the title is
  // the only thing that marks the note. A page taking that name is drawn over
  // everything AND left out of keyboard focus - with an app fullscreen the
  // launcher's window is gone, so nothing on screen would answer the remote.
  assert.equal(notify.titleAllowed(notify.OVERLAY_TITLE), false);
});

test("every other title stays the page's own", () => {
  assert.equal(notify.titleAllowed("RetroArch"), true);
  assert.equal(notify.titleAllowed("tvbox"), true);
  // Near misses are the page's too. The compositor compares the name exactly, and
  // what reaches it is what reaches this function: Chromium canonicalises a title
  // before it becomes the window's, so there is no spelling that arrives here as a
  // near miss and lands there as the real thing. Refusing more than the reserved
  // name would take an app's own name away for nothing.
  assert.equal(notify.titleAllowed("tvbox-overlay "), true);
  assert.equal(notify.titleAllowed("TVBOX-OVERLAY"), true);
  assert.equal(notify.titleAllowed(""), true);
  assert.equal(notify.titleAllowed(null), true);
  assert.equal(notify.titleAllowed(undefined), true);
});

test("not even the note is BORN with the name - it asks for it after", () => {
  // A window's title can arrive through the BrowserWindow constructor as well as
  // from a page, and `window.open`'s feature string reaches that constructor
  // unfiltered - so the reserved name is kept out of the options a window is built
  // with. That leaves nothing able to repair a window that IS built with it, which
  // is why the one window entitled to the name asks for it a moment later instead.
  const n = fresh();
  const log = [];
  const options = [];
  n.init({
    BrowserWindow: function (opts) {
      options.push(opts);
      return fakeWindow(log);
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
    compositor: { available: () => true, placeWindowByTitle: (t, r, cb) => cb(true, null) },
    sendToLauncher: () => {},
    raiseWindow: () => {},
  });
  n.handleTvNotify({ message: "x" });

  assert.equal(options.length, 1);
  assert.equal(options[0].title, undefined);
  assert.equal(
    log.filter((l) => l[0] === "title")[0][1],
    n.OVERLAY_TITLE,
    "the name goes on straight after construction, before the window is ever shown",
  );
});
