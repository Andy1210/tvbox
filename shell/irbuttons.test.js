// The HA button entity per IR action: how a dashboard, an automation or a voice
// assistant reaches the blaster without knowing this box's topic layout. No broker - the
// client is a recorder.
//
// The interesting half is DELETION. A discovery config topic is retained, so a button
// whose action is removed from the config would stay in Home Assistant forever, pressing
// into a box that no longer maps it - and a press that silently does nothing is the
// exact failure this whole area keeps producing.
const test = require("node:test");
const assert = require("node:assert");
const mqtt = require("./mqtt");

const { publishDiscovery, setStateForTest, irButtonTopic, IR_BUTTON_NAMES, published } = mqtt._test;

function recorder() {
  const sent = [];
  return { sent, publish: (topic, payload, opts) => sent.push({ topic, payload, opts }) };
}
const arm = (irPublished = []) => {
  const rec = recorder();
  setStateForTest({ client: rec, base: "tvbox/livingroom", deviceId: "livingroom", irPublished });
  return rec;
};
const button = (rec, action) => rec.sent.find((m) => m.topic === irButtonTopic("livingroom", action));

test("a button is published per mapped action, and it presses the command topic", () => {
  const rec = arm();
  publishDiscovery(["input_hdmi2", "soundbar_power"]);
  const b = button(rec, "input_hdmi2");
  assert.ok(b, "the HDMI 2 button exists");
  const payload = JSON.parse(b.payload);
  assert.equal(payload.name, IR_BUTTON_NAMES.input_hdmi2);
  assert.equal(payload.unique_id, "tvbox_livingroom_ir_input_hdmi2");
  assert.equal(payload.command_topic, "tvbox/livingroom/cmd");
  assert.equal(payload.availability_topic, "tvbox/livingroom/status");
  // The press is the SAME object an external caller would publish, so there is one path
  // into the box rather than a second private one.
  assert.deepEqual(JSON.parse(payload.payload_press), { action: "input_hdmi2" });
  assert.ok(b.opts.retain, "retained, or the buttons vanish until the box reboots");
  assert.ok(button(rec, "soundbar_power"));
});

test("a press cannot be swept up with every other button in the room", () => {
  // `entity_category: config` is what an area sweep filters on. Without it a caller
  // acting on every `button` in a room presses all four inputs and both power keys in
  // one go, and an input press is the one thing here the box cannot undo.
  const rec = arm();
  publishDiscovery(["input_hdmi2", "soundbar_power"]);
  for (const a of ["input_hdmi2", "soundbar_power"]) {
    assert.equal(JSON.parse(button(rec, a).payload).entity_category, "config", a);
  }
});

test("a power button does not look like a volume button", () => {
  const rec = arm();
  publishDiscovery(["soundbar_power", "mute", "input_hdmi2", "volume_up"]);
  const icon = (a) => JSON.parse(button(rec, a).payload).icon;
  assert.equal(icon("soundbar_power"), "mdi:power");
  assert.equal(icon("mute"), "mdi:volume-off");
  assert.equal(icon("input_hdmi2"), "mdi:video-input-hdmi");
  assert.equal(icon("volume_up"), "mdi:volume-high");
});

test("the buttons land on the box's own HA device", () => {
  const rec = arm();
  publishDiscovery(["mute"]);
  const sensor = rec.sent.find((m) => m.topic.startsWith("homeassistant/sensor/"));
  const b = button(rec, "mute");
  assert.deepEqual(JSON.parse(b.payload).device, JSON.parse(sensor.payload).device);
});

test("an action removed from the config takes its button with it", () => {
  const rec = arm(["input_hdmi2", "soundbar_power"]);
  publishDiscovery(["input_hdmi2"]);
  const gone = button(rec, "soundbar_power");
  assert.ok(gone, "the removed one is addressed");
  assert.equal(gone.payload, "", "an empty retained payload is how HA deletes an entity");
  assert.ok(gone.opts.retain);
  assert.ok(JSON.parse(button(rec, "input_hdmi2").payload).name, "the kept one is republished");
  assert.deepEqual(published(), ["input_hdmi2"]);
});

test("a button left behind by an EARLIER run is deleted too", () => {
  // The config topics are retained and `irPublished` starts empty, so diffing against
  // it alone only ever tidied up within one process. A button whose action was removed
  // while the box was off - or one left by an OTA rollback to a shell that never heard
  // of the action - stayed in Home Assistant, available, pressing into "unknown
  // command". This is that case: nothing published in THIS run, one action wanted.
  const rec = arm([]);
  publishDiscovery(["input_hdmi2"]);
  const deleted = rec.sent
    .filter((m) => m.topic.startsWith("homeassistant/button/") && m.payload === "")
    .map((m) => m.topic);
  assert.ok(
    deleted.includes(irButtonTopic("livingroom", "soundbar_power")),
    "an action this run never published is still cleared",
  );
  assert.ok(!deleted.includes(irButtonTopic("livingroom", "input_hdmi2")), "the wanted one is not");
  // Every name is accounted for: kept or cleared, none forgotten - the live vocabulary
  // plus whatever earlier releases published and no longer have.
  assert.equal(deleted.length, Object.keys(IR_BUTTON_NAMES).length - 1 + mqtt._test.IR_RETIRED_ACTIONS.length);
});

