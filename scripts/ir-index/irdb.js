// irdb (github.com/probonopd/irdb) as one of the two inputs of the TV-code index.
//
// A codeset is `codes/<Brand>/<Type>/<device>,<subdevice>.csv`, one DECODED row per
// button: protocol, device, subdevice, function. That is also the format's limit -
// a signal no decoder understands cannot be in it, which is why Flipper-IRDB is the
// other input (scripts/ir-index/flipper.js).
//
// Everything here is pure: a checkout on disk in, rows out. The box never parses a
// CSV any more; it reads what scripts/ir-index/build.js publishes.
const fs = require("fs");
const path = require("path");

// Function-name synonyms across irdb (uppercased, checked in order: an exact match
// wins over a contains match, entries without a "/" combo win over combos).
const KEY_SYNONYMS = {
  VolumeUp: ["VOLUME +", "VOLUME UP", "VOL+", "VOL +", "VOL UP", "VOLUME+"],
  VolumeDown: ["VOLUME -", "VOLUME DOWN", "VOL-", "VOL -", "VOL DOWN", "VOLUME-"],
  Mute: ["MUTE TOGGLE", "MUTE", "MUTING"],
  Power: ["POWER TOGGLE", "POWER", "POWER ON/OFF", "STANDBY"],
};

// irdb mixes two naming conventions: human ("VOLUME +", "VOL UP") and evdev-style
// ("KEY_VOLUMEUP"), the latter common on audio/soundbar remotes. Collapsing both to
// letters-only with the KEY_ prefix dropped makes them comparable - without this, a
// KEY_* codeset silently loses Volume up/down (MUTE and POWER happened to survive as
// substrings), which is exactly the case for a Samsung soundbar.
const canon = (s) =>
  String(s || "")
    .toUpperCase()
    .trim()
    .replace(/^KEY[_ ]/, "")
    .replace(/[^A-Z0-9+-]/g, "");

// A name that must never bind, whatever it contains. `SUBWOOFER VOL+` contains the
// synonym `VOL+` and `POWERFUL` contains `POWER`, so a contains-match binds them to the
// TV's volume or power without this. The Flipper reader guards the same names
// (scripts/ir-index/flipper.js `REJECT`); one index cannot hold two answers for one
// spelling.
const REJECT = {
  VolumeUp: /WOOFER|BASS|TREBLE|SUB|CENTER|SURROUND|MIC|ZOOM/,
  VolumeDown: /WOOFER|BASS|TREBLE|SUB|CENTER|SURROUND|MIC|ZOOM/,
  Mute: /MIC|VIDEO|SCREEN/,
  Power: /POWERFUL|SUBWOOFER|MIC/,
};

function pickRow(rows, synonyms, key) {
  let best = null;
  let bestScore = -1;
  for (const r of rows) {
    const name = canon(r.functionname);
    if (key && REJECT[key] && REJECT[key].test(name)) continue;
    const slashy = r.functionname.includes("/");
    for (let i = 0; i < synonyms.length; i++) {
      const syn = canon(synonyms[i]);
      let score = -1;
      if (name === syn) score = 100 - i;
      else if (name.includes(syn)) score = (slashy ? 20 : 50) - i;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
  }
  return best;
}

function parseCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    // functionname may itself contain commas in theory - irdb uses plain CSV with
    // exactly 4 trailing numeric-ish columns, so re-join the front.
    const tail = parts.slice(-4);
    rows.push({
      functionname: parts.slice(0, parts.length - 4).join(","),
      protocol: tail[0].trim(),
      device: parseInt(tail[1], 10),
      subdevice: parseInt(tail[2], 10),
      function: parseInt(tail[3], 10),
    });
  }
  return rows;
}

// irdb's folder name, as a person would read it: `Unknown_AH59-01527F` is a remote
// model number and says more without the prefix than with it.
const typeLabel = (t) =>
  String(t || "")
    .replace(/^Unknown[_ ]?/, "")
    .trim() || String(t || "");

// A coarse kind for the row's hint and the optional filter. Order is the contract: a
// satellite receiver is a set-top box and not an amplifier, and a CD player is audio
// and not a disc player, so the narrower words are asked first.
const KIND_PATTERNS = [
  ["climate", /air.?cond|climate|heat pump/i],
  ["settop", /cable|satellite|\bsat\b|\bdss\b|set.?top|iptv|\bstb\b|decoder/i],
  ["player", /\bdvd|blu.?ray|\bvcr\b|laser ?disc|\bvhs\b|\bdvr\b|jukebox|cassette/i],
  ["audio", /receiv|amplifi|\bamp\b|audio|sound|speaker|stereo|hi.?fi|surround|tuner|\bcd\b|karaoke|\bav\b|zone/i],
  ["tv", /(^|[^a-z])tv([^a-z]|$)|television|plasma|\blcd\b|\bled\b|monitor|projector|projection|display/i],
  ["player", /player|recorder|\bdisc\b/i],
];
function deviceKind(types) {
  for (const [kind, re] of KIND_PATTERNS) if (types.some((t) => re.test(t))) return kind;
  return "other";
}

// One row -> the normalized shape both sources share: `sig` is what makes two codes
// the same code before the frames are known, `variant` is what a picker row shows to
// tell two same-named devices apart, and `entry` is what
// remote/firetv_remote_ir.py is handed.
function normalizeRow(row) {
  const sub = Number.isFinite(row.subdevice) ? row.subdevice : -1;
  return {
    sig: ["irdb", row.protocol, row.device, sub, row.function].join(":"),
    protocol: row.protocol,
    variant: row.protocol + " " + row.device + (sub >= 0 ? "," + sub : ""),
    entry: { irdb: { protocol: row.protocol, device: row.device, subdevice: sub, function: row.function } },
  };
}

// A codeset's text -> the best row for each of the four keys.
function codesFromText(text) {
  const rows = parseCsv(text);
  const keys = {};
  for (const [key, syn] of Object.entries(KEY_SYNONYMS)) {
    const row = pickRow(rows, syn, key);
    if (row && Number.isFinite(row.device) && Number.isFinite(row.function)) keys[key] = normalizeRow(row);
  }
  return keys;
}

// Every codeset in a checkout: codes/<Brand>/<Type>/<file>.csv
function sets(root) {
  const base = path.join(root, "codes");
  const out = [];
  for (const brand of fs.readdirSync(base, { withFileTypes: true })) {
    if (!brand.isDirectory()) continue;
    for (const type of fs.readdirSync(path.join(base, brand.name), { withFileTypes: true })) {
      if (!type.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(base, brand.name, type.name))) {
        if (!f.toLowerCase().endsWith(".csv")) continue;
        out.push({
          source: "irdb",
          brand: brand.name,
          type: type.name,
          label: typeLabel(type.name),
          kind: deviceKind([type.name]),
          file: path.join(base, brand.name, type.name, f),
          path: ["codes", brand.name, type.name, f].join("/"),
          // No model here: an irdb file is named `<device>,<subdevice>.csv`, i.e. the
          // address it transmits on, which the variant already says. The remote model
          // is the TYPE folder (`Unknown_AH59-01527F`).
          model: /^Unknown[_ ]/.test(type.name) ? typeLabel(type.name) : null,
          name: f.replace(/\.csv$/i, ""),
        });
      }
    }
  }
  return out;
}

module.exports = {
  KEY_SYNONYMS,
  REJECT,
  canon,
  parseCsv,
  pickRow,
  typeLabel,
  deviceKind,
  normalizeRow,
  codesFromText,
  sets,
};
