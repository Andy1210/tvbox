// firetvir.js unit tests - the pure parts: what a saved plan is allowed to contain,
// what this box can send, and what the python tool is handed. Nothing here touches the
// network or the BLE tool. How the picker's list is BUILT is not here any more: it is
// built by scripts/ir-index/ and tested there.
const test = require("node:test");
const assert = require("node:assert");
const firetvir = require("./firetvir");

const { sanitizePlan, resolvePlan, planSource, codeSendable } = firetvir._test;

// A code as the index publishes it: what a button sends, in the form the encoders take.
const irdbCode = (protocol, device, subdevice, fn) => ({
  protocol,
  entry: { irdb: { protocol, device, subdevice, function: fn } },
});
const flipperCode = (protocol, address, command) => ({ protocol, entry: { flipper: { protocol, address, command } } });
const rawCode = (n = 8) => ({
  protocol: "raw",
  entry: { raw: Array.from({ length: n }, (_, i) => i + 40), frequency: 38000 },
});

// The Samsung TV code 27 of that brand's irdb folders hold verbatim, and the soundbar
// whose volume lives on a raw capture with no power button at all.
const tvDevice = (id = "abc123def456") => ({
  id,
  brand: "Samsung",
  slug: "samsung-1a2b3c",
  label: "TV",
  kind: "tv",
  count: 27,
  sources: ["irdb", "flipper"],
  keys: {
    VolumeUp: irdbCode("NECx2", 7, 7, 7),
    VolumeDown: irdbCode("NECx2", 7, 7, 11),
    Mute: irdbCode("NECx2", 7, 7, 15),
    Power: irdbCode("NECx2", 7, 7, 2),
  },
});
const barDevice = (id = "def456abc123") => ({
  id,
  brand: "Samsung",
  slug: "samsung-1a2b3c",
  label: "Sound Bars",
  kind: "audio",
  count: 1,
  sources: ["flipper"],
  keys: { VolumeUp: rawCode(77), Mute: rawCode(77) },
});

test("sanitizePlan drops what it cannot vouch for", () => {
  const good = tvDevice();
  const plan = sanitizePlan({
    devices: [
      good,
      { ...good, id: "bad id!" },
      { ...good, id: "ffffffffffff", keys: { Power: { protocol: "NECx2", entry: { nonsense: 1 } } } },
      { ...good, id: "eeeeeeeeeeee", keys: {} },
    ],
    assign: {
      VolumeUp: { device: "abc123def456", second: "abc123def456" },
      Mute: { device: "abc123def456", second: "ffffffffffff" },
      Power: { device: "nosuchdevice", second: null },
      Bogus: { device: "abc123def456" },
    },
  });
  assert.equal(plan.devices.length, 1, "a junk id, an unknown code form or no codes at all is not stored");
  assert.equal(plan.assign.VolumeUp.second, null, "a device cannot be its own second - one press, one blast");
  assert.equal(plan.assign.Mute.second, null, "a second that is not a stored device is dropped");
  assert.ok(!plan.assign.Power, "an assignment to no device is not an assignment");
  assert.ok(!plan.assign.Bogus, "only the four programmable keys exist");
  assert.equal(sanitizePlan({}).devices.length, 0);
  assert.equal(sanitizePlan(null).devices.length, 0);
});

test("sanitizePlan checks the CODE, not just the shape around it", () => {
  // These end up as arguments to the keymap builder and then as infrared on a remote,
  // so a hand-edited plan file cannot smuggle anything else in.
  const bad = [
    { protocol: "raw", entry: { raw: [1, 2, 3], frequency: 38000 } }, // too short to be a frame
    { protocol: "raw", entry: { raw: Array.from({ length: 600 }, () => 40), frequency: 38000 } }, // past one action
    { protocol: "raw", entry: { raw: [40, 40, 40, 40, 40, 99999], frequency: 38000 } }, // wider than the uint16
    { protocol: "raw", entry: { raw: [40, 40, 40, 40, 40, 40], frequency: 5000 } }, // not a carrier
    { protocol: "NEC", entry: { flipper: { protocol: "NEC", address: "zz", command: "01" } } },
    { protocol: "NEC", entry: { flipper: { protocol: "NEC", address: "01 00", command: "" } } },
    { protocol: "bad protocol!", entry: { irdb: { protocol: "NEC1", device: 1, subdevice: -1, function: 2 } } },
    { protocol: "NEC1", entry: { irdb: { protocol: "NEC1", device: "x", subdevice: -1, function: 2 } } },
  ];
  for (const code of bad) {
    const plan = sanitizePlan({ devices: [{ ...tvDevice(), keys: { Power: code } }] });
    assert.equal(plan.devices.length, 0, "accepted " + JSON.stringify(code).slice(0, 80));
  }
  const ok = sanitizePlan({
    devices: [{ ...tvDevice(), keys: { Power: flipperCode("Samsung32", "07 00 00 00", "02 00 00 00") } }],
  });
  assert.equal(ok.devices[0].keys.Power.entry.flipper.protocol, "Samsung32");
});

