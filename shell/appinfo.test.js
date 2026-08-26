// What the shell says about an installed app.
//
// This became testable by moving out of main.js: every module it reads is
// injected, so a manifest set plus a config plus an install state is a whole box.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const appinfo = require("./appinfo");

// A manifest set, a config and an install state, as small as each case needs.
function box(opts) {
  const o = opts || {};
  const manifests = o.manifests || [];
  const state = {
    switches: o.switches || {},
    appConfig: o.appConfig || {},
    installed: new Set(o.installed || []),
    installing: new Set(o.installing || []),
    missing: o.missing || {},
    windows: new Set(o.windows || []),
    nativeId: o.nativeId || null,
    foreground: o.foreground || null,
    plugins: new Set(o.plugins || []),
  };
  appinfo.init({
    apps: {
      getManifests: () => manifests,
      manifestById: (id) => manifests.find((m) => m.id === id) || null,
      appDeps: (m) => {
        const miss = state.missing[m.id] || [];
        return { depsOk: !miss.length, missing: miss, installable: true };
      },
      isInstalled: (id) => state.installed.has(id),
    },
    config: {
      appSwitches: (id) => state.switches[id] || {},
      appConfig: (key) => state.appConfig[key] || null,
    },
    maintenance: {
      isInstalling: (id) => state.installing.has(id),
      progressFor: () => null,
    },
    isPluginLoaded: (id) => state.plugins.has(id),
    hasWindow: (id) => state.windows.has(id),
    nativeAppId: () => state.nativeId,
    foregroundId: () => state.foreground,
  });
  return state;
}

const ready = (id, extra) => ({ id, name: id, type: "webclient", status: "ready", ...(extra || {}) });

// ---- capsFor: hard rule 2, and it fails CLOSED ----

test("the launcher gets player and config; an app gets only what it declared", () => {
  box({ manifests: [ready("plex", { runtime: { capabilities: ["nav", "player"] } })] });
  assert.deepEqual(appinfo.capsFor(null), ["nav", "player", "config"]);
  assert.deepEqual(appinfo.capsFor("plex"), ["nav", "player"]);
});

test("a manifest that forgets capabilities gets nav only - it must not inherit the launcher's", () => {
  box({ manifests: [ready("thing", { runtime: {} }), ready("bare")] });
  assert.deepEqual(appinfo.capsFor("thing"), ["nav"]);
  assert.deepEqual(appinfo.capsFor("bare"), ["nav"]);
});

test("an id no manifest claims gets nav only", () => {
  box({ manifests: [] });
  assert.deepEqual(appinfo.capsFor("ghost"), ["nav"]);
});

// ---- switchValue ----

test("an undeclared switch is off, whatever the box has stored", () => {
  const m = ready("app", { switches: [{ key: "real" }] });
  box({ manifests: [m], switches: { app: { fake: true } } });
  assert.equal(appinfo.switchValue(m, "fake"), false);
});

test("a declared switch with nothing stored takes the manifest's default", () => {
  const m = ready("app", { switches: [{ key: "on", default: true }, { key: "off" }] });
  box({ manifests: [m] });
  assert.equal(appinfo.switchValue(m, "on"), true);
  assert.equal(appinfo.switchValue(m, "off"), false, "a switch that appears with a release must not turn something on");
});

test("what the box stored beats the default, including a stored false", () => {
  const m = ready("app", { switches: [{ key: "k", default: true }] });
  box({ manifests: [m], switches: { app: { k: false } } });
  assert.equal(appinfo.switchValue(m, "k"), false);
});

test("a key that names something every object has is not a stored value", () => {
  // `in` walks the prototype chain, so "constructor"/"toString" would read as
  // stored - and truthy - whatever the box actually saved.
  const m = ready("app", { switches: [{ key: "constructor" }, { key: "toString", default: true }] });
  box({ manifests: [m], switches: { app: {} } });
  assert.equal(appinfo.switchValue(m, "constructor"), false);
  assert.equal(appinfo.switchValue(m, "toString"), true, "the manifest's default, not Object.prototype.toString");
});

// ---- appLaunchable / isConfigured ----

test("launchable needs ready status, its deps, and its bundle", () => {
  const good = ready("a", { install: { source: { url: "x" } } });
  const noDeps = ready("b");
  const notInstalled = ready("c", { install: { source: { url: "x" } } });
  const installing = ready("d");
  const notReady = { id: "e", name: "e", type: "webclient", status: "draft" };
  box({
    manifests: [good, noDeps, notInstalled, installing, notReady],
    installed: ["a"],
    missing: { b: ["rclone"] },
    installing: ["d"],
  });
  assert.equal(appinfo.appLaunchable(good), true);
  assert.equal(appinfo.appLaunchable(noDeps), false);
  assert.equal(appinfo.appLaunchable(notInstalled), false);
  assert.equal(appinfo.appLaunchable(installing), false);
  assert.equal(appinfo.appLaunchable(notReady), false);
});

test("a remote app whose url comes from config is unconfigured until it is set", () => {
  const m = ready("ha", { runtime: { serve: "remote", urlConfig: "homeassistant" } });
  box({ manifests: [m] });
  assert.equal(appinfo.isConfigured(m), false);
  assert.equal(appinfo.appLaunchable(m), false);
  box({ manifests: [m], appConfig: { homeassistant: { baseUrl: "http://ha.local" } } });
  assert.equal(appinfo.isConfigured(m), true);
  assert.equal(appinfo.appLaunchable(m), true);
});