test("no IR configured deletes every button it had published", () => {
  const rec = arm(["mute"]);
  publishDiscovery([]);
  assert.equal(button(rec, "mute").payload, "");
  assert.deepEqual(published(), []);
});

test("a reconnect restates the same set without being told it", () => {
  // `publishDiscovery()` is what the connect handler calls, and it has no idea what the
  // blaster is mapped to.
  const rec = arm(["input_hdmi2"]);
  publishDiscovery();
  const b = button(rec, "input_hdmi2");
  assert.ok(JSON.parse(b.payload).name, "republished, not deleted");
  assert.deepEqual(published(), ["input_hdmi2"]);
});

test("an action with no name is neither published nor deleted", () => {
  // `actions` comes off a config file. An unknown one has no label to show, and deleting
  // a topic this module never wrote is not its business either.
  const rec = arm();
  publishDiscovery(["input_hdmi2", "wat", "__proto__"]);
  const touched = rec.sent.filter((m) => m.topic.startsWith("homeassistant/button/")).map((m) => m.topic);
  assert.ok(!touched.some((t) => t.includes("ir_wat") || t.includes("ir___proto__")));
  // Only the known one is PUBLISHED; the rest of the vocabulary is cleared, which is a
  // different thing from inventing a topic for a name nobody defined.
  assert.deepEqual(
    rec.sent.filter((m) => m.topic.startsWith("homeassistant/button/") && m.payload !== "").map((m) => m.topic),
    [irButtonTopic("livingroom", "input_hdmi2")],
  );
  assert.deepEqual(published(), ["input_hdmi2"]);
});

test("nothing is published, and nothing throws, with no broker", () => {
  setStateForTest({ client: null, irPublished: ["mute"] });
  assert.doesNotThrow(() => publishDiscovery(["input_hdmi2"]));
});

test("a publish that throws does not take the rest of discovery down", () => {
  // One bad topic must not cost the other buttons, and mqtt.js absorbs client errors
  // everywhere else for the same reason.
  const rec = recorder();
  let first = true;
  const client = {
    publish: (t, p, o) => {
      if (first && t.startsWith("homeassistant/button/")) {
        first = false;
        throw new Error("broker went away");
      }
      rec.publish(t, p, o);
    },
  };
  setStateForTest({ client, base: "tvbox/livingroom", deviceId: "livingroom", irPublished: [] });
  assert.doesNotThrow(() => publishDiscovery(["input_hdmi2", "soundbar_power"]));
  assert.ok(rec.sent.some((m) => m.topic === irButtonTopic("livingroom", "soundbar_power")));
});

test("every action the blaster knows has a button name", () => {
  // Four copies of this vocabulary exist - shell/config.js IR_ACTIONS, the names here,
  // the launcher's IrAction union and its locale strings - and only this pair can be
  // compared without a bundler. It is the pair that matters most: an action config
  // accepts but this table lacks gets no button AND cannot be deleted, because the
  // sweep that clears stale buttons iterates these names.
  const config = require("./config");
  const known = Object.keys(IR_BUTTON_NAMES);
  for (const a of config._test.IR_ACTIONS) assert.ok(known.includes(a), a + " has no button name");
  for (const a of known) assert.ok(config._test.IR_ACTIONS.includes(a), a + " is not an action");
});

test("an action the release RETIRED loses its button too", () => {
  // The sweep iterates the CURRENT vocabulary, so an action removed in a release would
  // otherwise keep its retained config topic forever - available in Home Assistant,
  // pressing into "unknown command" on a box that has never heard of it. Removing an
  // action means adding it to IR_RETIRED_ACTIONS.
  const rec = arm([]);
  publishDiscovery(["soundbar_power"]);
  const { IR_RETIRED_ACTIONS } = mqtt._test;
  assert.ok(IR_RETIRED_ACTIONS.length, "something has been retired, or this test proves nothing");
  for (const gone of IR_RETIRED_ACTIONS) {
    const msg = rec.sent.find((m) => m.topic === irButtonTopic("livingroom", gone));
    assert.ok(msg, gone + " was never addressed");
    assert.equal(msg.payload, "", gone + " was not cleared");
  }
  // ...and a retired name is never PUBLISHED, whatever a config asks for.
  const rec2 = arm([]);
  publishDiscovery([...IR_RETIRED_ACTIONS]);
  assert.deepEqual(
    rec2.sent.filter((m) => m.topic.startsWith("homeassistant/button/") && m.payload !== ""),
    [],
  );
});
