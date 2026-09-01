// Flipper-IRDB (github.com/UberGuidoZ/Flipper-IRDB, CC0) as the other input of the
// TV-code index.
//
// One `.ir` file per remote model, holding a block per button that is either
// `type: parsed` - a protocol name plus the address and command bytes a capture
// decoded - or `type: raw`, the microsecond timings themselves. The second kind is
// the reason this source exists: irdb stores only decoded rows, so a signal no
// decoder understands cannot be in it. A Samsung soundbar is exactly that: a 4.5/4.5 ms
// leader where NEC has 9/4.5, i.e. Samsung's own 36-bit soundbar protocol, so every
// Samsung codeset in irdb is the wrong protocol for it.
//
// Two things about the layout are decided here:
//
//   * `_Converted_/` is skipped. It is 6944 of the repo's 8901 files and it is other
//     databases run through a converter - `_Converted_/CSV/…` IS irdb, which the
//     index already carries natively and with better provenance.
//   * a file is only taken when its path is `<Category>/<Brand>/…`, because brand is
//     what the picker is indexed by. Seven curated files sit directly under a
//     category with no brand folder.
//
// The category is kept as the device's type, which is a better answer than irdb can
// give: `SoundBars/Samsung/…` says what the thing is, where irdb files the same codes
// under `Unknown_AH59-02767C`.
const fs = require("fs");
const path = require("path");
const { canon, rejected } = require("./keys");

const SKIP_DIR = "_Converted_";
const MAX_BLOCKS = 600; // the deepest curated file has 256 buttons

// What one raw code may be. The keymap action stores each timing as a uint16 in
// 10-microsecond units, so 65535 is the format's own ceiling; the length cap bounds
// what a single action carries - the DB holds a few air-conditioner captures of ~995
// timings, which is a different kind of object from a button press.
const MAX_RAW_UNIT = 65535;
const MAX_RAW_TIMINGS = 512;

// ---- the four buttons, as this database spells them ---------------------------------
// Measured over the curated tree: `Vol_up`/`Vol_dn` carry 1375 of the volume blocks,
// but the same button is also `VOL+`, `Vol_down`, `Vol_dwn`, `Volume_up`, `Vol_plus`,
// `Vol_min`. Exact spellings are ranked ahead of loose ones so a file that has both
// `Mute` and `Av_mute` binds the first. The names that must never bind at all are
// shared with the irdb reader (scripts/ir-index/keys.js).
const KEY_NAMES = {
  VolumeUp: {
    exact: ["VOLUP", "VOL+", "VOLUME+", "VOLUMEUP", "VOLPLUS", "+VOLUME", "VOLUMEPLUS"],
    loose: [/^(TV|ECHO|AMP|SOUNDBAR)?VOL(UME)?(UP|\+|PLUS)$/],
  },
  VolumeDown: {
    exact: ["VOLDN", "VOLDOWN", "VOL-", "VOLUME-", "VOLUMEDOWN", "VOLDWN", "VOLMIN", "VOLMINUS", "-VOLUME"],
    loose: [/^(TV|ECHO|AMP|SOUNDBAR)?VOL(UME)?(DOWN|DN|DWN|-|MINUS|MIN)$/],
  },
  Mute: {
    exact: ["MUTE", "MUTING", "SILENCE", "VOLUMEMUTE"],
    loose: [/^(TV|AMP|SOUNDBAR)?MUTE$/, /^MUTE(TOGGLE|ONOFF)$/],
  },
  Power: {
    exact: ["POWER", "STANDBY", "ONOFF", "POWERONOFF", "POWERTOGGLE"],
    // A discrete Power_off is worth binding when a remote has no toggle at all (an
    // air conditioner rarely has one), so it stays in - below every spelling of the
    // toggle.
    loose: [/^(TV|AMP|SOUNDBAR)?POWER$/, /^POWER(ON|OFF)$/, /^(ON|OFF)$/],
  },
  // The discrete inputs are tried before the cycling one, so a file carrying both
  // `Input` and `HDMI1` binds each to itself. canon() keeps the hyphen, hence the
  // second spelling in each list.
  HDMI1: { exact: ["HDMI1", "HDMI-1"], loose: [/^(TV)?HDMI-?1$/, /^INPUTHDMI-?1$/] },
  HDMI2: { exact: ["HDMI2", "HDMI-2"], loose: [/^(TV)?HDMI-?2$/, /^INPUTHDMI-?2$/] },
  HDMI3: { exact: ["HDMI3", "HDMI-3"], loose: [/^(TV)?HDMI-?3$/, /^INPUTHDMI-?3$/] },
  HDMI4: { exact: ["HDMI4", "HDMI-4"], loose: [/^(TV)?HDMI-?4$/, /^INPUTHDMI-?4$/] },
  // A bare `HDMI` is deliberately on NO list. It is ambiguous across remotes - on some
  // it steps through the HDMI sockets, on others it selects the first - and the two
  // readings send the television to different places, so it is left unbound rather than
  // guessed. The spellings below are the ones the curated captures actually use.
  Input: {
    // `AV` is safe HERE and not in the irdb reader: this one compares a WHOLE
    // canonicalized name, while irdb matches by contains - where two letters are also
    // inside SAVE, AV1 and AVMUTE. It is in the list because a quarter of the curated
    // captures call the stepping button that.
    exact: ["INPUT", "SOURCE", "INPUTSELECT", "SOURCESELECT", "TVAV", "INPUTS", "AV"],
    loose: [/^(TV|AV)?INPUT(SELECT|TOGGLE|S)?$/, /^SOURCE(SELECT)?$/],
  },
};

