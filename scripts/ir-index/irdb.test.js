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

test("a name that must not bind does not bind here either", () => {
  // A contains-match is what makes `KEY_VOLUMEUP` work, and it is also what binds
  // `SUBWOOFER VOL+` to the TV's volume and `POWERFUL` to its power. The Flipper reader
  // rejects these names, and one index cannot hold two answers for one spelling.
  const csv = `functionname,protocol,device,subdevice,function
SUBWOOFER VOL+,NEC1,4,-1,20
POWERFUL,NEC1,4,-1,21
CENTER VOL-,NEC1,4,-1,22
`;
  assert.deepEqual(codesFromText(csv), {});
  // The real rows still bind, with the rejected ones in the same codeset.
  const mixed = csv + "VOL+,NEC1,4,-1,2\nPOWER,NEC1,4,-1,8\n";
  const keys = codesFromText(mixed);
  assert.equal(keys.VolumeUp.entry.irdb.function, 2);
  assert.equal(keys.Power.entry.irdb.function, 8);
  assert.ok(!keys.VolumeDown, "a centre-channel row is not the volume down button");
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

// ---- the input keys ----------------------------------------------------------------
// The real LG rows, which is what makes this worth a test: both databases agree on
// address 4 with these functions, and they are the only way to aim a TV at a socket -
// CEC has no command for it.
test("LG's input rows land on the discrete keys and the cycling one", () => {
  const csv = [
    "functionname,protocol,device,subdevice,function",
    "POWER,NEC1,4,-1,8",
    "TV/AV,NEC1,4,-1,11",
    "HDMI 1,NEC1,4,-1,206",
    "HDMI 2,NEC1,4,-1,204",
    "HDMI 3,NEC1,4,-1,233",
    "HDMI 4,NEC1,4,-1,218",
  ].join("\n");
  const keys = codesFromText(csv);
  assert.equal(keys.HDMI1.entry.irdb.function, 206);
  assert.equal(keys.HDMI2.entry.irdb.function, 204);
  assert.equal(keys.HDMI3.entry.irdb.function, 233);
  assert.equal(keys.HDMI4.entry.irdb.function, 218);
  assert.equal(keys.Input.entry.irdb.function, 11, "TV/AV is the stepping button");
});

test("a name that picks one socket never becomes the cycling Input", () => {
  // The whole reason the discrete keys exist is to AIM; answering "which input?" with
  // "the next one" would switch to whatever happens to be adjacent.
  for (const name of ["HDMI 2", "COMPONENT 1", "VIDEO 1", "RGB - PC", "ANTENNA"]) {
    const keys = codesFromText(`functionname,protocol,device,subdevice,function\n${name},NEC1,4,-1,99`);
    assert.ok(!keys.Input, name + " must not bind Input");
  }
});

test("a word that merely contains an input name is not an input", () => {
  // These are matched by CONTAINS, which is what made a bare `AV` unusable as a synonym:
  // it is inside SAVE and AVMUTE. The regression is that any of these silently becomes
  // "switch the television's input".
  const csv = [
    "functionname,protocol,device,subdevice,function",
    "SAVE,NEC1,4,-1,77",
    "A/V MUTE,NEC1,4,-1,80",
    "AV1,NEC1,4,-1,90",
  ].join("\n");
  assert.ok(!codesFromText(csv).Input);
});
