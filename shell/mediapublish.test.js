// The box as one media_player, on the wire.
//
// Two things here are easy to get subtly wrong and impossible to see from the
// sofa: a publish is COALESCED, so a force that lands inside an already-queued
// window must not lose its force; and everything is gated on the bridge being
// configured, because a box nobody watches must not pay three process spawns a
// minute for ever.
const test = require("node:test");
const assert = require("node:assert");

const mediastate = require("./mediastate");
const mediapublish = require("./mediapublish");

function boot(opts) {
  const o = opts || {};
  const log = { published: [], announced: [], stops: 0, cards: [], sinks: 0, diag: 0 };
  const ctl = {
    publish: (topic, payload, opt) => log.published.push([topic, payload, opt]),
    announce: (a) => log.announced.push(a),
  };
  mediapublish.init({
    mqtt: {
      stop: () => log.stops++,
      init: (cfg, handlers) => {
        log.handlers = handlers;
        return cfg ? ctl : null;
      },
    },
    mediastate,
    audio: {
      defaultSink: (env, cb) => {
        log.sinks++;
        cb(o.sink === undefined ? { id: 1, volume: 0.5, muted: false } : o.sink);
      },
      setVolume: (env, id, v, cb) => (log.published.push(["setVolume", v]), cb(true)),
      setMuted: (env, id, m, cb) => (log.published.push(["setMuted", m]), cb(true)),
    },
    diag: { collect: (mods, cb) => (log.diag++, cb({ version: "1" })) },
    identity: { hostname: () => "tvbox-here" },
    config: { rawMqtt: () => (o.mqtt === undefined ? { host: "h" } : o.mqtt) },
    system: {},
    updater: {},
    player: { media: o.mpv || { active: false } },
    version: "9.9.9",
    childEnv: () => ({}),
    nowPlaying: () => o.nowPlaying || null,
    currentApp: () => o.currentApp || null,
    sources: () => o.sources || [],
    soundWidget: (d) => log.cards.push(d),
    onNotify: () => {},
    onCommand: () => {},
  });
  return log;
}

const settle = () => new Promise((r) => setTimeout(r, mediapublish.COALESCE_MS + 60));
const states = (log) => log.published.filter((p) => p[0] === "state");

test("nothing is published while the bridge is not configured", async () => {
  const log = boot({ mqtt: null });
  mediapublish.applyConfig();
  mediapublish.publish({ force: true });
  await settle();
  assert.deepEqual(log.published, []);
  assert.equal(mediapublish.control(), null);
});

test("the HOME card is re-decided even with no broker - it is not an MQTT feature", () => {
  const log = boot({ mqtt: null, nowPlaying: { state: "playing", title: "x" } });
  mediapublish.applyConfig();
  mediapublish.publish();
  assert.deepEqual(log.cards, [{ state: "playing", title: "x" }]);
});

test("connecting announces the box and the command vocabulary it answers", async () => {
  const log = boot();
  mediapublish.applyConfig();
  await settle();
  assert.equal(log.announced.length, 1);
  assert.equal(log.announced[0].name, "tvbox-here");
  assert.equal(log.announced[0].version, "9.9.9");
  assert.deepEqual(log.announced[0].commands, mediapublish.TV_COMMANDS);
});

test("the vocabulary carries what an older box must not advertise", () => {
  // Home Assistant turns this into supported_features.
  for (const c of ["play", "pause", "stop", "next", "previous", "shuffle", "repeat", "lyrics", "seek", "volume_set"]) {
    assert.ok(mediapublish.TV_COMMANDS.includes(c), c);
  }
});

test("a burst of publishes is coalesced into one", async () => {
  const log = boot();
  mediapublish.applyConfig();
  await settle();
  const before = states(log).length;
  for (let i = 0; i < 20; i++) mediapublish.publish();
  await settle();
  assert.ok(states(log).length - before <= 1, "mpv reports a position every second");
});

