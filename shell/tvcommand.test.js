// A command that arrived from outside the box.
//
// The routing is the part worth pinning: which windows hear a transport command,
// which app the shell believes is making the sound, and the ORDER a play_media
// does its two things in - a refusal must not cost the current stream.
const test = require("node:test");
const assert = require("node:assert");

const mediastate = require("./mediastate");
const launchurl = require("./launchurl");
const tvcommand = require("./tvcommand");

function fakeWindow(id, log, opts) {
  const o = opts || {};
  return {
    id,
    isDestroyed: () => false,
    webContents: {
      isLoading: () => !!o.loading,
      once: (ev, cb) => log.push(["deferred", id, ev]) && cb(),
      send: (channel, payload) => log.push([id, channel, payload]),
    },
  };
}

function boot(opts) {
  const o = opts || {};
  const log = [];
  const player = {
    running: () => (o.playing === undefined ? false : o.playing),
    owner: () => o.owner || null,
    media: { active: !!o.mpvActive },
    setPlaying: (u) => log.push(["setPlaying", u]),
    stop: () => log.push(["stop"]),
    emit: (ev) => log.push(["emit", ev]),
    cmd: (c) => log.push(["mpv", c.command.join(" ")]),
  };
  const windows = new Map((o.windows || []).map((id) => [id, fakeWindow(id, log, o)]));
  tvcommand.init({
    player,
    ir: { send: (a, s) => (log.push(["ir", a, s]), Promise.resolve()) },
    remotefinder: {
      ring: (mac) => log.push(["ring", mac]),
      stop: () => log.push(["ringStop"]),
      capableRemotes: (cb) => cb(o.capable || []),
    },
    mediastate,
    apps: { manifestById: (id) => (o.manifests || {})[id] || null },
    launchurl,
    nowPlaying: () => o.nowPlaying || null,
    currentApp: () => o.currentApp || null,
    appWindow: (id) => windows.get(id) || null,
    launcherWebContents: () => (o.noLauncher ? null : fakeWindow("launcher", log).webContents),
    nativeRunning: () => !!o.native,
    navTo: (id, opt) => (log.push(["navTo", id, opt || null]), o.navRefuses ? false : true),
    showLauncher: () => log.push(["home"]),
    cecPower: (on) => log.push(["cec", on]),
    setVideoMode: (on) => log.push(["video", on]),
    setBoxVolume: (a, c) => log.push(["boxVolume", a, c && c.volume]),
  });
  return log;
}

const sends = (log) => log.filter((l) => l[1] === "tv-command");

// ---- who hears a transport command ----

test("the launcher and the foreground app both hear it", () => {
  const log = boot({ windows: ["plex"], currentApp: "plex" });
  tvcommand.forwardCommand({ action: "pause" });
  assert.deepEqual(
    sends(log).map((s) => s[0]),
    ["launcher", "plex"],
  );
});

test("the app making the SOUND hears it too, even with the launcher on screen", () => {
  // showLauncher nulls the foreground app while the music plays on, so this is
  // the commonest "pause the music" there is.
  const log = boot({ windows: ["media"], currentApp: null, nowPlaying: { app: "media", state: "playing" } });
  tvcommand.forwardCommand({ action: "pause" });
  assert.deepEqual(
    sends(log).map((s) => s[0]),
    ["launcher", "media"],
  );
});

test("every target is told which app the shell believes is sounding", () => {
  const log = boot({ windows: ["media"], currentApp: null, nowPlaying: { app: "media", state: "playing" } });
  tvcommand.forwardCommand({ action: "next" });
  for (const s of sends(log)) assert.equal(s[2].sounding, "media");
});

test("a claim with no live window is not broadcast - every app would stand down", () => {
  const log = boot({ windows: [], currentApp: null, nowPlaying: { app: "ghost", state: "playing" } });
  const sounding = tvcommand.forwardCommand({ action: "pause" });
  assert.equal(sounding, "");
  assert.equal(sends(log)[0][2].sounding, "");
});

test("a claim with no state at all does not qualify", () => {
  const log = boot({ windows: ["media"], currentApp: null, nowPlaying: { app: "media" } });
  assert.equal(sends(log).length, 0);
  tvcommand.forwardCommand({ action: "pause" });
  assert.equal(sends(log)[0][2].sounding, "");
});

test("a paused claim still counts", () => {
  const log = boot({ windows: ["media"], currentApp: null, nowPlaying: { app: "media", state: "paused" } });
  tvcommand.forwardCommand({ action: "play" });
  assert.equal(sends(log)[0][2].sounding, "media");
});

