// One brand's codesets -> the devices a person picks from.
//
// A brand folder in either database is a list of REMOTE MODELS, not of devices, and
// the same codes are filed under every model number that ever carried them. Measured
// against the live databases: Samsung's 68 irdb codesets are 25 distinct codes for
// these four keys, 27 of them byte-identical (NECx2 device 7,7 - the TV); Sony's 183
// are 57. So the list a person has to read is an order of magnitude shorter than the
// folders, and it shrinks again once the keys a button needs are required.
//
// A type filter cannot do that job: 1228 of irdb's 1476 type folders are
// `Unknown_<remote model>` - 65 of Samsung's 68 sets - so grouping by type leaves 60
// groups of one. The type is kept as a LABEL and a coarse kind, never as the thing
// that makes the list short.
//
// What makes two codesets the same DEVICE is the IR they actually send, which is why
// the grouping key is the encoded FRAME (build.js has the encoders hash it) rather
// than each database's own way of writing a code down. That is also what merges the
// two sources: an irdb `NEC1 4,-1,8` row and a Flipper `NEC addr 04 cmd 08` block are
// the same waveform, and a picker offering both would be asking a person to choose
// between two identical rows.
const crypto = require("crypto");

const IR_KEYS = ["VolumeUp", "VolumeDown", "Mute", "Power"];
const KIND_ORDER = ["tv", "audio", "settop", "player", "climate", "other"];

// Which form of a code to keep when several describe the same frame. A decoded row is
// a few numbers and a capture is up to 512, and they encode to the same thing.
const ENTRY_RANK = { irdb: 0, flipper: 1, raw: 2 };
const entryKind = (row) => (row.entry.irdb ? "irdb" : row.entry.flipper ? "flipper" : "raw");

// The four keys as one comparable string, which is what decides that two codesets are
// the same device. Keys the set does not carry are absent rather than empty, so a set
// with volume only can never merge into one that also has power.
function signature(keys) {
  return IR_KEYS.filter((k) => keys[k])
    .map((k) => [k, keys[k].frame || keys[k].sig].join(":"))
    .join("|");
}

// The name to put on a merged group. A real device type ("TV", "Sound Bars",
// "Receiver") beats a model number, because it says what the thing IS; among equals
// the shortest wins, which keeps "TV" ahead of "Rear Projection DLP TV". Only labels
// from the sets that agree with the group's kind are considered, so a row cannot read
// "Blu-Ray" while the list files it under audio.
function bestLabel(sets, kind) {
  const pool = sets.filter((s) => s.kind === kind);
  return [...(pool.length ? pool : sets)].sort((a, b) => {
    const ua = /^Unknown[_ ]/.test(a.type) ? 1 : 0;
    const ub = /^Unknown[_ ]/.test(b.type) ? 1 : 0;
    return ua - ub || a.label.length - b.label.length || a.label.localeCompare(b.label);
  })[0].label;
}

// The model most of a group's codesets were filed under. Where a whole category
// shares one code - 33 of Samsung's files send `Samsung32 07,07` - the category is
// the honest name; where two groups end up with the same name anyway, this is what
// tells them apart, and a model number a person can read off their own remote beats
// a "#2" suffix.
function commonModel(sets) {
  const tally = new Map();
  for (const s of sets) if (s.model) tally.set(s.model, (tally.get(s.model) || 0) + 1);
  if (!tally.size) return "";
  return [...tally.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]),
  )[0][0];
}

// sets: [{ source, path, type, label, kind, keys }] -> the merged devices, plus how
// many carried none of the four keys (those are dropped: nothing could ever be
// programmed from them).
function groupSets(sets) {
  const groups = new Map();
  let skipped = 0;
  for (const s of sets) {
    const sig = signature(s.keys || {});
    if (!sig) {
      skipped++;
      continue;
    }
    let g = groups.get(sig);
    if (!g) groups.set(sig, (g = { sig, sets: [], keys: {} }));
    g.sets.push(s);
    // Keep the cheapest form of every key. All sets in a group send the same frames,
    // so this is a size choice, not a behaviour one.
    for (const k of IR_KEYS) {
      const row = (s.keys || {})[k];
      if (!row) continue;
      const have = g.keys[k];
      if (!have || ENTRY_RANK[entryKind(row)] < ENTRY_RANK[entryKind(have)]) g.keys[k] = row;
    }
  }

  // The kind a merged device claims is the one most of its sets agree on: a code filed
  // under both `SoundBars` and `Speakers` is audio either way, but one that also
  // appears under a TV folder should read as what it mostly is.
  const commonKind = (sets) => {
    const tally = new Map();
    for (const s of sets) tally.set(s.kind, (tally.get(s.kind) || 0) + 1);
    return [...tally.entries()].sort(
      (a, b) => b[1] - a[1] || KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]),
    )[0][0];
  };

  const devices = [...groups.values()].map((g) => {
    const keys = IR_KEYS.filter((k) => g.keys[k]);
    const first = g.keys[keys[0]];
    const sources = [...new Set(g.sets.map((s) => s.source))].sort();
    const kind = commonKind(g.sets);
    return {
      model: commonModel(g.sets),
      // Stable across regenerations (it is the frames themselves), so a device stored
      // in a saved plan still matches the list a later build publishes.
      id: crypto.createHash("sha1").update(g.sig).digest("hex").slice(0, 12),
      label: bestLabel(g.sets, kind),
      kind,
      // What tells two same-named groups apart. A brand routinely files several
      // unrelated codes under "TV", and a picker offering two identical rows is a coin
      // toss - so the address they actually transmit on travels with the row.
      variant: first.variant,
      // How many codesets across both databases carry this exact code - shown so a
      // merged row can say what it merged.
      count: g.sets.length,
      types: [...new Set(g.sets.map((s) => s.label))].slice(0, 8),
      sources,
      protocols: [...new Set(keys.map((k) => g.keys[k].protocol))],
      // The programmable part: what remote/firetv_remote_ir.py is handed per key.
      keys: Object.fromEntries(keys.map((k) => [k, { protocol: g.keys[k].protocol, entry: g.keys[k].entry }])),
    };
  });

  devices.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.count - a.count || a.label.localeCompare(b.label),
  );

  // Only the repeats pay for the disambiguation: "TV" stays "TV" when it is the only
  // one, and becomes "TV (NEC1 4)" when the brand files two different codes under that
  // name. The address can collide too - two codes on one device number differing only
  // in their function bytes - and two rows a person cannot tell apart are worse than an
  // ugly suffix, so the second pass numbers what is left.
  const tally = (list) => {
    const seen = new Map();
    for (const d of list) seen.set(d.label, (seen.get(d.label) || 0) + 1);
    return seen;
  };
  let counts = tally(devices);
  for (const d of devices) if (counts.get(d.label) > 1) d.label += " (" + d.variant + ")";
  // Still colliding: 33 of Samsung's files send one code and seven send another, and
  // both groups are "TVs (Samsung32 07,07)" because the variant only speaks for the
  // first key. A model number off the remote in someone's hand separates them.
  counts = tally(devices);
  for (const d of devices) if (counts.get(d.label) > 1 && d.model) d.label += " · " + d.model;
  counts = tally(devices);
  const nth = new Map();
  for (const d of devices) {
    if (counts.get(d.label) < 2) continue;
    const n = (nth.get(d.label) || 0) + 1;
    nth.set(d.label, n);
    d.label += " #" + n;
  }
  for (const d of devices) delete d.model; // it has done its work inside the label
  return { devices, skipped };
}

module.exports = { IR_KEYS, KIND_ORDER, signature, bestLabel, groupSets };
