// What makes a readable list out of two databases: codesets that send the same frames
// are one device, and the name a merged device gets has to tell it apart from the next
// one. Run: node --test scripts/ir-index/group.test.js
const test = require("node:test");
const assert = require("node:assert");
const { signature, groupSets, bestLabel } = require("./group");

// A key row as the sources produce it, with `frame` standing for what the encoders say
// it transmits - that is the field the grouping is really keyed on.
const row = (frame, protocol, variant) => ({ frame, protocol, variant, sig: "sig:" + frame, entry: { irdb: {} } });
const tvKeys = () => ({
  VolumeUp: row("f-vu", "NECx2", "NECx2 7,7"),
  VolumeDown: row("f-vd", "NECx2", "NECx2 7,7"),
  Mute: row("f-mu", "NECx2", "NECx2 7,7"),
  Power: row("f-pw", "NECx2", "NECx2 7,7"),
});
const barKeys = () => ({
  VolumeUp: row("b-vu", "raw", "raw 38 kHz"),
  VolumeDown: row("b-vd", "raw", "raw 38 kHz"),
  Mute: row("b-mu", "raw", "raw 38 kHz"),
});
const set = (over) => ({
  source: "irdb",
  brand: "Samsung",
  type: "TV",
  label: "TV",
  kind: "tv",
  model: null,
  path: "codes/Samsung/TV/7,7.csv",
  keys: tvKeys(),
  ...over,
});

test("signature is the frames, and an absent key is not an empty one", () => {
  assert.equal(signature(tvKeys()), signature(tvKeys()));
  assert.notEqual(signature(tvKeys()), signature(barKeys()));
  // A set carrying only some of the keys can never merge into a fuller one, or a button
  // would be assigned to a device that cannot send it.
  const noPower = tvKeys();
  delete noPower.Power;
  assert.notEqual(signature(tvKeys()), signature(noPower));
  assert.equal(signature({}), "");
  // A row the encoders could not answer for still groups, by its own descriptor.
  const unencodable = { VolumeUp: { ...row("", "XMP-1", "XMP-1 3"), sig: "irdb:XMP-1:3:-1:9" } };
  assert.equal(signature(unencodable), "VolumeUp:irdb:XMP-1:3:-1:9");
});

test("codesets that send the same frames are one device, whichever database they are in", () => {
  const { devices, skipped } = groupSets([
    set(),
    set({ type: "Unknown_BN59-00869A", label: "BN59-00869A", model: "BN59-00869A" }),
    set({ source: "flipper", type: "TVs", label: "TVs", model: "BN59-01178W", path: "TVs/Samsung/x.ir" }),
    set({ type: "Unknown_AH59-01527F", label: "AH59-01527F", model: "AH59-01527F", kind: "audio", keys: barKeys() }),
    set({ type: "Air Conditioner", label: "Air Conditioner", keys: {} }),
  ]);
  assert.equal(devices.length, 2, "three folders sending one code are one row");
  assert.equal(skipped, 1, "a set with none of the four keys is dropped, not shown");

  const tv = devices.find((d) => d.kind === "tv");
  assert.equal(tv.count, 3);
  assert.equal(tv.label, "TV", "a real device type beats a model number");
  assert.deepEqual(tv.sources, ["flipper", "irdb"], "the row says it is in both databases");
  assert.deepEqual(Object.keys(tv.keys).sort(), ["Mute", "Power", "VolumeDown", "VolumeUp"]);

  const bar = devices.find((d) => d.kind === "audio");
  assert.deepEqual(Object.keys(bar.keys).sort(), ["Mute", "VolumeDown", "VolumeUp"], "no power on this one");
  assert.notEqual(bar.id, tv.id);
});

test("a device keeps the cheapest form of each code", () => {
  // All the sets in a group send the same frame, so this is about size: a decoded row
  // is four numbers where a capture is up to 512.
  const raw = { ...row("f-vu", "raw", "raw 38 kHz"), entry: { raw: [40, 40, 40, 40, 40, 40], frequency: 38000 } };
  const irdb = { ...row("f-vu", "NEC1", "NEC1 4"), entry: { irdb: { protocol: "NEC1", device: 4 } } };
  const { devices } = groupSets([
    set({ source: "flipper", keys: { VolumeUp: raw } }),
    set({ keys: { VolumeUp: irdb } }),
  ]);
  assert.equal(devices.length, 1);
  assert.ok(devices[0].keys.VolumeUp.entry.irdb, "the decoded row is what travels to the box");
});