test("the sounding app is not sent the command twice when it is also in front", () => {
  const log = boot({ windows: ["media"], currentApp: "media", nowPlaying: { app: "media", state: "playing" } });
  tvcommand.forwardCommand({ action: "pause" });
  assert.equal(sends(log).length, 2, "the launcher and the app, once each");
});

// ---- the lyrics, the one that needs a screen ----

test("the lyrics bring the sounding app forward when the screen is free", () => {
  const log = boot({ windows: ["media"], currentApp: null, nowPlaying: { app: "media", state: "playing" } });
  tvcommand.showLyrics({ action: "lyrics", state: "on" });
  assert.deepEqual(log.filter((l) => l[0] === "navTo")[0], ["navTo", "media", null]);
});

test("...but never over a native app, which owns the box's one video plane", () => {
  const log = boot({
    windows: ["media"],
    currentApp: null,
    native: true,
    nowPlaying: { app: "media", state: "playing" },
  });
  tvcommand.showLyrics({ action: "lyrics", state: "on" });
  assert.equal(log.filter((l) => l[0] === "navTo").length, 0);
  assert.ok(sends(log).length, "the command is forwarded either way");
});

test("...nor over another app somebody is watching", () => {
  const log = boot({
    windows: ["media", "plex"],
    currentApp: "plex",
    nowPlaying: { app: "media", state: "playing" },
  });
  tvcommand.showLyrics({ action: "lyrics", state: "on" });
  assert.equal(log.filter((l) => l[0] === "navTo").length, 0);
});

test("hiding them needs no screen, so `off` never navigates", () => {
  const log = boot({ windows: ["media"], currentApp: null, nowPlaying: { app: "media", state: "playing" } });
  tvcommand.showLyrics({ action: "lyrics", state: "off" });
  assert.equal(log.filter((l) => l[0] === "navTo").length, 0);
});

test("a stale claim cannot open an app nobody has used since the last boot", () => {
  const log = boot({ windows: [], currentApp: null, nowPlaying: { app: "media", state: "playing" } });
  tvcommand.showLyrics({ action: "lyrics", state: "on" });
  assert.equal(log.filter((l) => l[0] === "navTo").length, 0);
});

// ---- play_media ----

test("a local app is opened, silenced and then handed the words - in that order", () => {
  const log = boot({
    windows: ["media"],
    playing: true,
    owner: "other",
    manifests: { media: { id: "media", status: "ready", runtime: {} } },
  });
  tvcommand.playMediaIn({ action: "play_media", app: "media", query: "Highway to Hell" });
  const order = log.map((l) => l[0]).filter((k) => k === "navTo" || k === "stop" || k === "media");
  assert.deepEqual(order, ["navTo", "stop", "media"], "the claim on the room's audio comes after the app is open");
});

test("a refusal costs nothing: nothing is silenced when the app cannot be opened", () => {
  const log = boot({
    windows: ["media"],
    playing: true,
    owner: "other",
    navRefuses: true,
    manifests: { media: { id: "media", status: "ready", runtime: {} } },
  });
  tvcommand.playMediaIn({ action: "play_media", app: "media", query: "x" });
  assert.equal(log.filter((l) => l[0] === "stop").length, 0);
});

test("the app already playing is not stopped first - that would only add a gap", () => {
  const log = boot({
    windows: ["media"],
    playing: true,
    owner: "media",
    manifests: { media: { id: "media", status: "ready", runtime: {} } },
  });
  tvcommand.playMediaIn({ action: "play_media", app: "media", query: "x" });
  assert.equal(log.filter((l) => l[0] === "stop").length, 0);
});

test("an app that is not installed and ready takes the television nowhere", () => {
  const log = boot({ manifests: {} });
  tvcommand.playMediaIn({ action: "play_media", app: "nothing", query: "x" });
  assert.deepEqual(log, []);
});

test("a remote app needs launch data, and asking with only `query` is refused before anything stops", () => {
  const m = { media: { id: "media", status: "ready", runtime: { serve: "remote" } } };
  const log = boot({ playing: true, owner: "other", manifests: m });
  tvcommand.playMediaIn({ action: "play_media", app: "media", query: "a song" });
  assert.deepEqual(log, [], "opening its front page after stopping the music is the worst answer available");
});

test("a remote app with usable launch data is opened with it", () => {
  const m = { yt: { id: "yt", status: "ready", runtime: { serve: "remote" } } };
  const log = boot({ manifests: m });
  tvcommand.playMediaIn({ action: "play_media", app: "yt", launch: "v=abc123" });
  assert.deepEqual(log[0], ["navTo", "yt", { query: "v=abc123" }]);
});