test("a force landing inside an already-queued window keeps its force", async () => {
  // Re-seeding a fresh broker IS a forced publish, and the remembered state still
  // holds the previous broker's value - folded into a filtered publish, the new
  // broker would be left with no retained state at all.
  const log = boot();
  mediapublish.applyConfig();
  await settle();
  const before = states(log).length;
  mediapublish.publish(); // opens the window
  mediapublish.publish({ force: true }); // lands inside it
  await settle();
  assert.equal(states(log).length, before + 1);
  // Nothing moved between the two, so an unforced pair would have published nothing.
  mediapublish.publish();
  mediapublish.publish();
  await settle();
  assert.equal(states(log).length, before + 1, "a publish that is not news is dropped");
});

test("the state is retained, because a subscriber that arrives tomorrow still needs one", async () => {
  const log = boot();
  mediapublish.applyConfig();
  await settle();
  assert.deepEqual(states(log)[0][2], { retain: true });
});

test("re-applying the config stops the old bridge first", async () => {
  const log = boot();
  mediapublish.applyConfig();
  mediapublish.applyConfig();
  await settle();
  assert.equal(log.stops, 2, "a cleared config has to turn the bridge off, so stop always runs");
});

test("the retained now-playing is re-seeded onto a new broker", async () => {
  const log = boot({ nowPlaying: { app: "media", state: "playing" } });
  mediapublish.applyConfig();
  await settle();
  const np = log.published.filter((p) => p[0] === "nowplaying");
  assert.equal(np.length, 1);
  assert.deepEqual(np[0][2], { retain: true });
});

test("publishNowPlaying is a no-op with no broker, rather than a throw", () => {
  const log = boot({ mqtt: null });
  mediapublish.applyConfig();
  mediapublish.publishNowPlaying({ app: "x", state: "idle" });
  assert.deepEqual(log.published, []);
});

test("the volume is read once at connect rather than waiting out the tick", async () => {
  const log = boot();
  mediapublish.applyConfig();
  await settle();
  assert.ok(log.sinks >= 1, "a media_player whose slider starts blank reads as broken");
});

test("the sink is not read at all while nothing is listening", () => {
  const log = boot({ mqtt: null });
  mediapublish.applyConfig();
  log.sinks = 0;
  mediapublish.refreshSinkState();
  assert.equal(log.sinks, 0, "wpctl is a process spawn, and a film is not the time for three a minute");
});

test("the fleet payload is published at connect, retained", async () => {
  const log = boot();
  mediapublish.applyConfig();
  await settle();
  const d = log.published.filter((p) => p[0] === "diag");
  assert.equal(d.length, 1);
  assert.deepEqual(d[0][2], { retain: true });
});

test("a diag collect that throws is caught here, not in the main process", async () => {
  boot();
  mediapublish.init({
    diag: {
      collect: () => {
        throw new Error("nmcli is not installed");
      },
    },
  });
  mediapublish.applyConfig(); // publishes diag at connect
  await settle();
  mediapublish.publishDiag(); // and again, explicitly
});

test("the box's own volume targets the default sink and re-reads what it became", async () => {
  const log = boot();
  mediapublish.applyConfig();
  await settle();
  mediapublish.setBoxVolume("volume_set", { volume: 0.3 });
  assert.ok(log.published.find((p) => p[0] === "setVolume" && p[1] === 0.3));
});

test("a mute with no value asked for is a toggle", async () => {
  const log = boot();
  mediapublish.applyConfig();
  await settle();
  mediapublish.setBoxVolume("volume_mute", {});
  assert.ok(log.published.find((p) => p[0] === "setMuted" && p[1] === "toggle"));
  mediapublish.setBoxVolume("volume_mute", { mute: false });
  assert.ok(log.published.find((p) => p[0] === "setMuted" && p[1] === false));
});

test("with no sink at all, nothing is set and nothing throws", async () => {
  const log = boot({ sink: null });
  mediapublish.applyConfig();
  await settle();
  mediapublish.setBoxVolume("volume_set", { volume: 0.3 });
  assert.equal(log.published.filter((p) => p[0] === "setVolume").length, 0);
});