test("sanitizePlan bounds what one remote can carry", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    ...tvDevice(String(i).padStart(12, "0")),
    label: "x".repeat(200),
    kind: "nonsense",
  }));
  const plan = sanitizePlan({ devices: many });
  assert.equal(plan.devices.length, 8);
  assert.equal(plan.devices[0].label.length, 60);
  assert.equal(plan.devices[0].kind, "other", "an unknown kind falls back rather than being stored");
});

test("sanitizePlan refuses a button the device cannot send", () => {
  // The screen can offer it (a replacement need not carry what the old device did),
  // and resolvePlan would then skip the key without a word - a button that reads as
  // set up and does nothing.
  const tv = tvDevice();
  const bar = barDevice();
  const plan = sanitizePlan({
    devices: [tv, bar],
    assign: {
      VolumeUp: { device: bar.id, second: tv.id },
      Power: { device: bar.id, second: null }, // the soundbar has no power code
      Mute: { device: tv.id, second: bar.id },
    },
  });
  assert.equal(plan.assign.VolumeUp.device, bar.id);
  assert.ok(!plan.assign.Power, "a power button on a device with no power code is not an assignment");
  assert.equal(plan.assign.Mute.second, bar.id, "a second device that DOES carry the key is kept");
});

test("sanitizePlan carries the saved time rather than stamping it", () => {
  // Reading is not saving: a `ts` refreshed on every read can never say when the setup
  // was made.
  assert.equal(sanitizePlan({ devices: [], assign: {}, ts: 1234 }).ts, 1234);
  assert.equal(sanitizePlan({ devices: [] }).ts, 0);
});

test("resolvePlan hands the tool the codes themselves, no fetch in the way", () => {
  const tv = tvDevice();
  const bar = barDevice();
  const spec = resolvePlan({
    devices: [tv, bar],
    assign: {
      VolumeUp: { device: bar.id, second: null },
      Power: { device: tv.id, second: bar.id }, // one press: the TV, and the bar has no power code
      Mute: { device: tv.id, second: bar.id },
    },
  });
  assert.deepEqual(Object.keys(spec.keys).sort(), ["Mute", "Power", "VolumeUp"]);
  assert.deepEqual(spec.keys.VolumeUp.raw.length, 77, "the raw capture travels verbatim");
  assert.equal(spec.keys.Power.optional, true, "a power code must not fail the rest of the keymap");
  assert.equal(spec.keys.Power.post_delay, 1000);
  assert.ok(!spec.keys.Power.second, "the soundbar carries no power code, so there is nothing to add");
  assert.ok(spec.keys.Mute.second.raw, "a second device that DOES carry the key is blasted with it");
  assert.equal(spec.duty_cycle, 33);
});

test("resolvePlan answers null rather than an empty keymap", () => {
  assert.equal(resolvePlan({ devices: [tvDevice()], assign: {} }), null);
  assert.equal(resolvePlan({}), null);
  // One key only, for the per-key test button: what is blasted is what a program would
  // write for that key, and nothing else.
  const only = resolvePlan(
    { devices: [tvDevice()], assign: { Power: { device: "abc123def456" }, Mute: { device: "abc123def456" } } },
    null,
    "Mute",
  );
  assert.deepEqual(Object.keys(only.keys), ["Mute"]);
});

test("the codes file says which databases its codes came from", () => {
  const src = planSource(
    sanitizePlan({ devices: [tvDevice(), barDevice()], assign: { Power: { device: "abc123def456" } } }),
  );
  assert.match(src, /Samsung TV \[irdb\+flipper\]/);
  assert.ok(!src.includes("Sound Bars"), "a device no button uses is not what the remote was programmed with");
});

test("codeSendable: a raw capture needs no encoder, an unknown protocol is not offered", () => {
  const supported = { irdb: new Set(["necx2"]), flipper: new Set(["samsung32"]) };
  assert.equal(codeSendable(rawCode(), supported), true);
  assert.equal(codeSendable(rawCode(), null), true, "even with no probe: it is sent verbatim");
  assert.equal(codeSendable(irdbCode("NECx2", 7, 7, 7), supported), true);
  assert.equal(codeSendable(irdbCode("XMP-1", 7, 7, 7), supported), false);
  assert.equal(codeSendable(flipperCode("Samsung32", "07 00 00 00", "02 00 00 00"), supported), true);
  assert.equal(codeSendable(flipperCode("Mitsubishi", "07 00 00 00", "02 00 00 00"), supported), false);
  // A probe that could not run must not grey out a code that works.
  assert.equal(codeSendable(irdbCode("NECx2", 7, 7, 7), null), null);
});

