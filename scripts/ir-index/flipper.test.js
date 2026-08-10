// Reading Flipper-IRDB: which button of a file is which of our four, and what a raw
// capture becomes. Run: node --test scripts/ir-index/flipper.test.js
const test = require("node:test");
const assert = require("node:assert");
const flipper = require("./flipper");

const { parseIr, matchKey, rawUnits, firstFrameLength, blockRow, codesFromText, kindOf, categoryLabel, setName } =
  flipper;

// A Samsung soundbar, verbatim from SoundBars/Samsung/Samsung_AH59-02767C.ir. Its
// Vol_up is one 77-value frame with a 4.5 ms SPACE in the middle - the shape that
// makes a gap rule dangerous, and a code no irdb protocol can express.
const SOUNDBAR_VOL_UP_US = [
  4515, 4489, 497, 503, 500, 504, 499, 503, 500, 504, 499, 1507, 500, 1508, 498, 504, 499, 505, 498, 1507, 499, 1509,
  497, 1506, 500, 1507, 499, 503, 500, 503, 500, 506, 497, 503, 500, 4518, 498, 502, 501, 504, 499, 503, 500, 504, 499,
  1507, 499, 1508, 498, 1509, 497, 504, 499, 1507, 499, 1507, 499, 1508, 498, 505, 498, 503, 500, 504, 499, 505, 498,
  1508, 499, 503, 500, 504, 499, 505, 498, 1507, 499,
];
// What the same button has to come out as: the 10-microsecond units of a keymap
// action, taken from a hand-written codes file that is known to drive this soundbar.
// A capture reaching the remote unchanged is the whole point of the raw path.
const SOUNDBAR_VOL_UP_UNITS = [
  452, 449, 50, 50, 50, 50, 50, 50, 50, 50, 50, 151, 50, 151, 50, 50, 50, 50, 50, 151, 50, 151, 50, 151, 50, 151, 50,
  50, 50, 50, 50, 51, 50, 50, 50, 452, 50, 50, 50, 50, 50, 50, 50, 50, 50, 151, 50, 151, 50, 151, 50, 50, 50, 151, 50,
  151, 50, 151, 50, 50, 50, 50, 50, 50, 50, 50, 50, 151, 50, 50, 50, 50, 50, 50, 50, 151, 50,
];

const SOUNDBAR_FILE = `Filetype: IR signals file
Version: 1
#
# SAMSUNG AH59-02767C SOUNDBAR REMOTE
#
name: Power
type: raw
frequency: 38000
duty_cycle: 0.330000
data: ${SOUNDBAR_VOL_UP_US.join(" ")}
#
name: Woofer_up
type: raw
frequency: 38000
duty_cycle: 0.330000
data: ${SOUNDBAR_VOL_UP_US.join(" ")}
#
name: Vol_up
type: raw
frequency: 38000
duty_cycle: 0.330000
data: ${SOUNDBAR_VOL_UP_US.join(" ")}
#
name: Vol_dn
type: parsed
protocol: Samsung32
address: 07 00 00 00
command: 0B 00 00 00
`;

test("a soundbar capture converts to the units a working codes file holds", () => {
  const keys = codesFromText(SOUNDBAR_FILE);
  assert.deepEqual(Object.keys(keys).sort(), ["Power", "VolumeDown", "VolumeUp"]);
  assert.deepEqual(keys.VolumeUp.entry.raw, SOUNDBAR_VOL_UP_UNITS);
  assert.equal(keys.VolumeUp.entry.frequency, 38000);
  assert.equal(keys.VolumeUp.protocol, "raw");
  // `Woofer_up` is not the volume, and it comes FIRST in the file - the rejects are what
  // stop a subwoofer trim from becoming the volume button.
  assert.equal(matchKey("Woofer_up"), null);
  assert.equal(keys.VolumeDown.entry.flipper.protocol, "Samsung32");
});

test("a file's blocks are read whatever separates them", () => {
  const blocks = parseIr(SOUNDBAR_FILE);
  assert.deepEqual(
    blocks.map((b) => b.name),
    ["Power", "Woofer_up", "Vol_up", "Vol_dn"],
  );
  // Some files omit the `#` between blocks; a second `name:` starts one too.
  const run = parseIr("name: A\ntype: parsed\nname: B\ntype: raw\n");
  assert.deepEqual(
    run.map((b) => b.name),
    ["A", "B"],
  );
  assert.deepEqual(parseIr(""), []);
  assert.deepEqual(parseIr("Filetype: IR signals file\nVersion: 1\n"), [], "a header is not a button");
});

test("the button names this database really uses", () => {
  const key = (n) => (matchKey(n) || [])[0];
  for (const n of ["Vol_up", "VOL+", "Vol+", "Volume_up", "Vol_plus", "VolUp", "+ Volume", "TV_VOL+", "Vol UP"]) {
    assert.equal(key(n), "VolumeUp", n);
  }
  for (const n of ["Vol_dn", "VOL-", "Vol_down", "Vol_dwn", "Vol_min", "Volume_Down", "VolDown", "- Volume"]) {
    assert.equal(key(n), "VolumeDown", n);
  }
  for (const n of ["Mute", "MUTE", "Muting", "VolumeMute"]) assert.equal(key(n), "Mute", n);
  for (const n of ["Power", "POWER", "On_off", "Standby", "On/Off", "Power_off", "Off"]) {
    assert.equal(key(n), "Power", n);
  }
  // What must never bind: an air-conditioner mode, another channel's volume, a mute
  // that silences the picture instead of the sound.
  for (const n of ["Powerful", "FanPower+", "Woofer_dn", "Bass_up", "Right_VolUp", "Av_mute", "Mic_mute", "Volume"]) {
    assert.equal(matchKey(n), null, n);
  }
});

