// ir.js unit tests - the pure parts (step clamping, the HA URL trust gate,
// unconfigured behavior). Backend I/O (ESPHome native API, HA REST) is
// exercised on a real box; nothing here touches the network: the URL-guard
// rejections fire before any socket opens.
const test = require("node:test");
const assert = require("node:assert");
const ir = require("./ir");

test("clampSteps: defaults, junk and bounds", () => {
  const c = ir._test.clampSteps;
  assert.equal(c(undefined), 1);
  assert.equal(c("junk"), 1);
  assert.equal(c(0), 1);
  assert.equal(c(-3), 1);
  assert.equal(c(3.7), 3);
  assert.equal(c("2"), 2);
  assert.equal(c(99), 10);
});

test("send rejects while no backend is configured", async () => {
  // module state starts unconfigured (applyConfig was never called here)
  await assert.rejects(() => ir.send("volume_up"), /no IR blaster configured/);
  const s = ir.status();
  assert.equal(s.configured, false);
  assert.deepEqual(s.actions, []);
});

test("send whitelist ignores inherited object properties", async () => {
  // a fake backend so the action lookup (not the configured check) decides
  ir._test.setBackendForTest({ name: "fake", connected: () => true, send: async () => {}, close() {} }, { mute: "S" });
  try {
    for (const a of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      await assert.rejects(() => ir.send(a), /unknown IR action/, a);
    }
    await ir.send("mute"); // sanity: a real mapping still goes through
  } finally {
    ir._test.setBackendForTest(null, {});
  }
});

test("haScriptCall refuses plain http off the LAN (token must not leak)", async () => {
  await assert.rejects(() => ir._test.haScriptCall("http://example.com", "tok", "script.x"), /LAN/);
});

test("haScriptCall refuses junk URLs", async () => {
  await assert.rejects(() => ir._test.haScriptCall("not a url", "tok", "script.x"), /invalid Home Assistant URL/);
});
