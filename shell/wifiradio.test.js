const test = require("node:test");
const assert = require("node:assert");
const wifiradio = require("./wifiradio");

// A stand-in for execFile that records nmcli calls and answers `nmcli radio wifi`
// with whatever state the test wants.
function fakeRun(radioState, opts) {
  const calls = [];
  const run = (bin, args, _o, cb) => {
    calls.push(bin + " " + args.join(" "));
    if (args.join(" ") === "radio wifi") {
      return cb((opts && opts.err) || null, radioState === null ? "something else\n" : radioState + "\n");
    }
    cb(null, "");
  };
  return { calls, run };
}
function fakeFuse() {
  const f = { armed: 0, disarmed: 0 };
  f.fn = () => {
    f.armed++;
    return () => f.disarmed++;
  };
  return f;
}

test("radio on: goes off for the body and back on after it", () => {
  const { calls, run } = fakeRun("enabled");
  const fuse = fakeFuse();
  let sawBody = false;
  wifiradio.withRadioOff(
    {},
    90,
    (done) => {
      sawBody = true;
      assert.deepStrictEqual(calls, ["nmcli radio wifi", "nmcli radio wifi off"], "radio is down inside the body");
      done();
    },
    { run, fuse: fuse.fn },
  );
  assert.ok(sawBody);
  assert.deepStrictEqual(calls, ["nmcli radio wifi", "nmcli radio wifi off", "nmcli radio wifi on"]);
  assert.strictEqual(fuse.armed, 1);
  assert.strictEqual(fuse.disarmed, 1, "the fuse is dropped once we restored by hand");
});

test("radio already off: never turned on - the owner's setting is not ours to change", () => {
  const { calls, run } = fakeRun("disabled");
  const fuse = fakeFuse();
  let sawBody = false;
  wifiradio.withRadioOff(
    {},
    90,
    (done) => {
      sawBody = true;
      done();
    },
    { run, fuse: fuse.fn },
  );
  assert.ok(sawBody, "the operation still runs");
  assert.deepStrictEqual(calls, ["nmcli radio wifi"], "asked, then left it alone");
  assert.strictEqual(fuse.armed, 0, "nothing to restore, so nothing to arm");
});

test("no usable nmcli answer: the radio is left alone", () => {
  for (const [label, state, opts] of [
    ["unknown output", null, undefined],
    ["nmcli missing", "enabled", { err: new Error("ENOENT") }],
  ]) {
    const { calls, run } = fakeRun(state, opts);
    const fuse = fakeFuse();
    let sawBody = false;
    wifiradio.withRadioOff(
      {},
      90,
      (done) => {
        sawBody = true;
        done();
      },
      { run, fuse: fuse.fn },
    );
    assert.ok(sawBody, label + ": the operation still runs");
    assert.deepStrictEqual(calls, ["nmcli radio wifi"], label);
    assert.strictEqual(fuse.armed, 0, label);
  }
});

test("done() twice restores once", () => {
  // pair() answers on a timer AND on a state change; a double finish must not
  // fire a second `radio wifi on` (harmless) or a second disarm (not).
  const { calls, run } = fakeRun("enabled");
  const fuse = fakeFuse();
  wifiradio.withRadioOff(
    {},
    90,
    (done) => {
      done();
      done();
    },
    { run, fuse: fuse.fn },
  );
  assert.strictEqual(calls.filter((c) => c === "nmcli radio wifi on").length, 1);
  assert.strictEqual(fuse.disarmed, 1);
});

test("a body that never finishes leaves the fuse armed", () => {
  // The whole point of the fuse: if the operation wedges (or the shell dies),
  // the detached process is what brings a wifi-only box back.
  const { calls, run } = fakeRun("enabled");
  const fuse = fakeFuse();
  wifiradio.withRadioOff({}, 90, () => {}, { run, fuse: fuse.fn });
  assert.ok(!calls.includes("nmcli radio wifi on"), "nobody restored it here");
  assert.strictEqual(fuse.armed, 1);
  assert.strictEqual(fuse.disarmed, 0);
});

test("state() reports only the two answers it trusts", () => {
  const seen = [];
  for (const [out, want] of [
    ["enabled\n", "enabled"],
    ["disabled\n", "disabled"],
    ["missing\n", null],
    ["", null],
  ]) {
    wifiradio.state(
      {},
      (s) => seen.push(s),
      (_b, _a, _o, cb) => cb(null, out),
    );
    assert.strictEqual(seen.pop(), want, JSON.stringify(out));
  }
});

test("canDisable requires a wired carrier", () => {
  // Turning the radio off is only ever safe when something else carries the LAN:
  // the box has no other way back.
  assert.strictEqual(wifiradio.canDisable({ connected: true, ip: "192.168.1.219" }), true);
  assert.strictEqual(wifiradio.canDisable({ connected: false, ip: "" }), false);
  assert.strictEqual(wifiradio.canDisable(null), false);
  assert.strictEqual(wifiradio.canDisable(undefined), false);
});

test("setRadio asks nmcli for the state it was given, and reports failure", () => {
  const calls = [];
  const run = (cmd, args, opts, cb) => {
    calls.push([cmd, args.join(" ")]);
    cb(args[2] === "off" ? null : new Error("nmcli is unhappy"));
  };
  let ok = null;
  wifiradio.setRadio({}, false, (r) => (ok = r), { run });
  assert.deepStrictEqual(calls[0], ["nmcli", "radio wifi off"]);
  assert.strictEqual(ok, true);
  wifiradio.setRadio({}, true, (r) => (ok = r), { run });
  assert.deepStrictEqual(calls[1], ["nmcli", "radio wifi on"]);
  assert.strictEqual(ok, false); // a failed nmcli must not read as applied
});
