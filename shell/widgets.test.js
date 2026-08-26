// The cards on HOME.
//
// The derived one - an app's card while its sound plays - has two rules that were
// both wrong in the first cut: who a card is about has to be REMEMBERED (every
// report that clears one arrives after mpv has gone), and only sound gets one.
const test = require("node:test");
const assert = require("node:assert");

const cards = require("./widgets");

function boot(opts) {
  const o = opts || {};
  const sent = [];
  const state = {
    running: !!o.running,
    audioOnly: o.audioOnly !== false,
    owner: o.owner === undefined ? "plex" : o.owner,
  };
  cards.init({
    send: (channel, payload) => sent.push([channel, payload]),
    playerRunning: () => state.running,
    playerIsAudioOnly: () => state.audioOnly,
    playerOwner: () => state.owner,
  });
  return { sent, state };
}

const lists = (sent) => sent.filter((s) => s[0] === "widgets").map((s) => s[1]);

test("a card is pushed, and taken down by an empty one", () => {
  const { sent } = boot();
  cards.setWidget("spotify", { title: "A song", subtitle: "Someone" });
  assert.deepEqual(cards.widgetList(), [{ id: "spotify", title: "A song", subtitle: "Someone" }]);
  cards.setWidget("spotify", null);
  assert.deepEqual(cards.widgetList(), []);
  assert.equal(lists(sent).length, 2);
});

test("a card with neither a title nor a subtitle is no card", () => {
  boot();
  cards.setWidget("a", {});
  cards.setWidget("b", { title: "", subtitle: "" });
  cards.setWidget("c", "not an object");
  assert.deepEqual(cards.widgetList(), []);
});

test("the title and subtitle are bounded", () => {
  boot();
  cards.setWidget("a", { title: "t".repeat(500), subtitle: "s".repeat(500) });
  const w = cards.widgetList()[0];
  assert.equal(w.title.length, 120);
  assert.equal(w.subtitle.length, 160);
  cards.setWidget("a", null);
});

test("an unchanged card is not re-sent", () => {
  // The card is decided on every player event, i.e. once a second while anything
  // plays; pushing an unchanged list rebuilds HOME behind a 4K film for nothing.
  const { sent } = boot();
  cards.setWidget("a", { title: "same" });
  cards.setWidget("a", { title: "same" });
  cards.setWidget("a", { title: "same" });
  assert.equal(lists(sent).length, 1);
  cards.setWidget("a", { title: "different" });
  assert.equal(lists(sent).length, 2);
  cards.setWidget("a", null);
});

test("clearing a card that is not up sends nothing", () => {
  const { sent } = boot();
  cards.setWidget("never", null);
  assert.equal(lists(sent).length, 0);
});

test("a running-apps change is its own message", () => {
  const { sent } = boot();
  cards.appsChanged();
  assert.deepEqual(sent[sent.length - 1], ["apps-changed", undefined]);
});

// ---- the derived sound card ----

test("sound playing raises a card for the app the PLAYER says owns it", () => {
  const { state } = boot({ running: true, audioOnly: true, owner: "media" });
  // The payload's own `app` field is a claim any local app can make about another.
  cards.soundWidget({ app: "someone-else", state: "playing", title: "Track", artist: "Band" });
  assert.deepEqual(cards.widgetList(), [{ id: "media", title: "Track", subtitle: "Band" }]);
  state.running = false;
  cards.soundWidget({ state: "idle" });
  assert.deepEqual(cards.widgetList(), []);
});

test("a paused track keeps its card", () => {
  boot({ running: true, audioOnly: true, owner: "media" });
  cards.soundWidget({ state: "paused", title: "Track" });
  assert.equal(cards.widgetList().length, 1);
  cards.clearSoundWidget("media");
});

test("a FILM gets no card - it owns the screen already", () => {
  boot({ running: true, audioOnly: false, owner: "plex" });
  cards.soundWidget({ state: "playing", title: "A film" });
  assert.deepEqual(cards.widgetList(), []);
});

test("the card is taken down after mpv has gone, because who it was about is remembered", () => {
  // Stopping is what makes an app report itself idle, so the report that clears
  // the card arrives when the player can no longer name an owner.
  const { state } = boot({ running: true, audioOnly: true, owner: "media" });
  cards.soundWidget({ state: "playing", title: "Track" });
  assert.equal(cards.widgetList().length, 1);
  state.running = false;
  state.owner = null;
  cards.soundWidget({ state: "idle" });
  assert.deepEqual(cards.widgetList(), [], "asking the player at that moment answers nobody");
});

test("with nothing playing and nothing remembered, a report raises nothing", () => {
  boot({ running: false, owner: null });
  cards.soundWidget({ state: "playing", title: "Claimed" });
  assert.deepEqual(cards.widgetList(), []);
});

test("the launcher is excluded - HOME is already where its card would point", () => {
  boot({ running: true, audioOnly: true, owner: null });
  cards.soundWidget({ state: "playing", title: "Live TV" });
  assert.deepEqual(cards.widgetList(), []);
});

test("clearSoundWidget takes a card down wherever the app went, and forgets it", () => {
  const { state } = boot({ running: true, audioOnly: true, owner: "media" });
  cards.soundWidget({ state: "playing", title: "Track" });
  cards.clearSoundWidget("media");
  assert.deepEqual(cards.widgetList(), []);
  // Forgotten: a later report with no live player must not resurrect it.
  state.running = false;
  state.owner = null;
  cards.soundWidget({ state: "playing", title: "Ghost" });
  assert.deepEqual(cards.widgetList(), []);
});

test("clearSoundWidget for nobody is a no-op", () => {
  const { sent } = boot();
  cards.clearSoundWidget(null);
  cards.clearSoundWidget(undefined);
  assert.equal(lists(sent).length, 0);
});
