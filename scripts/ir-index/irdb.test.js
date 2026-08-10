// Reading irdb: which CSV row is which of our four buttons, and what a folder name says
// about the device. Run: node --test scripts/ir-index/irdb.test.js
const test = require("node:test");
const assert = require("node:assert");
const { parseCsv, codesFromText, typeLabel, deviceKind, normalizeRow } = require("./irdb");

const CSV = `functionname,protocol,device,subdevice,function
KEY_POWER,NECx2,7,7,2
KEY_VOLUMEUP,NECx2,7,7,7
KEY_VOLUMEDOWN,NECx2,7,7,11
KEY_MUTE,NECx2,7,7,15
KEY_CHANNELUP,NECx2,7,7,18
`;

test("a codeset's rows become the four buttons", () => {
  const rows = parseCsv(CSV);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { functionname: "KEY_POWER", protocol: "NECx2", device: 7, subdevice: 7, function: 2 });
  const keys = codesFromText(CSV);
  assert.deepEqual(Object.keys(keys).sort(), ["Mute", "Power", "VolumeDown", "VolumeUp"]);
  assert.deepEqual(keys.VolumeUp.entry.irdb, { protocol: "NECx2", device: 7, subdevice: 7, function: 7 });
  assert.equal(keys.VolumeUp.variant, "NECx2 7,7");
});

test("both naming conventions in the database are read", () => {
  // irdb mixes human ("VOLUME +") and evdev-style ("KEY_VOLUMEUP") names, the latter
  // common on audio remotes. Without collapsing both, a KEY_* codeset silently loses
  // volume up and down while MUTE and POWER survive as substrings - which is exactly
  // the case for a Samsung soundbar.
  const human = `functionname,protocol,device,subdevice,function
VOLUME +,NECx2,67,83,7
VOLUME -,NECx2,67,83,11
MUTE TOGGLE,NECx2,67,83,15
`;
  const keys = codesFromText(human);
  assert.equal(keys.VolumeUp.entry.irdb.function, 7);
  assert.equal(keys.VolumeDown.entry.irdb.function, 11);
  assert.equal(keys.Mute.entry.irdb.function, 15);
  assert.ok(!keys.Power, "a codeset with no power row does not get one");
});

test("an exact function name beats a longer one that merely contains it", () => {
  const csv = `functionname,protocol,device,subdevice,function
VOLUME UP/DOWN,NEC1,4,-1,3
VOL UP,NEC1,4,-1,2
`;
  assert.equal(codesFromText(csv).VolumeUp.entry.irdb.function, 2, "a combo row is the last resort");
});

test("a row with no usable numbers is not a code", () => {
  const csv = `functionname,protocol,device,subdevice,function
KEY_POWER,NECx2,x,7,y
`;
  assert.deepEqual(codesFromText(csv), {});
  assert.deepEqual(parseCsv("functionname,protocol\nshort,row\n"), [], "a row missing columns is skipped");
});

test("a folder name says what the device is, or admits it is a model number", () => {
  assert.equal(typeLabel("Unknown_AH59-01527F"), "AH59-01527F");
  assert.equal(typeLabel("TV"), "TV");
  assert.equal(deviceKind(["TV"]), "tv");
  assert.equal(deviceKind(["Sound Bar"]), "audio");
  assert.equal(deviceKind(["Satellite Receiver"]), "settop", "the narrower word wins over 'receiver'");
  assert.equal(deviceKind(["CD Player"]), "audio", "and a CD player is audio, not a disc player");
  assert.equal(deviceKind(["Air Conditioner"]), "climate");
  assert.equal(deviceKind(["Unknown_AH59-01527F"]), "other");
  assert.equal(deviceKind(["Unknown_BN59-00869A", "TV"]), "tv", "one real name is enough to name a group");
});

test("a normalized row carries what the box needs and nothing else", () => {
  const r = normalizeRow({ protocol: "NEC1", device: 4, subdevice: -1, function: 8 });
  assert.deepEqual(r.entry, { irdb: { protocol: "NEC1", device: 4, subdevice: -1, function: 8 } });
  assert.equal(r.variant, "NEC1 4", "no subdevice, nothing to print");
  assert.equal(normalizeRow({ protocol: "NEC1", device: 4, subdevice: 5, function: 8 }).variant, "NEC1 4,5");
  assert.match(r.sig, /^irdb:NEC1:4:-1:8$/);
});
