// firetvir.js unit tests - the pure parts that decide what the picker shows: how
// codesets merge into devices, what a merged group is called, and what a saved plan
// is allowed to contain. Nothing here touches the network or the BLE tool.
const test = require("node:test");
const assert = require("node:assert");
const firetvir = require("./firetvir");

const { signature, groupSets, bestType, deviceKind, typeLabel, sanitizePlan } = firetvir._test;

const row = (protocol, device, subdevice, fn) => ({ functionname: "x", protocol, device, subdevice, function: fn });
// The four keys a Samsung TV codeset carries (NECx2, device 7 subdevice 7), which is
// the code 27 of the brand's 68 folders hold verbatim.
const samsungTv = () => ({
  VolumeUp: row("NECx2", 7, 7, 7),
  VolumeDown: row("NECx2", 7, 7, 11),
  Mute: row("NECx2", 7, 7, 15),
  Power: row("NECx2", 7, 7, 2),
});
// The soundbar: volume and mute on a different address, and no power at all.
const samsungBar = () => ({
  VolumeUp: row("NECx2", 67, 83, 7),
  VolumeDown: row("NECx2", 67, 83, 11),
  Mute: row("NECx2", 67, 83, 15),
});

test("signature ignores nothing but absent keys", () => {
  assert.equal(signature(samsungTv()), signature(samsungTv()));
  assert.notEqual(signature(samsungTv()), signature(samsungBar()));
  // A set carrying only some of the keys can never merge into a fuller one, or a
  // button would be assigned to a device that cannot send it.
  const noPower = samsungTv();
  delete noPower.Power;
  assert.notEqual(signature(samsungTv()), signature(noPower));
  assert.equal(signature({}), "");
});

test("groupSets merges identical codes and keeps one representative path", () => {
  const sets = [
    { path: "codes/Samsung/TV/7,7.csv", type: "TV", keys: samsungTv() },
    { path: "codes/Samsung/Unknown_BN59-00869A/7,7.csv", type: "Unknown_BN59-00869A", keys: samsungTv() },
    { path: "codes/Samsung/Unknown_AA59-00600A/7,7.csv", type: "Unknown_AA59-00600A", keys: samsungTv() },
    { path: "codes/Samsung/Unknown_AH59-01527F/67,83.csv", type: "Unknown_AH59-01527F", keys: samsungBar() },
    { path: "codes/Samsung/Air Conditioner/1,8.csv", type: "Air Conditioner", keys: {} },
  ];
  const { devices, skipped } = groupSets(sets);
  assert.equal(devices.length, 2, "three identical TV folders are one device");
  assert.equal(skipped, 1, "a set with none of the four keys is dropped, not shown");

  const tv = devices.find((d) => d.label === "TV");
  assert.equal(tv.count, 3);
  // The label came from the "TV" folder, so the path must be that folder's too -
  // the row says TV and what gets programmed has to be what the row says.
  assert.equal(tv.path, "codes/Samsung/TV/7,7.csv");
  assert.equal(tv.kind, "tv");
  assert.deepEqual(tv.keys, ["VolumeUp", "VolumeDown", "Mute", "Power"]);

  const bar = devices.find((d) => d.label === "AH59-01527F");
  assert.equal(bar.count, 1);
  assert.deepEqual(bar.keys, ["VolumeUp", "VolumeDown", "Mute"], "no power on this one");
  assert.notEqual(bar.id, tv.id);
});

test("groupSets tells two same-named codes apart", () => {
  // LG really does file two different codes under "TV", and a picker with two rows
  // reading "TV" is a coin toss.
  const other = { ...samsungTv(), VolumeUp: row("NEC1", 4, -1, 2) };
  const { devices } = groupSets([
    { path: "codes/LG/TV/4,-1.csv", type: "TV", keys: other },
    { path: "codes/LG/TV/7,7.csv", type: "TV", keys: samsungTv() },
    { path: "codes/LG/Sound Bar/44,44.csv", type: "Sound Bar", keys: samsungBar() },
  ]);
  const labels = devices.map((d) => d.label);
  assert.equal(new Set(labels).size, labels.length, "no two rows read the same");
  assert.ok(
    labels.some((l) => l.startsWith("TV (")),
    "the repeat carries the address it transmits on: " + labels.join(" | "),
  );
  assert.ok(labels.includes("Sound Bar"), "a name that is unique is left alone");
});