test("an exact spelling wins the key over a loose one", () => {
  // A file with both `Mute` and `Tv_mute` must bind the plain one; `codesFromText` keeps
  // the higher score whichever order they appear in.
  const both = (first, second) =>
    codesFromText(
      `name: ${first}\ntype: parsed\nprotocol: NEC\naddress: 01 00 00 00\ncommand: 01 00 00 00\n#\n` +
        `name: ${second}\ntype: parsed\nprotocol: NEC\naddress: 02 00 00 00\ncommand: 02 00 00 00\n`,
    ).Mute.entry.flipper.address;
  assert.equal(both("Mute", "Tv_mute"), "01 00 00 00");
  assert.equal(both("Tv_mute", "Mute"), "02 00 00 00");
});

test("a repeated capture is cut to one frame, a two-part code is not", () => {
  // 263 of the ~900 captures that carry one of our buttons are the same frame two to
  // twenty times over: a volume press would step twice, a power toggle would undo
  // itself.
  const frame = [900, 450, 56, 56, 56, 169, 56, 56, 56, 169, 56];
  const twice = [...frame, 20000, ...frame];
  assert.equal(firstFrameLength(twice), frame.length);
  assert.deepEqual(rawUnits(twice.join(" ")), rawUnits(frame.join(" ")));
  const fourTimes = [...frame, 20000, ...frame, 20000, ...frame, 20000, ...frame];
  assert.equal(firstFrameLength(fourTimes), frame.length);

  // The Samsung frame carries a 4.5 ms space of its own, in the MIDDLE. Cutting there
  // would send half a code.
  assert.equal(firstFrameLength(SOUNDBAR_VOL_UP_US), 0);
  assert.equal(rawUnits(SOUNDBAR_VOL_UP_US.join(" ")).length, 77);
  // Two different halves (air conditioners send these) stay whole as well.
  const other = [900, 450, 56, 169, 56, 169, 56, 56, 56, 56, 56];
  assert.equal(firstFrameLength([...frame, 20000, ...other]), 0);
});

test("a raw block this box could not send is refused rather than trimmed to nonsense", () => {
  assert.equal(rawUnits(""), null);
  assert.equal(rawUnits("900 450 56"), null, "too short to be a frame");
  assert.equal(rawUnits("900 450 56 56 x 56 56"), null, "a non-numeric timing");
  assert.equal(rawUnits("900 450 56 56 56 700000"), null, "wider than the uint16 the keymap stores");
  const long = Array.from({ length: 600 }, () => 500).join(" ");
  assert.equal(rawUnits(long), null, "more timings than one keymap action carries");
  // A capture that ends on a space ends on silence; a frame ends on a mark.
  assert.equal(rawUnits("900 450 56 56 56 169 56 200").length % 2, 1);
});

test("a parsed block is checked before it is published", () => {
  const ok = blockRow({ type: "parsed", protocol: "Samsung32", address: "07 00 00 00", command: "02 00 00 00" });
  assert.equal(ok.protocol, "Samsung32");
  assert.equal(ok.variant, "Samsung32 07,02", "the address a row shows drops the padding");
  assert.deepEqual(ok.entry.flipper, { protocol: "Samsung32", address: "07 00 00 00", command: "02 00 00 00" });
  assert.equal(blockRow({ type: "parsed", protocol: "NEC", address: "7", command: "02 00 00 00" }), null);
  assert.equal(blockRow({ type: "parsed", protocol: "NE C", address: "07 00", command: "02 00" }), null);
  assert.equal(blockRow({ type: "parsed", address: "07 00", command: "02 00" }), null);
  assert.equal(blockRow({ type: "raw", frequency: "38000", data: "900 450 56 56 56 169 56" }).protocol, "raw");
  assert.equal(blockRow({ type: "raw", frequency: "1000", data: "900 450 56 56 56 169 56" }), null, "not a carrier");
  assert.equal(blockRow({ type: "something else" }), null);
});

test("a category says what the thing is, and what kind of thing it is", () => {
  assert.equal(kindOf("SoundBars"), "audio");
  assert.equal(kindOf("TVs"), "tv", "the folder name is not the word 'tv'");
  assert.equal(kindOf("Car_Multimedia"), "audio");
  assert.equal(kindOf("ACs"), "climate");
  assert.equal(kindOf("Toys"), "other");
  assert.equal(categoryLabel("Audio_and_Video_Receivers"), "Audio and Video Receivers");
  assert.equal(categoryLabel("SoundBars"), "Sound Bars");
  assert.equal(setName("Samsung_AH59-02767C.ir", "Samsung"), "AH59-02767C");
  assert.equal(setName("LG_AKB73495301.ir", "LG"), "AKB73495301");
  assert.equal(setName("Samsung.ir", "Samsung"), "Samsung", "a file named after the brand keeps a name");
});
