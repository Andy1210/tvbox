const { test } = require("node:test");
const assert = require("node:assert");
const identity = require("./identity");

// The rules that keep two boxes from being one box. rebrand() is pure, so these
// run without a second Raspberry Pi, a broker or a config file.
//
// It is only ever reached for a CLONE restore - a same-box restore (a re-flash
// recovering its own backup) must keep every value verbatim, and does so by not
// calling this at all (backup.js gates on payload.clone).

// Re-derived means UNSET, not re-written: the target's own default already answers,
// and storing it would make the field explicit again.
test("a clone onto a differently named box re-derives the inherited identity", () => {
  const cfg = { mqtt: { host: "h", username: "u", deviceId: "nappali" }, spotify: { deviceName: "nappali" } };
  const r = identity.rebrand(cfg, "nappali", "haloszoba", "abcd");
  assert.equal("deviceId" in r.config.mqtt, false, "left to the live derivation");
  assert.equal("deviceName" in r.config.spotify, false);
  assert.deepEqual(
    r.changed.map((c) => [c.path, c.from, c.to]),
    [
      ["mqtt.deviceId", "nappali", "haloszoba"],
      ["spotify.deviceName", "nappali", "haloszoba"],
    ],
  );
});

// The bug this guards: if a clone STORED the derived value, the next generation
// would compare that value against its own hostname, read the difference as a
// deliberate name, and inherit it verbatim - two boxes on one topic tree, one clone
// later. Nothing is stored, so every box keeps deriving from its own name.
test("a clone of a clone does not inherit the first clone's identity", () => {
  const a = { mqtt: { host: "h", username: "u" } }; // box A ("nappali"), unset
  const b = identity.rebrand(a, "nappali", "haloszoba", "abcd").config; // -> box B
  assert.equal("deviceId" in b.mqtt, false);
  // B's owner renames it to `halo`; a clone of B lands on a box called `dolgozo`.
  const c = identity.rebrand(JSON.parse(JSON.stringify(b)), "halo", "dolgozo", "9f3c");
  assert.equal("deviceId" in c.config.mqtt, false, "still nothing stored");
  // Which means B publishes as `halo` and C as `dolgozo` - each from its own name.
  assert.notEqual(identity.safeId("halo"), identity.safeId("dolgozo"));
});

// The value the user typed is a choice, not an inherited collision - two boxes
// where one is deliberately called "living room" is the owner's business.
test("a deliberately chosen name survives a clone", () => {
  const cfg = { mqtt: { host: "h", username: "u", deviceId: "living_room_tv" }, spotify: { deviceName: "Big TV" } };
  const r = identity.rebrand(cfg, "pi5-a", "pi5-b", "abcd");
  assert.deepEqual(r.changed, []);
  assert.equal(r.config.mqtt.deviceId, "living_room_tv");
});

// The field being empty means the source box ran on ITS derived default, which is
// inherited just as much as a stored value - the effective id changes even though
// nothing is written, so the change is still REPORTED (the owner's HA entities move).
test("an unset field is reported as re-derived, and stays unset", () => {
  const cfg = { mqtt: { host: "h", username: "u" }, spotify: { enabled: true } };
  const r = identity.rebrand(cfg, "pi5-a", "pi5-b", "abcd");
  assert.equal("deviceId" in r.config.mqtt, false);
  assert.equal("deviceName" in r.config.spotify, false);
  assert.deepEqual(
    r.changed.map((c) => [c.path, c.from, c.to]),
    [
      ["mqtt.deviceId", "pi5-a", "pi5-b"],
      ["spotify.deviceName", "pi5-a", "pi5-b"],
    ],
  );
});

// The case that actually breaks: two freshly flashed boxes both answer to
// `raspberrypi`, so deriving from the name alone would hand them one identity.
test("two boxes with the same hostname are separated by the unique suffix", () => {
  const cfg = { mqtt: { host: "h", username: "u", deviceId: "raspberrypi" }, spotify: { deviceName: "raspberrypi" } };
  const r = identity.rebrand(cfg, "raspberrypi", "raspberrypi", "9f3c");
  assert.equal(r.config.mqtt.deviceId, "raspberrypi-9f3c");
  assert.equal(r.config.spotify.deviceName, "raspberrypi-9f3c");
});

test("with no suffix to fall back on, an identical hostname is left alone rather than guessed at", () => {
  const cfg = { mqtt: { host: "h", username: "u", deviceId: "raspberrypi" } };
  const r = identity.rebrand(cfg, "raspberrypi", "raspberrypi", "");
  assert.deepEqual(r.changed, []);
});

// A section that isn't configured must not be conjured into existence: writing
// spotify.deviceName onto a box with no spotify config would make publicConfig
// report a Spotify setup that does not exist.
test("an absent config section is not created", () => {
  const r = identity.rebrand({}, "pi5-a", "pi5-b", "abcd");
  assert.deepEqual(r.config, {});
  assert.deepEqual(r.changed, []);
});

test("a derived device id is topic-safe", () => {
  assert.equal(identity.safeId("nappali.tv box"), "nappali_tv_box");
  assert.equal(identity.safeId(""), "tvbox");
  // A hostname with characters no MQTT topic segment may carry: the derivation, and
  // therefore what gets reported and what the suffix path would store, is sanitized.
  const r = identity.rebrand({ mqtt: { host: "h" } }, "a", "élő szoba", "abcd");
  assert.match(r.changed[0].to, /^[a-zA-Z0-9_-]+$/);
  const s = identity.rebrand({ mqtt: { host: "h" } }, "élő szoba", "élő szoba", "abcd");
  assert.match(s.config.mqtt.deviceId, /^[a-zA-Z0-9_-]+$/);
});

test("junk config in, junk config not written", () => {
  assert.deepEqual(identity.rebrand(null, "a", "b", "c").config, {});
});