test("everything else is configured, so the gate only covers what needs it", () => {
  const literal = ready("yt", { runtime: { serve: "remote", url: "https://youtube.com/tv" } });
  box({ manifests: [literal] });
  assert.equal(appinfo.isConfigured(literal), true);
});

// ---- the source list HOME and Home Assistant share ----

test("the media sources are exactly what HOME would open", () => {
  const ok = ready("a");
  const broken = ready("b");
  box({ manifests: [ok, broken], missing: { b: ["mpv"] } });
  assert.deepEqual(
    appinfo.mediaSources().map((s) => s.id),
    ["a"],
  );
});

test("a localized name is unwrapped, and one with no name at all is dropped", () => {
  box({
    manifests: [
      ready("a", { name: { en: "Films", hu: "Filmek" } }),
      ready("b", { name: null }),
      ready("c", { name: "Plain" }),
    ],
  });
  assert.deepEqual(appinfo.mediaSources(), [
    { id: "a", name: "Films" },
    { id: "c", name: "Plain" },
  ]);
});

test("the source list is bounded - it goes into a retained payload", () => {
  box({ manifests: Array.from({ length: appinfo.MAX_MEDIA_SOURCES + 20 }, (_, i) => ready("a" + i)) });
  assert.equal(appinfo.mediaSources().length, appinfo.MAX_MEDIA_SOURCES);
});

// ---- running, per app kind ----

test("a native app's own process is what running means; a web app's window is", () => {
  box({
    manifests: [ready("game", { type: "native" }), ready("web")],
    nativeId: "game",
    windows: ["web"],
  });
  assert.equal(appinfo.appRunning("game"), true);
  assert.equal(appinfo.appRunning("web"), true);
  box({ manifests: [ready("game", { type: "native" })], nativeId: "other", windows: ["game"] });
  assert.equal(appinfo.appRunning("game"), false, "a native app with a window of ours is not what running means");
});

test("an id no manifest claims falls back to the window test", () => {
  // A plugin can ask about an app whose manifest has gone while its window lives.
  box({ manifests: [], windows: ["orphan"] });
  assert.equal(appinfo.appRunning("orphan"), true);
  assert.equal(appinfo.appRunning("nothing"), false);
});

// ---- the tiles ----

test("a tile reports its switch as unavailable while its plugin is not loaded", () => {
  const m = ready("spotify", { service: "spotify", switches: [{ key: "shuffle", label: "Shuffle" }] });
  box({ manifests: [m] });
  assert.equal(appinfo.appTiles()[0].switches[0].available, false);
  box({ manifests: [m], plugins: ["spotify"] });
  assert.equal(appinfo.appTiles()[0].switches[0].available, true);
});

test("a tile's `ready` is appLaunchable, so HOME and the media_player cannot drift", () => {
  const m = ready("a", { install: { source: { url: "x" } } });
  box({ manifests: [m] });
  assert.equal(appinfo.appTiles()[0].ready, appinfo.appLaunchable(m));
  assert.equal(appinfo.appTiles()[0].ready, false);
});

test("a manifest with no switches and no pairing reports neither, rather than empty lists", () => {
  box({ manifests: [ready("a")] });
  const t = appinfo.appTiles()[0];
  assert.equal(t.switches, undefined);
  assert.equal(t.pairing, undefined);
});

// ---- bridgePath: the value reaches require() ----

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-appinfo-"));
fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
fs.writeFileSync(path.join(dir, "bridge.js"), "");
fs.writeFileSync(path.join(dir, "sub", "deep.js"), "");

test("a bridge is the file the manifest names, next to the manifest", () => {
  assert.equal(appinfo.bridgePath({ _dir: dir, runtime: { bridge: "./bridge.js" } }), path.join(dir, "bridge.js"));
});

test("a manifest with no dir of its own cannot have a bridge", () => {
  assert.equal(appinfo.bridgePath({ runtime: { bridge: "./bridge.js" } }), null);
});

test("no traversal, no subdirectory, no other extension", () => {
  const refuse = ["../bridge.js", "./sub/deep.js", "./bridge.mjs", "/etc/passwd", "bridge.js", "./Bridge.js"];
  for (const name of refuse) {
    assert.equal(appinfo.bridgePath({ _dir: dir, runtime: { bridge: name } }), null, "should refuse " + name);
  }
});

test("a file that is not there is not a bridge", () => {
  assert.equal(appinfo.bridgePath({ _dir: dir, runtime: { bridge: "./missing.js" } }), null);
});

test("no bridge declared, nothing resolved", () => {
  assert.equal(appinfo.bridgePath({ _dir: dir, runtime: {} }), null);
  assert.equal(appinfo.bridgePath(null), null);
});

// ---- the rest of the manifest reads ----

test("the root web app is the ready webclient mounted at root", () => {
  box({
    manifests: [
      ready("a", { runtime: { mount: "root" }, status: "draft" }),
      ready("plex", { runtime: { mount: "root" } }),
      ready("b", { runtime: { mount: "root" } }),
    ],
  });
  assert.equal(appinfo.rootWebApp().id, "plex");
});

test("the transparent selector is the manifest's, and there is none by default", () => {
  box({ manifests: [ready("plex", { runtime: { transparentSelector: "#media-container" } }), ready("plain")] });
  assert.equal(appinfo.transparentSelectorFor("plex"), "#media-container");
  assert.equal(appinfo.transparentSelectorFor("plain"), null);
  assert.equal(appinfo.transparentSelectorFor(null), null);
});