test("groupSets numbers what even the address cannot tell apart", () => {
  // Sony files two codes under one folder on the same device number, differing only
  // in the function bytes - so the address suffix collides too, and two rows a person
  // cannot tell apart is the one outcome the picker must not have.
  const a = { VolumeUp: row("Sony12", 28, -1, 1), Power: row("Sony12", 28, -1, 2) };
  const b = { VolumeUp: row("Sony12", 28, -1, 9), Power: row("Sony12", 28, -1, 8) };
  const { devices } = groupSets([
    { path: "codes/Sony/DAT/28,-1.csv", type: "DAT", keys: a },
    { path: "codes/Sony/DAT/28,-1b.csv", type: "DAT", keys: b },
  ]);
  const labels = devices.map((d) => d.label);
  assert.equal(new Set(labels).size, 2, "still two distinct rows: " + labels.join(" | "));
});

test("groupSets ids are the codes, not the order they arrived in", () => {
  const a = groupSets([{ path: "codes/A/TV/1,1.csv", type: "TV", keys: samsungTv() }]).devices[0];
  const b = groupSets([
    { path: "codes/B/Unknown_x/9,9.csv", type: "Unknown_x", keys: samsungBar() },
    { path: "codes/B/TV/1,1.csv", type: "TV", keys: samsungTv() },
  ]).devices.find((d) => d.label === "TV");
  assert.equal(a.id, b.id, "same codes, same id - a saved plan survives a refetch");
});

test("bestType prefers a real device type over a remote model number", () => {
  assert.equal(bestType(["Unknown_BN59-00869A", "TV", "Rear Projection DLP TV"]), "TV");
  assert.equal(bestType(["Unknown_AH59-01527F"]), "Unknown_AH59-01527F");
  assert.equal(typeLabel("Unknown_AH59-01527F"), "AH59-01527F");
  assert.equal(typeLabel("Sound Bar"), "Sound Bar");
});

test("deviceKind: the narrower word wins", () => {
  assert.equal(deviceKind(["TV"]), "tv");
  assert.equal(deviceKind(["Video Projector"]), "tv");
  assert.equal(deviceKind(["Sound Bar"]), "audio");
  assert.equal(deviceKind(["Receiver"]), "audio");
  assert.equal(deviceKind(["CD Player"]), "audio", "a CD player is audio, not a disc player");
  assert.equal(deviceKind(["Satellite Receiver"]), "settop", "and a satellite receiver is neither");
  assert.equal(deviceKind(["DVD Player"]), "player");
  assert.equal(deviceKind(["Air Conditioner"]), "climate");
  assert.equal(deviceKind(["Unknown_AH59-01527F"]), "other");
  // A group carries every folder it merged, and one real name is enough to name it.
  assert.equal(deviceKind(["Unknown_BN59-00869A", "TV"]), "tv");
});

test("sanitizePlan drops what it cannot vouch for", () => {
  const good = {
    id: "abc123def456",
    brand: "Samsung",
    label: "TV",
    kind: "tv",
    path: "codes/Samsung/TV/7,7.csv",
    // All four, so this test stays about IDENTITY - which id may be named where.
    // The rule about a device that cannot send a key has its own test below.
    keys: ["VolumeUp", "VolumeDown", "Mute", "Power"],
    protocol: "NECx2",
  };
  const plan = sanitizePlan({
    devices: [
      good,
      { ...good, id: "bad id!" },
      { ...good, id: "ffffffffffff", path: "../../etc/passwd" },
      { ...good, id: "eeeeeeeeeeee", path: "https://example.invalid/x.csv" },
    ],
    assign: {
      VolumeUp: { device: "abc123def456", second: "abc123def456" },
      Mute: { device: "abc123def456", second: "ffffffffffff" },
      Power: { device: "nosuchdevice", second: null },
      Bogus: { device: "abc123def456" },
    },
  });
  assert.equal(plan.devices.length, 1, "a junk id or a path outside irdb is not stored");
  assert.equal(plan.assign.VolumeUp.second, null, "a device cannot be its own second - one press, one blast");
  assert.equal(plan.assign.Mute.second, null, "a second that is not a stored device is dropped");
  assert.ok(!plan.assign.Power, "an assignment to no device is not an assignment");
  assert.ok(!plan.assign.Bogus, "only the four programmable keys exist");
  assert.equal(sanitizePlan({}).devices.length, 0);
  assert.equal(sanitizePlan(null).devices.length, 0);
});

