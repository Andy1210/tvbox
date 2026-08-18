// appwindows.js policy tests with fake BrowserWindows - the hidden-set cap,
// RAM-guard eviction, the disabled->destroy rollback path, and registry
// hygiene. Real window mechanics (show/stacking) are on-device territory.
const test = require("node:test");
const assert = require("node:assert");
const appwins = require("./appwindows");

function fakeWin() {
  const win = {
    destroyed: false,
    visible: true,
    muted: false,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    hide() {
      this.visible = false;
    },
    destroy() {
      this.destroyed = true;
    },
    webContents: {
      setAudioMuted(v) {
        win.muted = v; // record on the window so a hidden-but-audible app fails the test
      },
      executeJavaScript() {
        return Promise.resolve();
      },
    },
  };
  return win;
}

// 8GB-box limits (maxHidden 6) unless a test overrides memInfo
let mem = { totalKb: 8 * 1024 * 1024, availableKb: 4 * 1024 * 1024 };
let enabled = true;
let fg = null;
let playing = null;

test("setup", () => {
  appwins.init({
    enabled: () => enabled,
    memInfo: () => mem,
    foregroundId: () => fg,
    playingId: () => playing,
  });
});

test("background hides and mutes; destroy removes from the registry", () => {
  const w = fakeWin();
  appwins.register("plex", w);
  assert.equal(appwins.get("plex"), w);
  appwins.background("plex");
  assert.equal(w.visible, false);
  assert.equal(w.muted, true, "a backgrounded app must be muted");
  assert.equal(w.destroyed, false);
  assert.ok(appwins.runningIds().includes("plex"));
  appwins.destroy("plex");
  assert.equal(w.destroyed, true);
  assert.equal(appwins.get("plex"), null);
});

test("backgrounding disabled = the old destroy-on-leave behavior", () => {
  enabled = false;
  const w = fakeWin();
  appwins.register("youtube", w);
  appwins.background("youtube");
  assert.equal(w.destroyed, true);
  assert.equal(appwins.get("youtube"), null);
  enabled = true;
});

test("RAM guard evicts the least-recently-shown hidden app, one per tick", () => {
  const a = fakeWin();
  const b = fakeWin();
  appwins.register("a", a);
  appwins.register("b", b);
  appwins.get("a").tvboxLastShown = 1000;
  appwins.get("b").tvboxLastShown = 2000;
  appwins.background("a");
  appwins.background("b");
  mem = { totalKb: 8 * 1024 * 1024, availableKb: 100 * 1024 }; // way under the floor
  appwins.ramGuardTick();
  assert.equal(a.destroyed, true, "oldest hidden goes first");
  assert.equal(b.destroyed, false, "one eviction per tick");
  mem = { totalKb: 8 * 1024 * 1024, availableKb: 4 * 1024 * 1024 };
  appwins.destroy("b");
});

test("RAM guard never evicts the foreground app", () => {
  const a = fakeWin();
  a.visible = false; // hidden but foreground (transition moment)
  appwins.register("livetv", a);
  fg = "livetv";
  mem = { totalKb: 8 * 1024 * 1024, availableKb: 100 * 1024 };
  appwins.ramGuardTick();
  assert.equal(a.destroyed, false);
  fg = null;
  mem = { totalKb: 8 * 1024 * 1024, availableKb: 4 * 1024 * 1024 };
  appwins.destroy("livetv");
});

test("the app whose sound is playing is spared, hidden or not", () => {
  // Music outlives leaving the app, so a hidden media client is not an idle
  // window: it is what moves the queue to the next track and what a phone's
  // pause reaches. Dropped, the album plays on out of a box with nothing left
  // to stop it - which is worse than the memory it costs.
  //
  // The cap here is the 8GB box's six, not a number this test picks: limitsFor()
  // caches on first use, so an earlier test in this file has already fixed it.
  for (const id of appwins.runningIds()) appwins.destroy(id);
  playing = "music";
  fg = null;
  const wins = {};
  for (const id of ["music", "a", "b", "c", "d", "e", "f", "g"]) {
    wins[id] = fakeWin();
    appwins.register(id, wins[id]);
    appwins.background(id); // all hidden, "music" the least recently shown
  }

  // The spared app is not part of the evictable set at all, so the cap of six
  // applies to the OTHERS: eight windows leave seven, one dropped. That is the
  // deliberate shape - a box playing music holds one window more than a silent
  // one - and it is why the count is asserted rather than left to a comment.
  // WHICH one goes is not asserted: every window here is registered in the same
  // millisecond, so the least-recently-shown order among them is a tie the sort
  // is free to break either way.
  assert.equal(wins.music.destroyed, false, "the playing app survives the cap");
  const gone = () => Object.values(wins).filter((w) => w.destroyed).length;
  assert.equal(gone(), 1, "the cap applied to the rest");

  // And under memory pressure, which is the other way a hidden app is dropped.
  const was = mem;
  mem = { totalKb: 8 * 1024 * 1024, availableKb: 1 };
  appwins.ramGuardTick();
  assert.equal(wins.music.destroyed, false, "the playing app survives low memory");
  assert.equal(gone(), 2, "something else went instead");

  // Nothing playing: it is an ordinary hidden app again.
  // Nothing playing: it is the least recently shown hidden app again, and the
  // guard reaches it.
  playing = null;
  for (let i = 0; i < 8 && !wins.music.destroyed; i++) appwins.ramGuardTick();
  assert.equal(wins.music.destroyed, true);
  mem = was;
});