// name -> [key, score] or null. Score decides which of a file's buttons wins a key.
function matchKey(name) {
  const n = canon(name);
  if (!n) return null;
  for (const [key, spec] of Object.entries(KEY_NAMES)) {
    if (rejected(key, n)) continue;
    const i = spec.exact.indexOf(n);
    if (i >= 0) return [key, 100 - i];
    for (let j = 0; j < spec.loose.length; j++) if (spec.loose[j].test(n)) return [key, 50 - j];
  }
  return null;
}

// ---- the file format ---------------------------------------------------------------
// A block is a run of `key: value` lines; `#` separates blocks, and a second `name:`
// starts one too (some files omit the separator).
function parseIr(text) {
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.name) blocks.push(cur);
    cur = null;
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith("#")) {
      flush();
      continue;
    }
    const at = s.indexOf(":");
    if (at < 0) continue;
    const k = s.slice(0, at).trim();
    const v = s.slice(at + 1).trim();
    if (k === "name") {
      flush();
      cur = { name: v };
    } else if (cur) cur[k] = v;
    if (blocks.length >= MAX_BLOCKS) break;
  }
  flush();
  return blocks;
}

// A capture holds whatever the recorder's finger sent, and 263 of the ~900 that carry
// one of our four buttons are the same frame two to twenty times over. On a volume key
// that is two steps per press, and on a power toggle it is a press that undoes itself
// - so a repeat is cut back to one frame.
//
// The test is periodicity, NOT the long gap: a Samsung 36-bit frame carries a 4.5 ms
// element in the MIDDLE of one frame, and a gap rule would send half of it. What
// follows the gap has to repeat what came before, position by position, for anything
// to be cut. Measured over the curated tree: 146 captures have no gap at all, 263
// trim, and 488 keep a gap that is part of the code (air conditioners send two-part
// frames).
const REPEAT_GAP_US = 3000;

function firstFrameLength(us) {
  for (let i = 3; i < us.length - 4; i += 2) {
    if (us[i] < REPEAT_GAP_US) continue;
    const period = i + 1; // the frame plus the gap that follows it
    if (period * 2 > us.length + 4) return 0; // nothing like a second copy follows
    for (let j = period; j < us.length; j++) {
      const k = j % period;
      if (k === period - 1) continue; // the gap between copies varies with the finger
      if (Math.abs(us[j] - us[k]) > Math.max(80, us[k] * 0.3)) return 0;
    }
    return i;
  }
  return 0;
}

// Microseconds -> the keymap's 10-microsecond unit, rounding the way python's round()
// does (half to even), because remote/ir_protocols.py converts the encoded protocols
// with it: one rule for the unit across both languages, so a capture and a synthesized
// frame of the same signal cannot differ by a unit here and not there. 505 us is the
// case that shows it: JavaScript's Math.round says 51, python says 50.
function round10(us) {
  const q = us / 10;
  const down = Math.floor(q);
  const rest = q - down;
  if (rest > 0.5) return down + 1;
  if (rest < 0.5) return down;
  return down % 2 === 0 ? down : down + 1;
}

// A capture's microseconds -> the keymap's 10-microsecond units. Returns null for a
// block the remote cannot be given: an empty capture, a timing wider than the field it
// goes in, or more timings than one action carries.
function rawUnits(data) {
  const parts = String(data || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length || parts.length > MAX_RAW_TIMINGS * 20) return null;
  const us = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    us.push(Number(p));
  }
  const frame = firstFrameLength(us);
  const kept = frame ? us.slice(0, frame) : us;
  if (kept.length > MAX_RAW_TIMINGS) return null;
  const out = [];
  for (const v of kept) {
    const u = Math.max(1, round10(v));
    if (u > MAX_RAW_UNIT) return null;
    out.push(u);
  }
  // A capture that ends on a space ends on silence; the frame is what gets sent, and
  // every encoder here ends one on a mark.
  if (out.length % 2 === 0) out.pop();
  return out.length >= 6 ? out : null;
}

const HEX_FIELD = /^[0-9A-Fa-f]{2}( [0-9A-Fa-f]{2})*$/;