test("launch data withLaunchQuery cannot use is refused rather than opening a front page", () => {
  const m = { yt: { id: "yt", status: "ready", runtime: { serve: "remote" } } };
  for (const launch of ["   ", "a b", ""]) {
    const log = boot({ manifests: m });
    tvcommand.playMediaIn({ action: "play_media", app: "yt", launch });
    assert.deepEqual(log, [], JSON.stringify(launch));
  }
});

// ---- the switch ----

test("pause and play reach mpv AND the app that owns the queue", () => {
  const log = boot({ windows: ["media"], currentApp: "media" });
  tvcommand.handle({ action: "pause" });
  assert.deepEqual(log[0], ["mpv", "set_property pause true"]);
  assert.ok(sends(log).length);
});

test("stop says WHY, so an app does not advance to the next episode", () => {
  const log = boot({ windows: [], currentApp: null });
  tvcommand.handle({ action: "stop" });
  assert.deepEqual(log.find((l) => l[0] === "emit")[1], { type: "finished", reason: "stopped" });
});

test("next, previous, shuffle and repeat are only forwarded - the app holds the queue", () => {
  for (const action of ["next", "previous", "shuffle", "repeat"]) {
    const log = boot({ windows: ["media"], currentApp: "media" });
    tvcommand.handle({ action });
    assert.equal(log.filter((l) => l[0] === "mpv").length, 0, action);
    assert.ok(sends(log).length, action);
  }
});

test("the TV's own volume goes over IR; the box's own goes to the sink", () => {
  const log = boot();
  tvcommand.handle({ action: "volume_up", steps: 3 });
  tvcommand.handle({ action: "volume_set", volume: 0.4 });
  assert.deepEqual(log[0], ["ir", "volume_up", 3]);
  assert.deepEqual(log[1], ["boxVolume", "volume_set", 0.4]);
});

test("seek is absolute seconds, and anything else is refused rather than sent as null", () => {
  // NaN does not survive stringify, so a non-numeric position would reach mpv as
  // JSON null; Number(null) and Number("") are both a silent seek to the start.
  const log = boot({ mpvActive: true });
  tvcommand.handle({ action: "seek", position: 61 });
  assert.deepEqual(log[0], ["mpv", "seek 61 absolute"]);
  for (const position of ["61", null, undefined, "", NaN, {}]) {
    const l2 = boot({ mpvActive: true });
    tvcommand.handle({ action: "seek", position });
    assert.equal(l2.filter((x) => x[0] === "mpv").length, 0, JSON.stringify(position));
  }
});

test("a negative seek is refused", () => {
  const log = boot({ mpvActive: true });
  tvcommand.handle({ action: "seek", position: -5 });
  assert.equal(log.filter((x) => x[0] === "mpv").length, 0);
});

test("seek does nothing while WE do not hold the clock", () => {
  const log = boot({ mpvActive: false });
  tvcommand.handle({ action: "seek", position: 10 });
  assert.equal(log.filter((x) => x[0] === "mpv").length, 0);
});

test("find_remote rings the first capable remote when none is named", () => {
  const log = boot({ capable: ["AA:BB", "CC:DD"] });
  tvcommand.handle({ action: "find_remote" });
  assert.deepEqual(log[0], ["ring", "AA:BB"]);
});

test("find_remote with a mac rings that one; a stop needs no mac at all", () => {
  const log = boot();
  tvcommand.handle({ action: "find_remote", mac: "11:22" });
  tvcommand.handle({ action: "find_remote_stop", mac: { not: "a string" } });
  assert.deepEqual(log[0], ["ring", "11:22"]);
  assert.deepEqual(log[1], ["ringStop"]);
});

test("a mac that is not a string never reaches a write", () => {
  const log = boot({ capable: [] });
  tvcommand.handle({ action: "find_remote", mac: { toString: () => "x" } });
  assert.equal(log.filter((l) => l[0] === "ring").length, 0);
});

test("tv_on/tv_off and home do what they say; an unknown action does nothing", () => {
  const log = boot();
  tvcommand.handle({ action: "tv_on" });
  tvcommand.handle({ action: "standby" });
  tvcommand.handle({ action: "home" });
  tvcommand.handle({ action: "self_destruct" });
  tvcommand.handle(null);
  assert.deepEqual(log, [["cec", true], ["cec", false], ["home"]]);
});

test("launch opens the app it names, and nothing without one", () => {
  const log = boot();
  tvcommand.handle({ action: "launch", app: "plex" });
  tvcommand.handle({ action: "open" });
  assert.deepEqual(log, [["navTo", "plex", null]]);
});
