// A box that is renamed moves its whole topic tree, and takes the old one with it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mqtt = require("./mqtt");

const { setStateForTest, forgetPreviousId, retainedTopicsOf } = mqtt._test;

function recorder() {
  const sent = [];
  return { sent, publish: (topic, payload, opts) => sent.push({ topic, payload, opts }) };
}

test("the previous id's retained topics are cleared once, and the new id is recorded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-mqtt-"));
  const file = path.join(dir, "last-id");
  fs.writeFileSync(file, "old-box\n");
  const rec = recorder();
  setStateForTest({ client: rec, base: "tvbox/new-box", deviceId: "new-box" });
  forgetPreviousId(file);
  const cleared = rec.sent.filter((m) => m.payload === "" && m.opts.retain).map((m) => m.topic);
  assert.deepStrictEqual(cleared.sort(), retainedTopicsOf("old-box").sort());
  assert.ok(cleared.includes("tvbox/old-box/announce"));
  assert.ok(cleared.includes("homeassistant/sensor/tvbox_old-box/nowplaying/config"));
  assert.ok(!cleared.some((t) => t.includes("new-box")), "nothing of the current id");
  assert.strictEqual(fs.readFileSync(file, "utf8").trim(), "new-box");
  rec.sent.length = 0;
  forgetPreviousId(file);
  assert.strictEqual(rec.sent.length, 0, "the next connect has nothing to clear");
});

test("a first start has nothing to clear, and a mangled record clears nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-mqtt-"));
  const file = path.join(dir, "last-id");
  const rec = recorder();
  setStateForTest({ client: rec, base: "tvbox/b", deviceId: "b" });
  forgetPreviousId(file);
  assert.strictEqual(rec.sent.length, 0);
  fs.writeFileSync(file, "a/#\n");
  forgetPreviousId(file);
  assert.strictEqual(rec.sent.length, 0, "an id that is not a topic segment is not a topic tree to clear");
});

test("the retained set includes the canary topic and every diag sensor", () => {
  const t = retainedTopicsOf("b");
  assert.ok(t.includes("tvbox/b/canary"));
  for (const d of mqtt._test.DIAG_SENSORS) assert.ok(t.includes("homeassistant/sensor/tvbox_b/" + d.key + "/config"));
});

test("discovery publishes the diag sensors on the device's diag topic", () => {
  const rec = recorder();
  setStateForTest({ client: rec, base: "tvbox/b", deviceId: "b" });
  mqtt._test.publishDiscovery([]);
  const health = rec.sent.find((m) => m.topic === "homeassistant/sensor/tvbox_b/health/config");
  assert.ok(health, "health sensor published");
  const cfg = JSON.parse(health.payload);
  assert.strictEqual(cfg.state_topic, "tvbox/b/diag");
  assert.strictEqual(cfg.json_attributes_topic, "tvbox/b/diag");
  assert.strictEqual(cfg.entity_category, "diagnostic");
  assert.strictEqual(health.opts.retain, true);
  for (const key of ["version", "cpu_temp"]) {
    const gone = rec.sent.find((m) => m.topic === "homeassistant/sensor/tvbox_b/" + key + "/config");
    assert.ok(gone && gone.payload === "", key + " is cleared, since the integration already has it");
  }
});

test("canary vouches: other boxes only, cleared topics forget, and the map is bounded", () => {
  setStateForTest({ client: recorder(), base: "tvbox/me", deviceId: "me", clearVouches: true });
  const v = mqtt._test.vouches();
  mqtt._test.noteVouch("me", Buffer.from(JSON.stringify({ version: "2.0.0", healthy: true })));
  assert.strictEqual(v.size, 0, "a box never vouches for itself");
  mqtt._test.noteVouch("a", Buffer.from(JSON.stringify({ version: "2.0.0", healthy: true })));
  assert.deepStrictEqual(v.get("a"), { version: "2.0.0", healthy: true, failed: null });
  mqtt._test.noteVouch("a", Buffer.from(""));
  assert.strictEqual(v.has("a"), false);
  mqtt._test.noteVouch("x", Buffer.from("{not json"));
  assert.strictEqual(v.has("x"), false);
  for (let i = 0; i < 100; i++) mqtt._test.noteVouch("b" + i, Buffer.from(JSON.stringify({ version: "1" })));
  assert.ok(v.size <= 64);
});

test("forget clears every retained topic with QoS 1 and disconnects cleanly", async () => {
  const sent = [];
  let ended = null;
  const client = {
    connected: true,
    publish: (topic, payload, opts) => sent.push({ topic, payload, opts }),
    end: (force, opts, cb) => {
      ended = force;
      cb();
    },
  };
  setStateForTest({ client, base: "tvbox/b", deviceId: "b" });
  const err = await new Promise((r) => mqtt._test.forget(r));
  assert.strictEqual(err, null);
  assert.strictEqual(ended, false, "a clean disconnect, so the will does not fire");
  assert.deepStrictEqual(sent.map((m) => m.topic).sort(), retainedTopicsOf("b").sort());
  assert.ok(sent.every((m) => m.payload === "" && m.opts.retain && m.opts.qos === 1));
  assert.ok(!sent.some((m) => m.payload === "offline"));
});

test("forget refuses when not connected", async () => {
  setStateForTest({ client: { connected: false, publish: () => assert.fail() }, base: "tvbox/b", deviceId: "b" });
  const err = await new Promise((r) => mqtt._test.forget(r));
  assert.ok(err);
});

test("a non-canary clears its canary topic", () => {
  const rec = recorder();
  setStateForTest({ client: rec, base: "tvbox/b", deviceId: "b" });
  mqtt._test.publishCanary(null);
  assert.deepStrictEqual(rec.sent, [{ topic: "tvbox/b/canary", payload: "", opts: { retain: true } }]);
});

test("forget gives up on a broker that never confirms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let forced = false;
  const client = {
    connected: true,
    publish: () => {},
    end: (force) => {
      if (force) forced = true;
    },
  };
  setStateForTest({ client, base: "tvbox/b", deviceId: "b" });
  const p = new Promise((r) => mqtt._test.forget(r));
  t.mock.timers.tick(8000);
  const err = await p;
  assert.ok(err);
  assert.strictEqual(forced, true);
});