test("sanitizePlan bounds what one remote can carry", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: String(i).padStart(12, "0"),
    path: "codes/X/TV/1,1.csv",
    label: "x".repeat(200),
    kind: "nonsense",
  }));
  const plan = sanitizePlan({ devices: many });
  assert.equal(plan.devices.length, 8);
  assert.equal(plan.devices[0].label.length, 60);
  assert.equal(plan.devices[0].kind, "other", "an unknown kind falls back rather than being stored");
});

test("sanitizePlan refuses a button the device cannot send", () => {
  // The screen can offer it (the key filter is a toggle, and a replacement need not
  // carry what the old device did), and resolvePlan would then skip the key without
  // a word - a button that reads as set up and does nothing.
  const tv = {
    id: "abc123def456",
    path: "codes/Samsung/TV/7,7.csv",
    keys: ["VolumeUp", "VolumeDown", "Mute", "Power"],
  };
  const bar = { id: "def456abc123", path: "codes/Samsung/Unknown_AH59/67,83.csv", keys: ["VolumeUp", "Mute"] };
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

test("sanitizePlan bounds a field's size, not just the number of fields", () => {
  // The count is what a caller controls least: `keys` passes a membership filter
  // however many times it is repeated, and a plan file too big to read back reports
  // EVERY remote as unconfigured.
  const plan = sanitizePlan({
    devices: [
      {
        id: "abc123def456",
        path: "codes/X/TV/1,1.csv",
        keys: Array.from({ length: 5000 }, () => "Power"),
      },
    ],
  });
  assert.deepEqual(plan.devices[0].keys, ["Power"], "deduped, not just filtered");

  // Capped BEFORE it is validated, so an over-long path loses its ".csv" and the
  // device is refused outright rather than stored as a novel.
  const long = "codes/" + "a".repeat(5000) + "/TV/1,1.csv";
  const withLongPath = sanitizePlan({ devices: [{ id: "abc123def456", path: long, keys: ["Power"] }] });
  assert.equal(withLongPath.devices.length, 0);
});

test("sanitizePlan carries the saved time rather than stamping it", () => {
  // Reading is not saving: a `ts` refreshed on every read can never say when the
  // setup was made.
  const one = sanitizePlan({ devices: [], assign: {}, ts: 1234 });
  assert.equal(one.ts, 1234);
  assert.equal(sanitizePlan({ devices: [] }).ts, 0);
});

// The plan file is the box's only record of what a remote drives, and it holds
// EVERY remote - so these run against a real file, in a child process with its own
// home (the module resolves ~/.tvbox at import time, so one process is one box).
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

const DEVICE = {
  id: "abc123def456",
  brand: "Samsung",
  label: "TV",
  kind: "tv",
  path: "codes/Samsung/TV/7,7.csv",
  keys: ["VolumeUp", "Power"],
  protocol: "NECx2",
};

test("a plan round-trips through the file, per remote", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ftir-"));
  fs.mkdirSync(path.join(home, ".tvbox"));
  const out = inBox(
    home,
    `
    f.writePlan("AA:BB:CC:DD:EE:FF", { devices: ${JSON.stringify([DEVICE])}, assign: { Power: { device: "abc123def456" } } });
    f.writePlan("11:22:33:44:55:66", { devices: ${JSON.stringify([DEVICE])}, assign: {} });
    const a = f.readPlan("aa:bb:cc:dd:ee:ff");
    console.log(JSON.stringify({ n: a.devices.length, power: a.assign.Power.device, ts: a.ts > 0 }));
  `,
  );
  assert.deepEqual(JSON.parse(out), { n: 1, power: "abc123def456", ts: true });
  // Written for the owner only: it names what is in someone's living room.
  assert.equal(fs.statSync(path.join(home, ".tvbox", "firetv_ir_plan.json")).mode & 0o777, 0o600);
  const both = JSON.parse(fs.readFileSync(path.join(home, ".tvbox", "firetv_ir_plan.json"), "utf8"));
  assert.deepEqual(Object.keys(both).sort(), ["11:22:33:44:55:66", "aa:bb:cc:dd:ee:ff"], "MACs are keyed lowercase");
});

test("a plan file that cannot be read is never rewritten from one remote", () => {
  // Half a file (a power cut mid-write, a hand edit) parses as nothing. Treating it
  // as "no remote is configured" and saving over it is how the OTHER remotes' setups
  // would be lost - so the write is refused and the screen is told.
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