// One block -> the normalized shape both sources share (see irdb.js `normalizeRow`).
function blockRow(b) {
  if (b.type === "raw") {
    const units = rawUnits(b.data);
    const freq = Math.round(Number(b.frequency));
    if (!units || !Number.isFinite(freq) || freq < 20000 || freq > 60000) return null;
    return {
      sig: "raw:" + freq + ":" + units.join(","),
      protocol: "raw",
      variant: "raw " + Math.round(freq / 1000) + " kHz",
      entry: { raw: units, frequency: freq },
    };
  }
  if (b.type === "parsed") {
    const protocol = String(b.protocol || "").trim();
    if (!protocol || protocol.length > 24 || !/^[A-Za-z0-9_-]+$/.test(protocol)) return null;
    if (!HEX_FIELD.test(String(b.address || "")) || !HEX_FIELD.test(String(b.command || ""))) return null;
    const address = b.address.toUpperCase();
    const command = b.command.toUpperCase();
    const short = (s) => s.replace(/ /g, "").replace(/(00)+$/, "") || "0";
    return {
      sig: "flipper:" + protocol + ":" + address.replace(/ /g, "") + ":" + command.replace(/ /g, ""),
      protocol,
      variant: protocol + " " + short(address) + "," + short(command),
      entry: { flipper: { protocol, address, command } },
    };
  }
  return null;
}

// A file -> the best block for each of the four keys.
function codesFromText(text) {
  const keys = {};
  const scores = {};
  for (const b of parseIr(text)) {
    const hit = matchKey(b.name);
    if (!hit) continue;
    const [key, score] = hit;
    if (keys[key] && scores[key] >= score) continue;
    const row = blockRow(b);
    if (!row) continue;
    keys[key] = row;
    scores[key] = score;
  }
  return keys;
}

// ---- the tree ----------------------------------------------------------------------
// Category -> the coarse kind the picker sorts and filters by. Explicit rather than
// matched by word, because these 47 names are a closed set and the words mislead:
// `TVs` is not the word "tv", and `Car_Multimedia` is audio rather than a player.
const KIND_BY_CATEGORY = {
  TVs: "tv",
  Monitors: "tv",
  Projectors: "tv",
  Touchscreen_Displays: "tv",
  Digital_Signs: "tv",
  Whiteboards: "tv",
  Picture_Frames: "tv",
  Videoconferencing: "tv",
  Audio_and_Video_Receivers: "audio",
  SoundBars: "audio",
  Speakers: "audio",
  CD_Players: "audio",
  MiniDisc: "audio",
  Head_Units: "audio",
  Car_Multimedia: "audio",
  Multimedia: "audio",
  Cable_Boxes: "settop",
  "DVB-T": "settop",
  Streaming_Devices: "settop",
  TV_Tuner: "settop",
  Converters: "settop",
  "Blu-Ray": "player",
  DVD_Players: "player",
  VCR: "player",
  Laserdisc: "player",
  Consoles: "player",
  ACs: "climate",
  Heaters: "climate",
  Fans: "climate",
  Air_Purifiers: "climate",
  Humidifiers: "climate",
  Fireplaces: "climate",
};
const kindOf = (category) => KIND_BY_CATEGORY[category] || "other";

// `SoundBars` -> `Sound Bars`, `Audio_and_Video_Receivers` -> `Audio and Video
// Receivers`: the folder name as a person would read it on a row.
const categoryLabel = (c) =>
  String(c || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();

// `Samsung_AH59-02767C.ir` -> `AH59-02767C`: the model number, without the brand it is
// already filed under.
function setName(file, brand) {
  let n = file.replace(/\.ir$/i, "").replace(/_/g, " ");
  const b = String(brand).replace(/_/g, " ");
  if (n.toLowerCase().startsWith(b.toLowerCase() + " ")) n = n.slice(b.length + 1);
  return n.trim() || file;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === SKIP_DIR) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith(".ir")) out.push(p);
  }
  return out;
}

// Every usable file in a checkout, with the brand and category its path files it under.
function sets(root) {
  const out = [];
  for (const file of walk(root).sort()) {
    const rel = path.relative(root, file).split(path.sep);
    if (rel.length < 3) continue; // no brand folder: nothing to file it under
    const [category, brand] = rel;
    out.push({
      source: "flipper",
      brand: brand.replace(/_/g, " "),
      type: category,
      label: categoryLabel(category),
      kind: kindOf(category),
      file,
      path: rel.join("/"),
      // The file IS a remote model here ("Samsung_AH59-02767C.ir"), which is the one
      // thing that tells two of a brand's codes apart when the category cannot.
      model: setName(rel[rel.length - 1], brand),
      name: setName(rel[rel.length - 1], brand),
    });
  }
  return out;
}

module.exports = {
  round10,
  canon,
  matchKey,
  parseIr,
  firstFrameLength,
  rawUnits,
  blockRow,
  codesFromText,
  kindOf,
  categoryLabel,
  setName,
  walk,
  sets,
};
