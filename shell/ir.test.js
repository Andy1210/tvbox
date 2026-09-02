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

// ---- the firetv backend: what a failed blast is allowed to say ----------------------
// The failures are told apart because only one of them is something a person can fix,
// and the message reaches a voice assistant's answer. The blaster is the remote itself,
// so "asleep" is the normal state between presses, not an error condition.
//
// Two paths reach the remote and both are exercised below: the resident link service
// (which holds the BLE connection - a blast over it costs ~0.9 s) and, when no service
// is running, one process per blast. `firetvStub` builds a module stand-in; pass
// `viaService` to answer on the service path, `blastAction` for the one-shot.
function firetvStub({ blastAction, viaService, linkUp = null, calls = [] } = {}) {
  return {
    calls,
    startService: (mac) => calls.push(["startService", mac]),
    stopService: () => calls.push(["stopService"]),
    serviceLinkState: () => linkUp,
    blastViaService:
      viaService ||
      ((mac, target, cb) => {
        // No service: the error the real one gives, which is what makes the backend
        // fall back instead of reporting a failed blast.
        const e = new Error("no IR link service");
        e.absent = true;
        cb(e);
      }),
    blastAction: blastAction || ((m, t, cb) => cb(new Error("no blastAction in this stub"))),
  };
}

test("firetv: a blast over the resident link resolves, and no process is spawned", async () => {
  const seen = [];
  const b = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({
      linkUp: true,
      viaService: (mac, target, cb) => {
        seen.push([mac, target]);
        cb(null, { ok: true, ms: 912 });
      },
      blastAction: () => assert.fail("the one-shot must not run while a service answers"),
    }),
  );
  await b.send("tv:HDMI2");
  assert.deepEqual(seen, [["7C:ED:C6:12:E6:3C", "tv:HDMI2"]]);
  assert.equal(b.name, "firetv");
  assert.equal(b.connected(), true, "the service's own view of the link");
});

test("firetv: the link service is started for the configured remote, and stopped on close", () => {
  const calls = [];
  const b = ir._test.makeFiretvBackend({ mac: "7C:ED:C6:12:E6:3C" }, firetvStub({ calls }));
  assert.deepEqual(calls, [["startService", "7C:ED:C6:12:E6:3C"]]);
  b.close();
  assert.deepEqual(calls, [["startService", "7C:ED:C6:12:E6:3C"], ["stopService"]]);
});

test("firetv: an unknown link state is not reported as a down remote", () => {
  const b = ir._test.makeFiretvBackend({ mac: "7C:ED:C6:12:E6:3C" }, firetvStub({ linkUp: null }));
  assert.equal(b.connected(), null);
});

test("firetv: with no service running, a blast falls back to one process per blast", async () => {
  const seen = [];
  const b = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({
      blastAction: (mac, target, cb) => {
        seen.push([mac, target]);
        cb(null, { ok: true, code: 0 });
      },
    }),
  );
  await b.send("tv:HDMI2");
  assert.deepEqual(seen, [["7C:ED:C6:12:E6:3C", "tv:HDMI2"]]);
});

test("firetv: a service that ran and did not answer is NOT retried in a second process", async () => {
  // Both paths cost a budget the IR queue waits behind, and the remote has already had
  // one. Only an ABSENT service is worth another process.
  const b = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({
      viaService: (m, t, cb) => cb(new Error("the IR link service did not answer in time")),
      blastAction: () => assert.fail("must not fall back on a timeout"),
    }),
  );
  await assert.rejects(() => b.send("tv:HDMI2"), /did not answer in time/);
});

test("firetv: a sleeping remote says what to do about it, either way it was reached", async () => {
  const viaSvc = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({ viaService: (m, t, cb) => cb(null, { ok: false, code: "asleep", error: "..." }) }),
  );
  await assert.rejects(() => viaSvc.send("tv:HDMI2"), /press a button on it/);
  const oneShot = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({ blastAction: (m, t, cb) => cb(null, { ok: false, code: 1 }) }),
  );
  await assert.rejects(() => oneShot.send("tv:HDMI2"), /press a button on it/);
});

test("firetv: a remote that cannot blast at all says THAT instead", async () => {
  // Exit 3 / "nokeymap" is no keymap service - an older or different remote. Telling
  // someone to wake it would send them to press buttons forever.
  const viaSvc = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({ viaService: (m, t, cb) => cb(null, { ok: false, code: "nokeymap" }) }),
  );
  await assert.rejects(() => viaSvc.send("tv:HDMI2"), /no IR keymap service/);
  const oneShot = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({ blastAction: (m, t, cb) => cb(null, { ok: false, code: 3 }) }),
  );
  await assert.rejects(() => oneShot.send("tv:HDMI2"), /no IR keymap service/);
});

test("firetv: a code the remote cannot encode is not a wake problem", async () => {
  const viaSvc = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({ viaService: (m, t, cb) => cb(null, { ok: false, code: "badcode" }) }),
  );
  await assert.rejects(() => viaSvc.send("tv:HDMI2"), /pick another codeset/);
});

test("firetv: anything else speaks for itself", async () => {
  const b = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({ blastAction: (m, t, cb) => cb(null, { ok: false, code: 2, output: "config not found" }) }),
  );
  await assert.rejects(() => b.send("tv:HDMI2"), /config not found/);
  const err = ir._test.makeFiretvBackend(
    { mac: "x" },
    firetvStub({ blastAction: (m, t, cb) => cb(new Error("invalid MAC")) }),
  );
  await assert.rejects(() => err.send("tv:HDMI2"), /invalid MAC/);
  // A service failure with no code of its own must not be swallowed into a generic
  // sentence: it is the only thing that says what went wrong.
  const svc = ir._test.makeFiretvBackend(
    { mac: "7C:ED:C6:12:E6:3C" },
    firetvStub({ viaService: (m, t, cb) => cb(null, { ok: false, error: "bad request: nope", code: "protocol" }) }),
  );
  await assert.rejects(() => svc.send("tv:HDMI2"), /bad request: nope/);
});

test("an action nothing is mapped to is refused, not guessed", async () => {
  // The vocabulary is closed and the mapping is per-box: a box that never mapped an
  // input must not send some other code instead.
  ir._test.setBackendForTest(
    { name: "firetv", send: async () => {}, connected: () => null, close() {} },
    {
      input_hdmi2: "tv:HDMI2",
    },
  );
  await ir.send("input_hdmi2");
  await assert.rejects(() => ir.send("soundbar_power"), /unknown IR action/);
  assert.deepEqual(ir.status().actions, ["input_hdmi2"]);
});
