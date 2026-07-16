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

test("setup", () => {
  appwins.init({ enabled: () => enabled, memInfo: () => mem, foregroundId: () => fg });
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