test("two rows a person cannot tell apart are named apart", () => {
  const other = () => ({ ...tvKeys(), Power: row("f-pw2", "NECx2", "NECx2 7,7") });
  const { devices } = groupSets([
    set({ source: "flipper", type: "TVs", label: "TVs", model: "AA59-00602A", path: "TVs/Samsung/a.ir" }),
    set({
      source: "flipper",
      type: "TVs",
      label: "TVs",
      model: "BN59-01178W",
      path: "TVs/Samsung/b.ir",
      keys: other(),
    }),
  ]);
  assert.equal(devices.length, 2);
  // The variant speaks for the first key only, and here both groups share it - so the
  // model number off the remote in someone's hand is what separates them.
  assert.deepEqual(devices.map((d) => d.label).sort(), [
    "TVs (NECx2 7,7) · AA59-00602A",
    "TVs (NECx2 7,7) · BN59-01178W",
  ]);
});

test("what cannot be told apart at all is numbered rather than left ambiguous", () => {
  const a = set({ source: "flipper", label: "TVs", type: "TVs", model: null, path: "TVs/X/a.ir" });
  const b = set({
    source: "flipper",
    label: "TVs",
    type: "TVs",
    model: null,
    path: "TVs/X/b.ir",
    keys: { ...tvKeys(), Mute: row("f-mu2", "NECx2", "NECx2 7,7") },
  });
  const { devices } = groupSets([a, b]);
  assert.deepEqual(devices.map((d) => d.label).sort(), ["TVs (NECx2 7,7) #1", "TVs (NECx2 7,7) #2"]);
});

test("ids are the codes, not the order they arrived in", () => {
  const one = groupSets([set(), set({ type: "Unknown_X", label: "X", keys: barKeys(), kind: "audio" })]);
  const two = groupSets([set({ type: "Unknown_X", label: "X", keys: barKeys(), kind: "audio" }), set()]);
  assert.deepEqual(
    one.devices.map((d) => d.id).sort(),
    two.devices.map((d) => d.id).sort(),
    "a saved plan has to still match the list a later build publishes",
  );
});

test("a row's label cannot contradict the kind the list files it under", () => {
  // A code filed under Blu-Ray by one contributor and under three audio folders by
  // others is audio - and must not then be called "Blu-Ray".
  const sets = [
    set({ source: "flipper", kind: "player", type: "Blu-Ray", label: "Blu-Ray", path: "Blu-Ray/LG/a.ir" }),
    set({ source: "flipper", kind: "audio", type: "Speakers", label: "Speakers", path: "Speakers/LG/b.ir" }),
    set({ source: "flipper", kind: "audio", type: "SoundBars", label: "Sound Bars", path: "SoundBars/LG/c.ir" }),
  ];
  const { devices } = groupSets(sets);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].kind, "audio");
  assert.equal(devices[0].label, "Speakers", "named from a set that agrees with the kind");
  assert.equal(bestLabel(sets, "player"), "Blu-Ray");
});

// ---- the extra keys ride along, outside the identity ------------------------------
// A device's `id` is a hash of its signature and a saved plan is matched by it, so the
// signature must not notice the extra keys at all - otherwise publishing input codes
// renames every device in the index and orphans every plan already on a box.
test("an extra key changes no signature and no device id", () => {
  const plain = tvKeys();
  const withInputs = { ...tvKeys(), HDMI2: row("f-h2", "NEC1", "NEC1 4"), Input: row("f-in", "NEC1", "NEC1 4") };
  assert.equal(signature(withInputs), signature(plain), "the four keys alone decide identity");

  const idOf = (keys) =>
    groupSets([{ source: "irdb", path: "p", type: "TV", label: "TV", kind: "tv", keys }]).devices[0].id;
  assert.equal(idOf(withInputs), idOf(plain));
});

test("a codeset carrying only extra keys is still dropped", () => {
  // Nothing could ever be PROGRAMMED from it, which is what the list is for; carrying it
  // would put a row in the picker that cannot fill a single button.
  const r = groupSets([
    { source: "irdb", path: "p", type: "TV", label: "TV", kind: "tv", keys: { HDMI1: row("f-h1", "NEC1", "NEC1 4") } },
  ]);
  assert.equal(r.devices.length, 0);
  assert.equal(r.skipped, 1);
});

test("an extra key is carried on the merged device, and does not relabel it", () => {
  const bare = { source: "irdb", path: "a", type: "TV", label: "TV", kind: "tv", keys: tvKeys() };
  const rich = {
    source: "Flipper-IRDB",
    path: "b",
    type: "TVs",
    label: "TVs",
    kind: "tv",
    keys: { ...tvKeys(), HDMI2: row("f-h2", "NEC1", "NEC1 4") },
  };
  const { devices } = groupSets([bare, rich]);
  assert.equal(devices.length, 1, "the extra key did not split the group");
  assert.ok(devices[0].keys.HDMI2, "and it survived onto the merged row");
  // The variant labels the row and must keep speaking for one of the four, whatever the
  // key order is: an extra key sorting first would rename every device.
  assert.equal(devices[0].variant, "NECx2 7,7");
});
