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