// The plan file is the box's only record of what a remote drives, and it holds EVERY
// remote - so these run against a real file, in a child process with its own home (the
// module resolves ~/.tvbox at import time, so one process is one box).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function inBox(home, body) {
  const script = `
    const os = require("os");
    os.homedir = () => ${JSON.stringify(home)};
    const f = require(${JSON.stringify(path.join(__dirname, "firetvir.js"))});
    ${body}
  `;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim();
}

const DEVICE = tvDevice();

test("a plan round-trips through the file, per remote", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ftir-"));
  fs.mkdirSync(path.join(home, ".tvbox"));
  const out = inBox(
    home,
    `
    f.writePlan("AA:BB:CC:DD:EE:FF", { devices: ${JSON.stringify([DEVICE])}, assign: { Power: { device: "abc123def456" } } });
    f.writePlan("11:22:33:44:55:66", { devices: ${JSON.stringify([DEVICE])}, assign: {} });
    const a = f.readPlan("aa:bb:cc:dd:ee:ff");
    console.log(JSON.stringify({ n: a.devices.length, power: a.assign.Power.device, ts: a.ts > 0, code: !!a.devices[0].keys.Power }));
  `,
  );
  assert.deepEqual(JSON.parse(out), { n: 1, power: "abc123def456", ts: true, code: true });
  // Written for the owner only: it names what is in someone's living room.
  assert.equal(fs.statSync(path.join(home, ".tvbox", "firetv_ir_plan.json")).mode & 0o777, 0o600);
  const both = JSON.parse(fs.readFileSync(path.join(home, ".tvbox", "firetv_ir_plan.json"), "utf8"));
  assert.deepEqual(Object.keys(both).sort(), ["11:22:33:44:55:66", "aa:bb:cc:dd:ee:ff"], "MACs are keyed lowercase");
});

test("a plan file that cannot be read is never rewritten from one remote", () => {
  // Half a file (a power cut mid-write, a hand edit) parses as nothing. Treating it as
  // "no remote is configured" and saving over it is how the OTHER remotes' setups would
  // be lost - so the write is refused and the screen is told.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ftir-"));
  fs.mkdirSync(path.join(home, ".tvbox"));
  const file = path.join(home, ".tvbox", "firetv_ir_plan.json");
  fs.writeFileSync(file, '{"aa:bb:cc:dd:ee:ff": {"devices": [{"id": "abc12');
  const out = inBox(
    home,
    `
    const wrote = f.writePlan("11:22:33:44:55:66", { devices: ${JSON.stringify([DEVICE])}, assign: {} });
    console.log(JSON.stringify({ wrote, read: f.readPlan("11:22:33:44:55:66") }));
  `,
  );
  const r = JSON.parse(out);
  assert.equal(r.wrote, null, "the write is refused");
  assert.equal(r.read, null, "and the read says so rather than answering 'nothing configured'");
  assert.ok(fs.readFileSync(file, "utf8").startsWith('{"aa:bb'), "the damaged file is left for a human");
});

test("what was written to one remote is not what another remote reports", () => {
  // The codes file is box-wide, so it cannot answer "what is on THIS remote" - and
  // erasing one remote used to clear the line the screen showed for the other.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ftir-"));
  fs.mkdirSync(path.join(home, ".tvbox"));
  const plans = {
    "aa:bb:cc:dd:ee:ff": { devices: [DEVICE], assign: {}, programmed: { label: "LG TV", ts: 5 } },
    "11:22:33:44:55:66": { devices: [DEVICE], assign: {}, programmed: { label: "Samsung Sound Bar", ts: 6 } },
  };
  fs.writeFileSync(path.join(home, ".tvbox", "firetv_ir_plan.json"), JSON.stringify(plans));
  const out = inBox(
    home,
    `
    f._test.updatePlan("11:22:33:44:55:66", (p) => ({ ...p, programmed: null }));
    console.log(JSON.stringify({
      erased: f.readPlan("11:22:33:44:55:66").programmed,
      other: f.readPlan("aa:bb:cc:dd:ee:ff").programmed,
    }));
  `,
  );
  const r = JSON.parse(out);
  assert.equal(r.erased, null, "the remote that was erased no longer claims to carry codes");
  assert.deepEqual(r.other, { label: "LG TV", ts: 5 }, "and the other remote is untouched");
});

test("the plan file is owner-only even when it already existed", () => {
  // writeFileSync's `mode` applies only when the file is CREATED, and is masked by
  // umask - a file that already existed would keep whatever it had.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ftir-"));
  fs.mkdirSync(path.join(home, ".tvbox"));
  const file = path.join(home, ".tvbox", "firetv_ir_plan.json");
  fs.writeFileSync(file, "{}");
  fs.chmodSync(file, 0o644);
  inBox(home, `f.writePlan("aa:bb:cc:dd:ee:ff", { devices: ${JSON.stringify([DEVICE])}, assign: {} });`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
