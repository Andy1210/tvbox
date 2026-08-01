const { test } = require("node:test");
const assert = require("node:assert");
const ms = require("./mediastate");

// The merge rules: which of the three sources owns which field, and when a change
// is worth putting on a retained topic.

test("nothing playing is idle, not a stale title", () => {
  const s = ms.compose({ nowPlaying: { app: "spotify", state: "idle", title: "Old song" } });
  assert.equal(s.state, "idle");
  assert.equal(s.title, "Old song"); // the app still says what it last had loaded
  assert.equal(s.position, null);
});

test("mpv owns the clock, the app owns the metadata", () => {
  const s = ms.compose({
    nowPlaying: { app: "plex", state: "playing", title: "A film", artist: "Someone" },
    mpv: { active: true, paused: false, position: 61.4, duration: 5400 },
  });
  assert.equal(s.state, "playing");
  assert.equal(s.title, "A film");
  assert.equal(s.position, 61);
  assert.equal(s.duration, 5400);
  assert.equal(s.seekable, true);
});

test("mpv paused wins over an app that still claims to be playing", () => {
  const s = ms.compose({
    nowPlaying: { app: "plex", state: "playing", title: "A film" },
    mpv: { active: true, paused: true, position: 10, duration: 100 },
  });
  assert.equal(s.state, "paused");
});

// librespot plays its own audio, so there is no mpv to observe: the app's own
// position is the only one there is, and nothing is seekable through us.
test("an app playing its own audio reports its own position, unseekable", () => {
  const s = ms.compose({
    nowPlaying: { app: "spotify", state: "playing", title: "A song", position: 12, duration: 200 },
  });
  assert.equal(s.state, "playing");
  assert.equal(s.position, 12);
  assert.equal(s.duration, 200);
  assert.equal(s.seekable, false);
});

test("a live stream with no duration is not seekable", () => {
  const s = ms.compose({ mpv: { active: true, paused: false, position: 30, duration: null } });
  assert.equal(s.seekable, false);
});

test("volume comes from the sink and is rounded, not floated", () => {
  const s = ms.compose({ volume: 0.4321, muted: true });
  assert.equal(s.volume, 0.43);
  assert.equal(s.muted, true);
});

// PipeWire allows a sink above 1.0; the topic documents 0..1 and every consumer
// treats it that way, so the payload has to match its own contract.
test("a sink louder than 1.0 is clamped, not published as-is", () => {
  assert.equal(ms.compose({ volume: 1.4 }).volume, 1);
  assert.equal(ms.compose({ volume: -0.2 }).volume, 0);
  assert.equal(ms.compose({ volume: Infinity }).volume, null);
  assert.equal(ms.compose({ volume: NaN }).volume, null);
});

test("junk in the snapshot does not become junk in the payload", () => {
  const s = ms.compose({ nowPlaying: "not an object", mpv: 7, volume: "loud", currentApp: 42 });
  assert.equal(s.state, "idle");
  assert.equal(s.title, null);
  assert.equal(s.volume, null);
  assert.equal(s.source, null);
  assert.deepEqual(s.sourceList, []);
});

// A retained topic that republished every second would be pure noise; anything
// other than the clock is news the moment it changes.
test("a position that crept forward is not worth publishing", () => {
  const a = ms.compose({ mpv: { active: true, position: 10, duration: 100 } });
  const b = ms.compose({ mpv: { active: true, position: 12, duration: 100 } });
  assert.equal(ms.worthPublishing(a, b), false);
});

test("a position that jumped IS worth publishing (a seek)", () => {
  const a = ms.compose({ mpv: { active: true, position: 10, duration: 100 } });
  const b = ms.compose({ mpv: { active: true, position: 10 + ms.POSITION_EPS_S, duration: 100 } });
  assert.equal(ms.worthPublishing(a, b), true);
});

test("any non-clock change is worth publishing at once", () => {
  const base = { nowPlaying: { app: "spotify", state: "playing", title: "One" }, volume: 0.5 };
  const a = ms.compose(base);
  assert.equal(ms.worthPublishing(a, ms.compose({ ...base, nowPlaying: { ...base.nowPlaying, title: "Two" } })), true);
  assert.equal(ms.worthPublishing(a, ms.compose({ ...base, volume: 0.6 })), true);
  assert.equal(ms.worthPublishing(a, ms.compose({ ...base, currentApp: "plex" })), true);
  assert.equal(ms.worthPublishing(a, ms.compose({ ...base, sources: [{ id: "plex", name: "Plex" }] })), true);
  assert.equal(ms.worthPublishing(a, ms.compose(base)), false);
});

test("the first state is always published", () => {
  assert.equal(ms.worthPublishing(null, ms.compose({})), true);
});

// Playback stopping must reach the topic: a retained state still reporting a
// position is a Home Assistant card showing a film nobody is watching.
test("going from playing to idle is worth publishing", () => {
  const a = ms.compose({ mpv: { active: true, position: 50, duration: 100 } });
  const b = ms.compose({ mpv: { active: false } });
  assert.equal(ms.worthPublishing(a, b), true);
  assert.equal(b.state, "idle");
  assert.equal(b.position, null);
});
