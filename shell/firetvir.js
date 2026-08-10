// Fire TV remote IR programming from the Settings UI (docs/firetv-remote-ir.md).
// Three concerns, all root-free and OTA-safe:
//
//   deps   - bleak lives in a user-space venv (~/.tvbox/pyenv), created and
//            version-pinned from the UI; needs python3-venv (provision installs
//            it, OTA-only boxes degrade with a clear message).
//   codes  - TV IR codesets come from the community irdb database
//            (https://github.com/probonopd/irdb, CC-SA-style courtesy: shown
//            with attribution in the UI + the About screen). The brand index is
//            the GitHub tree API (cached ~30 days, unauthenticated rate limits
//            are fine at that cadence); codesets are raw.githubusercontent.com
//            fetches, https-only, path-validated, size-capped.
//   BLE    - blast/program/erase shell out to ~/.tvbox/firetv_remote_ir.py
//            with the venv's python (the remote's GATT keymap service does the
//            rest; see remote/keymap_compile.py).
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const edid = require("./edid");

const TVBOX = path.join(os.homedir(), ".tvbox");
const PYENV = path.join(TVBOX, "pyenv");
const PY = path.join(PYENV, "bin", "python3");
const TOOL = path.join(TVBOX, "firetv_remote_ir.py");
const CODES_FILE = path.join(TVBOX, "firetv_tv_codes.json");
const TEST_CODES_FILE = path.join(TVBOX, "firetv_tv_codes.test.json"); // a blast, which stores nothing
const CACHE_DIR = path.join(TVBOX, "cache");
const INDEX_CACHE = path.join(CACHE_DIR, "irdb-index-v2.json"); // v2: all device types, not just TV
const INDEX_TTL_MS = 30 * 24 * 3600 * 1000;
// The user's "latest deps" stance, but pinned so an install is reproducible;
// dbus-fast ships aarch64 manylinux wheels, so no compiler is needed on the box.
const PIP_PACKAGES = ["bleak==3.0.2", "dbus-fast==5.0.22"];
const INDEX_URL = "https://api.github.com/repos/probonopd/irdb/git/trees/master?recursive=1";
const RAW_BASE = "https://raw.githubusercontent.com/probonopd/irdb/master/";
const MAX_INDEX_BYTES = 30e6;
const MAX_CSV_BYTES = 512e3;

// TV make -> irdb brand folder. The box learns the make from the HDMI EDID or the
// CEC vendor id; we map the common ones so the UI can pre-select a brand.
// Non-exhaustive on purpose - an unknown TV just means no suggestion, and the user
// picks manually.
// EDID manufacturer id -> brand. These are PNP ids, registered long before the
// brands were what they are now, so none of them can be guessed from the name:
// LG's is Goldstar's, Philips' is its own three letters, and Panasonic files as
// Matsushita.
const PNP_BRAND = {
  GSM: "LG",
  LGE: "LG",
  SAM: "Samsung",
  SNY: "Sony",
  PHL: "Philips",
  MEI: "Panasonic",
  TSB: "Toshiba",
  HIS: "Hisense",
  TCL: "TCL",
  SHP: "Sharp",
  VIZ: "Vizio",
  GRU: "Grundig",
  LOE: "Loewe",
  JVC: "JVC",
};
const CEC_VENDOR_BRAND = {
  "00e091": "LG",
  "00e0a6": "Sony", // some Sony sets
  "080046": "Sony",
  "0000f0": "Samsung",
  "0005cd": "Panasonic", // some Panasonic
  "008045": "Panasonic",
  "00903e": "Philips",
  "0010fa": "Toshiba",
};
function makeToBrand(make) {
  const s = (make || "").toLowerCase();
  const table = [
    ["lg", "LG"],
    ["samsung", "Samsung"],
    ["sony", "Sony"],
    ["panasonic", "Panasonic"],
    ["philips", "Philips"],
    ["vizio", "Vizio"],
    ["hisense", "Hisense"],
    ["tcl", "TCL"],
    ["sharp", "Sharp"],
    ["toshiba", "Toshiba"],
    ["grundig", "Grundig"],
    ["loewe", "Loewe"],
    ["jvc", "JVC"],
  ];
  for (const [needle, brand] of table) if (s.includes(needle)) return brand;
  return null;
}
// The connected TV's brand, from the EDID first (most reliable), else the CEC
// vendor id the CEC bridge stored. Best-effort + fast; null -> no suggestion.
//
// The EDID is read from sysfs rather than asked of the compositor: it is there
// before the session starts, so this answers the same on a box whose session is
// down.
function suggestedBrand(cb) {
  const block = edid.read();
  // The set's own name first ("LG TV"), then the registered id: a name is what a
  // human would recognise, an id is what a set that names itself "TV" still has.
  const fromEdid = makeToBrand(edid.name(block)) || PNP_BRAND[edid.manufacturer(block) || ""];
  if (fromEdid) return cb(fromEdid);
  let vendor = "";
  try {
    vendor = fs.readFileSync(path.join(TVBOX, "cec_tv_vendor"), "utf8").trim().toLowerCase();
  } catch (e) {}
  cb(CEC_VENDOR_BRAND[vendor] || null);
}

// The keymap GATT service a programmable Amazon remote exposes. Its presence on
// a bonded device is a precise "this is a Fire TV / Alexa remote we can program"
// signal (no false positives) - used to show the IR feature ONLY under such a
// remote in the remap UI, never for other remotes.
const KEYMAP_SERVICE = "fe151500";

// MACs (lowercase) of currently-connected remotes that expose the keymap
// service. Cached briefly - bluetoothctl is cheap but this is polled from the UI.
let progCache = { ts: 0, macs: [] };
function programmableRemotes(cb) {
  if (Date.now() - progCache.ts < 8000) return cb(progCache.macs);
  execFile("bluetoothctl", ["devices", "Connected"], { timeout: 5000 }, (err, out) => {
    // Fall back to all known devices if "Connected" filter isn't supported.
    const list = (m) =>
      (m || "")
        .split("\n")
        .map((l) => /Device ([0-9A-F:]{17})/i.exec(l))
        .filter(Boolean)
        .map((x) => x[1]);
    const run = (macs) => {
      const found = [];
      let pending = macs.length;
      if (!pending) {
        progCache = { ts: Date.now(), macs: found };
        return cb(found);
      }
      macs.forEach((mac) =>
        execFile("bluetoothctl", ["info", mac], { timeout: 5000 }, (e2, info) => {
          if (!e2 && /Connected: yes/i.test(info) && new RegExp(KEYMAP_SERVICE, "i").test(info)) {
            found.push(mac.toLowerCase());
          }
          if (--pending === 0) {
            progCache = { ts: Date.now(), macs: found };
            cb(found);
          }
        }),
      );
    };
    if (!err && list(out).length) return run(list(out));
    execFile("bluetoothctl", ["devices"], { timeout: 5000 }, (e2, all) => run(list(all)));
  });
}

// ---- deps (venv + bleak) --------------------------------------------------------
let depsState = { running: false, step: "", error: "" };
let depsOkCached = null; // null = unknown, needs a probe

function probeDeps(cb) {
  if (depsOkCached !== null) return cb(depsOkCached);
  if (!fs.existsSync(PY)) {
    depsOkCached = false;
    return cb(false);
  }
  execFile(PY, ["-c", "import bleak"], { timeout: 10000 }, (err) => {
    depsOkCached = !err;
    cb(!err);
  });
}

function installDeps() {
  if (depsState.running) return false;
  depsState = { running: true, step: "venv", error: "" };
  const fail = (msg) => {
    console.warn("[firetvir] deps install failed:", msg);
    depsState = { running: false, step: "", error: String(msg).slice(0, 300) };
  };
  const pipInstall = () => {
    depsState.step = "pip";
    execFile(
      PY,
      ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", ...PIP_PACKAGES],
      { timeout: 300000 },
      (err, _out, stderr) => {
        if (err) return fail(stderr || err.message);
        depsOkCached = null; // re-probe on next status
        depsState = { running: false, step: "", error: "" };
        console.log("[firetvir] bleak installed into", PYENV);
      },
    );
  };
  if (fs.existsSync(PY)) return (pipInstall(), true);
  execFile("python3", ["-m", "venv", PYENV], { timeout: 120000 }, (err, _out, stderr) => {
    if (err) return fail("python3 -m venv failed (python3-venv missing?): " + (stderr || err.message));
    pipInstall();
  });
  return true;
}

// Where a redirect may lead. irdb is the only thing this module fetches, and a
// Location header is the one part of the answer the server chooses freely - so it
// stays inside GitHub rather than being followed anywhere.
const ALLOWED_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"]);

// ---- tiny https GET with one redirect + size cap ---------------------------------
// The callback fires EXACTLY once. Destroying the request on the size cap raises an
// `error` right after, and a caller that keeps a counter in this callback (the brand
// downloader's concurrency) would then double-count it and either finish early or
// never finish at all.
function httpsGet(url, maxBytes, cb, redirected) {
  let done = false;
  const once = (err, body) => {
    if (done) return;
    done = true;
    cb(err, body);
  };
  const req = https.get(url, { headers: { "User-Agent": "tvbox", Accept: "*/*" }, timeout: 30000 }, (res) => {
    if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && !redirected) {
      res.resume();
      let next;
      try {
        next = new URL(res.headers.location, url);
      } catch (e) {
        return once(new Error("bad redirect"));
      }
      if (next.protocol !== "https:" || !ALLOWED_HOSTS.has(next.hostname)) {
        return once(new Error("redirect outside github: " + next.hostname));
      }
      done = true; // the retry owns the callback from here
      return httpsGet(next.href, maxBytes, cb, true);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return once(new Error("HTTP " + res.statusCode + (res.statusCode === 403 ? " (rate limited? retry later)" : "")));
    }
    const chunks = [];
    let size = 0;
    res.on("data", (d) => {
      size += d.length;
      if (size > maxBytes) {
        req.destroy();
        return once(new Error("response too large"));
      }
      chunks.push(d);
    });
    res.on("end", () => once(null, Buffer.concat(chunks).toString("utf8")));
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => once(e));
}

// ---- irdb brand index -------------------------------------------------------------
// The file is ~1.7 MB of JSON and every brand lookup needs it, so it is parsed once
// per process rather than per request: a readFileSync + JSON.parse of that size runs
// on the same event loop that serves the TV's UI.
let indexMemo = null;
function loadIndexCache() {
  if (indexMemo && Date.now() - indexMemo.ts < INDEX_TTL_MS) return indexMemo;
  try {
    const c = JSON.parse(fs.readFileSync(INDEX_CACHE, "utf8"));
    if (Date.now() - c.ts < INDEX_TTL_MS && Array.isArray(c.brands)) return (indexMemo = c);
  } catch (e) {}
  return null;
}

function fetchBrands(cb) {
  const cached = loadIndexCache();
  if (cached) return cb(null, cached.brands);
  httpsGet(INDEX_URL, MAX_INDEX_BYTES, (err, body) => {
    if (err) return cb(err);
    let tree;
    try {
      tree = JSON.parse(body).tree || [];
    } catch (e) {
      return cb(new Error("bad index json"));
    }
    // Every device type, not just TV: a button may drive something else entirely
    // (a soundbar on volume). irdb has no tidy "Soundbar" folder - Samsung's audio
    // codes sit under Unknown_AH59-* remote model numbers - so the type is carried
    // through and shown rather than filtered to a guessed whitelist. What makes
    // that list usable is brandDevices() below, not a type filter.
    const brands = new Map();
    for (const ent of tree) {
      const m = /^codes\/([^/]+)\/([^/]+)\/([^/]+\.csv)$/.exec(ent.path || "");
      if (!m) continue;
      if (!brands.has(m[1])) brands.set(m[1], []);
      brands.get(m[1]).push({ name: m[3].replace(/\.csv$/, ""), path: ent.path, type: m[2] });
    }
    const out = [...brands.entries()]
      .map(([brand, sets]) => ({
        brand,
        sets: sets.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.brand.localeCompare(b.brand));
    indexMemo = { ts: Date.now(), brands: out };
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(INDEX_CACHE, JSON.stringify(indexMemo));
    } catch (e) {}
    cb(null, out);
  });
}

// ---- codeset fetch + key normalization ---------------------------------------------
// Function-name synonyms across irdb (uppercased, checked in order: an exact
// match wins over a contains match, entries without a "/" combo win over combos).
const KEY_SYNONYMS = {
  VolumeUp: ["VOLUME +", "VOLUME UP", "VOL+", "VOL +", "VOL UP", "VOLUME+"],
  VolumeDown: ["VOLUME -", "VOLUME DOWN", "VOL-", "VOL -", "VOL DOWN", "VOLUME-"],
  Mute: ["MUTE TOGGLE", "MUTE", "MUTING"],
  Power: ["POWER TOGGLE", "POWER", "POWER ON/OFF", "STANDBY"],
};

// irdb mixes two naming conventions: human ("VOLUME +", "VOL UP") and evdev-style
// ("KEY_VOLUMEUP"), the latter common on audio/soundbar remotes. Collapsing both
// to letters-only with the KEY_ prefix dropped makes them comparable - without
// this, a KEY_* codeset silently loses Volume up/down (MUTE and POWER happened to
// survive as substrings), which is exactly the case for a Samsung soundbar.
const canon = (s) =>
  s
    .toUpperCase()
    .trim()
    .replace(/^KEY[_ ]/, "")
    .replace(/[^A-Z0-9+-]/g, "");

function pickRow(rows, synonyms) {
  let best = null;
  let bestScore = -1;
  for (const r of rows) {
    const name = canon(r.functionname);
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
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    // functionname may itself contain commas in theory - irdb uses plain CSV
    // with exactly 4 trailing numeric-ish columns, so re-join the front.
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

function validCodesetPath(p) {
  return typeof p === "string" && /^codes\/[^\0]+\.csv$/.test(p) && !p.includes("..");
}

function fetchCodeset(relPath, cb) {
  // Deferred, not immediate: the brand downloader keeps its concurrency count in
  // this callback, and a synchronous call would re-enter its pump loop from inside
  // its own iteration.
  if (!validCodesetPath(relPath)) return process.nextTick(() => cb(new Error("invalid codeset path")));
  const url = RAW_BASE + relPath.split("/").map(encodeURIComponent).join("/");
  httpsGet(url, MAX_CSV_BYTES, (err, body) => {
    if (err) return cb(err);
    const rows = parseCsv(body);
    const keys = {};
    const protocols = new Set();
    for (const [key, syn] of Object.entries(KEY_SYNONYMS)) {
      const row = pickRow(rows, syn);
      if (row && Number.isFinite(row.device) && Number.isFinite(row.function)) {
        keys[key] = row;
        protocols.add(row.protocol);
      }
    }
    cb(null, { path: relPath, keys, protocols: [...protocols] });
  });
}

// Build the python tool's config spec from a normalized codeset. Which
// protocols are actually encodable is the python side's call (ir_protocols.py);
// we ask it instead of duplicating the registry here.
function checkProtocols(protocols, cb) {
  const py = fs.existsSync(PY) ? PY : "python3";
  execFile(
    py,
    [
      "-c",
      "import sys,json; sys.path.insert(0,sys.argv[1]); import ir_protocols as p; print(json.dumps({x: p.supported(x) for x in json.loads(sys.argv[2])}))",
      TVBOX,
      JSON.stringify(protocols),
    ],
    { timeout: 10000 },
    (err, out) => {
      if (err) return cb(err);
      try {
        cb(null, JSON.parse(out));
      } catch (e) {
        cb(e);
      }
    },
  );
}

const IR_KEYS = ["VolumeUp", "VolumeDown", "Mute", "Power"];
const irdbRow = (row) => ({
  protocol: row.protocol,
  device: row.device,
  subdevice: row.subdevice,
  function: row.function,
});

// ---- one brand's DEVICES: its codesets, merged by the IR they actually send ------
//
// A brand folder is a list of REMOTE MODELS, not of devices, and the same codes are
// filed under every model number that ever carried them. Measured against the live
// index: Samsung's 68 codesets are 25 distinct codes for these four keys, 27 of them
// byte-identical (NECx2 device 7,7 - the TV); Sony's 183 are 57, LG's 36 are 16. So
// the list a person has to read is an order of magnitude shorter than the folder,
// and it shrinks again once the keys a button needs are required: 68 -> 13 for
// Samsung on volume, where the soundbar (NECx2 67,83) is then the only entry with
// volume and no power.
//
// This is what a type filter alone cannot do. 1228 of irdb's 1476 type folders are
// `Unknown_<remote model>` - 65 of Samsung's 68 sets - so grouping by type leaves
// 60 groups of one. The type is kept as a LABEL and a coarse kind, never as the
// thing that makes the list short.
const BRAND_TTL_MS = 30 * 24 * 3600 * 1000;
// A run that lost some of its codesets is kept only long enough to stop the UI's
// poll from restarting it; a month of a silently short list is the thing to avoid.
const BRAND_PARTIAL_TTL_MS = 10 * 60 * 1000;
const BRAND_CONCURRENCY = 6; // small: 183 sets is the worst brand, and this shares the box's link
// A brand whose downloads all fail must not be cached as "this brand has nothing".
// Stop early instead - offline, every request fails the same way.
const BRAND_GIVE_UP_AFTER = 8;
const MAX_BRAND_SETS = 400;
const MAX_BRAND_JOBS = 2;
const JOB_KEEP_ERROR_MS = 60000; // long enough for the screen that asked to see the error

// The four keys as one comparable string, which is what decides that two codesets
// are the same device. Keys the set does not carry are absent rather than empty, so
// a set with volume only can never merge into one that also has power.
function signature(keys) {
  return IR_KEYS.filter((k) => keys[k])
    .map((k) => [k, keys[k].protocol, keys[k].device, keys[k].subdevice, keys[k].function].join(":"))
    .join("|");
}

// irdb's folder name, as a person would read it: `Unknown_AH59-01527F` is a remote
// model number and says more without the prefix than with it.
const typeLabel = (t) => String(t || "").replace(/^Unknown[_ ]?/, "") || String(t || "");

// The name to put on a merged group. A real device type ("TV", "Sound Bar",
// "Receiver") beats a model number, because it says what the thing IS; among equals
// the shortest wins, which keeps "TV" ahead of "Rear Projection DLP TV".
function bestType(types) {
  return [...types].sort((a, b) => {
    const ua = /^Unknown[_ ]/.test(a) ? 1 : 0;
    const ub = /^Unknown[_ ]/.test(b) ? 1 : 0;
    return ua - ub || a.length - b.length || a.localeCompare(b);
  })[0];
}

// A coarse kind for the row's hint and the optional filter. Order is the contract:
// a satellite receiver is a set-top box and not an amplifier, and a CD player is
// audio and not a disc player, so the narrower words are asked first. Nothing is
// hidden by this - it defaults to showing everything, and the folder names are on
// the row anyway.
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
const KIND_ORDER = ["tv", "audio", "settop", "player", "climate", "other"];

// sets: [{ path, type, keys }] -> the merged devices, plus how many carried none of
// the four keys (those are dropped: nothing here could ever be programmed from them).
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
    if (!g) groups.set(sig, (g = { sig, types: [], paths: [], keys: s.keys }));
    g.types.push(s.type);
    g.paths.push(s.path);
  }
  const devices = [...groups.values()].map((g) => {
    const top = bestType(g.types);
    const at = g.types.indexOf(top);
    const keys = IR_KEYS.filter((k) => g.keys[k]);
    const first = g.keys[keys[0]];
    return {
      // What tells two same-named groups apart. A brand routinely files several
      // unrelated codes under "TV", and a picker offering two identical rows is a
      // coin toss - so the address they actually transmit on travels with the row.
      variant: first.protocol + " " + first.device + (first.subdevice >= 0 ? "," + first.subdevice : ""),
      // Stable across refetches (it is the codes themselves), so a device stored in
      // a saved plan still matches the list after a cache expiry.
      id: crypto.createHash("sha1").update(g.sig).digest("hex").slice(0, 12),
      // The set the group is programmed FROM - the one whose folder gave the label,
      // so what gets written matches what the row says.
      path: g.paths[at],
      label: typeLabel(top),
      kind: deviceKind(g.types),
      count: g.paths.length,
      types: [...new Set(g.types.map(typeLabel))].slice(0, 8),
      keys,
      protocols: [...new Set(keys.map((k) => g.keys[k].protocol))],
    };
  });
  devices.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.count - a.count || a.label.localeCompare(b.label),
  );
  // Only the repeats pay for the disambiguation: "TV" stays "TV" when it is the
  // only one, and becomes "TV (NEC1 4)" when the brand files two different codes
  // under that name. The address can collide too - two codes on one device number
  // differing only in their function bytes - and two rows a person cannot tell
  // apart are worse than an ugly suffix, so the second pass numbers what is left.
  const label = (list) => {
    const seen = new Map();
    for (const d of list) seen.set(d.label, (seen.get(d.label) || 0) + 1);
    return seen;
  };
  let counts = label(devices);
  for (const d of devices) if (counts.get(d.label) > 1) d.label += " (" + d.variant + ")";
  counts = label(devices);
  const nth = new Map();
  for (const d of devices) {
    if (counts.get(d.label) < 2) continue;
    const n = (nth.get(d.label) || 0) + 1;
    nth.set(d.label, n);
    d.label += " #" + n;
  }
  return { devices, skipped };
}

const brandSlug = (b) => b.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
// The version is part of the NAME, so a change to what a merged device looks like
// (a label rule, a new field) takes effect at once instead of waiting out a 30-day
// cache on every box that already has one.
const BRAND_CACHE_VERSION = "v2";
const brandCacheFile = (b) =>
  path.join(
    CACHE_DIR,
    "irdb-brand-" +
      BRAND_CACHE_VERSION +
      "-" +
      brandSlug(b) +
      "-" +
      crypto.createHash("sha1").update(b).digest("hex").slice(0, 8) +
      ".json",
  );

// A brand's answer, in memory as well as on disk. The memo is not an optimisation:
// a box whose ~/.tvbox is full or read-only would otherwise never have a cache to
// find, and the UI's 700 ms poll would start the whole download again on every tick,
// for ever. It is also what makes an EMPTY answer stick - a brand really can hold no
// code with any of these four keys, and "no devices" has to be cacheable or it reads
// as "not fetched yet".
const brandMemo = new Map(); // brand -> { ts, devices, skipped, failed, partial }

function rememberBrand(brand, payload) {
  brandMemo.set(brand, payload);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(brandCacheFile(brand), JSON.stringify(payload));
  } catch (e) {}
}

function loadBrandCache(brand) {
  const fresh = (c) =>
    c && Array.isArray(c.devices) && Date.now() - c.ts < (c.partial ? BRAND_PARTIAL_TTL_MS : BRAND_TTL_MS);
  const memo = brandMemo.get(brand);
  if (fresh(memo)) return memo;
  try {
    const c = JSON.parse(fs.readFileSync(brandCacheFile(brand), "utf8"));
    if (fresh(c)) {
      brandMemo.set(brand, c);
      return c;
    }
  } catch (e) {}
  return null;
}

const brandJobs = new Map(); // brand -> { done, total, error } while its codesets download

function startBrandJob(brand) {
  const job = { done: 0, total: 0, error: "" };
  brandJobs.set(brand, job);
  const fail = (msg) => {
    job.error = String(msg).slice(0, 200);
    // A failed job is reported to whoever polls next and then has to go, whether or
    // not anyone polls: a screen the user left would otherwise leave its entry in the
    // map for the life of the process, and the map is what bounds concurrency.
    setTimeout(() => {
      if (brandJobs.get(brand) === job) brandJobs.delete(brand);
    }, JOB_KEEP_ERROR_MS).unref?.();
  };
  fetchBrands((err, brands) => {
    if (err) return fail(err.message || err);
    const found = (brands || []).find((b) => b.brand === brand);
    if (!found) return fail("unknown brand");
    const sets = found.sets.slice(0, MAX_BRAND_SETS);
    job.total = sets.length;
    if (!sets.length) return fail("no codesets");
    const results = [];
    let next = 0;
    let failed = 0;
    let live = 0;
    const pump = () => {
      while (live < BRAND_CONCURRENCY && next < sets.length && !job.error) {
        const set = sets[next++];
        live++;
        fetchCodeset(set.path, (e, cs) => {
          live--;
          job.done++;
          if (e) {
            failed++;
            // Every download failing is a box with no route to GitHub, not a brand
            // with no codes - and caching the empty answer would outlive the outage.
            if (failed >= BRAND_GIVE_UP_AFTER && !results.length) fail("download failed: " + (e.message || e));
          } else results.push({ path: set.path, type: set.type, keys: cs.keys });
          if (live === 0 && (next >= sets.length || job.error)) finish();
          else pump();
        });
      }
    };
    const finish = () => {
      if (job.error) return;
      if (!results.length) return fail("download failed");
      const { devices, skipped } = groupSets(results);
      const protocols = [...new Set(devices.flatMap((d) => d.protocols))];
      checkProtocols(protocols, (perr, supported) => {
        // A protocol check that could not run must not read as "unsupported": the
        // row would be greyed out for a code that works. Unknown means offered.
        for (const d of devices) d.supported = perr ? null : supported;
        // A run that lost codesets to the network is a SHORT list, and a short list
        // is indistinguishable from a brand that simply has little - so it is cached
        // for minutes rather than a month, and the count travels with it so the
        // screen can say a retry is worth it.
        rememberBrand(brand, { ts: Date.now(), devices, skipped, failed, partial: failed > 0 });
        brandJobs.delete(brand);
      });
    };
    pump();
  });
}

// The UI polls this: `loading` with a count while the codesets come down, then `ok`
// with the merged list. Cached brands answer without touching the network.
function brandDevices(brand, cb) {
  const name = String(brand || "").trim();
  if (!name || name.length > 80 || /[/\\]/.test(name)) return cb(new Error("invalid brand"));
  const cached = loadBrandCache(name);
  if (cached) {
    return cb(null, {
      state: "ok",
      devices: cached.devices,
      skipped: cached.skipped || 0,
      failed: cached.failed || 0,
    });
  }
  const job = brandJobs.get(name);
  if (!job) {
    // One brand at a time, plus a little slack. Each job is up to 400 outbound
    // fetches and a python subprocess at the end, and a user stepping through the
    // letter index leaves the previous screen's job running behind them.
    if (brandJobs.size >= MAX_BRAND_JOBS) return cb(new Error("busy: another brand is still downloading"));
    startBrandJob(name);
    return cb(null, { state: "loading", done: 0, total: 0, devices: [] });
  }
  if (job.error) {
    brandJobs.delete(name);
    return cb(new Error(job.error));
  }
  return cb(null, { state: "loading", done: job.done, total: job.total, devices: [] });
}

// ---- the saved plan: which devices this remote drives, and from which button -------
// The programmed keymap lives on the REMOTE and cannot be read back, so without this
// a second visit would show a blank screen for a remote that is fully set up. Kept
// per MAC, next to the box's other settings, and carried by a backup.
const PLAN_FILE = path.join(TVBOX, "firetv_ir_plan.json");
const MAX_PLAN_BYTES = 256e3;
const MAX_PLAN_DEVICES = 8;
// irdb's longest real path is well under this; it only has to stop a caller from
// storing a novel in the field that becomes a URL.
const MAX_PATH_CHARS = 300;
const KINDS = new Set([...KIND_ORDER]);
const str = (v, max) => String(v == null ? "" : v).slice(0, max);

// Everything here arrives from the launcher and ends up naming an outbound fetch, so
// it is re-checked rather than trusted: a device id that no device carries, or a
// path outside irdb's codes/, would otherwise be stored and re-sent on every program.
//
// EVERY field is bounded, not just the number of devices. The count is what the
// caller controls least: a `keys` array repeated a hundred thousand times passes the
// membership filter, and a file this module can no longer read (readPlans) reports
// EVERY remote as unconfigured - for a setting whose whole reason to exist is that
// the remote cannot be read back.
function sanitizePlan(raw) {
  const devices = [];
  for (const d of Array.isArray(raw && raw.devices) ? raw.devices.slice(0, MAX_PLAN_DEVICES) : []) {
    const p = str(d && d.path, MAX_PATH_CHARS);
    if (!d || !/^[a-f0-9]{6,32}$/.test(String(d.id || "")) || !validCodesetPath(p)) continue;
    devices.push({
      id: String(d.id),
      brand: str(d.brand, 60),
      label: str(d.label, 60),
      kind: KINDS.has(d.kind) ? d.kind : "other",
      path: p,
      // Deduped, not just filtered: the set of buttons a device drives is at most
      // four, whatever the caller sent.
      keys: Array.isArray(d.keys) ? IR_KEYS.filter((k) => d.keys.includes(k)) : [],
      protocol: str(d.protocol, 24),
      // How many irdb folders carry this same code - shown on the device screen so
      // a merged row can say what it merged.
      count: Number.isFinite(d.count) ? Math.min(9999, Math.max(1, Math.round(d.count))) : 1,
    });
  }
  // A button may only name a device whose codeset actually carries it. Without this
  // the screen can read "Power - Samsung Sound Bar", the save reports success, and
  // the button does nothing: resolvePlan skips a key it has no row for, silently.
  // The box is the authority on that, not the screen that assembled the plan.
  const canSend = (id, key) => devices.some((d) => d.id === id && d.keys.includes(key));
  const assign = {};
  for (const key of IR_KEYS) {
    const a = (raw && raw.assign && raw.assign[key]) || null;
    if (!a || !canSend(a.device, key)) continue;
    assign[key] = {
      device: String(a.device),
      second: canSend(a.second, key) && a.second !== a.device ? String(a.second) : null,
    };
  }
  // Carried, not stamped: this says when the setup was saved, and a read is not a
  // save. writePlan is what sets it.
  return { devices, assign, ts: Number.isFinite(raw && raw.ts) ? raw.ts : 0 };
}

function readPlans() {
  try {
    const st = fs.statSync(PLAN_FILE);
    if (st.size > MAX_PLAN_BYTES) {
      // Nothing this module writes can get here (writePlan refuses first), so this
      // is a hand-edited or damaged file. Saying so beats every remote quietly
      // reading as unconfigured.
      console.warn("[firetvir] ignoring oversized", PLAN_FILE, st.size, "bytes");
      return {};
    }
    const j = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    return {};
  }
}

function readPlan(mac) {
  if (!MAC_RE.test(mac)) return null;
  const p = readPlans()[mac.toLowerCase()];
  return p ? sanitizePlan(p) : { devices: [], assign: {}, ts: 0 };
}

function writePlan(mac, raw) {
  if (!MAC_RE.test(mac)) return null;
  const plan = { ...sanitizePlan(raw), ts: Date.now() };
  const all = readPlans();
  if (plan.devices.length) all[mac.toLowerCase()] = plan;
  else delete all[mac.toLowerCase()];
  const body = JSON.stringify(all, null, 2);
  // The budget is enforced where the file is WRITTEN, not only where it is read: a
  // file the reader rejects takes every OTHER remote's setup with it, and the next
  // legitimate save would then persist that emptiness.
  if (body.length > MAX_PLAN_BYTES) {
    console.warn("[firetvir] refusing to write a", body.length, "byte plan file");
    return null;
  }
  try {
    fs.writeFileSync(PLAN_FILE, body, { mode: 0o600 });
  } catch (e) {
    return null;
  }
  return plan;
}

// A "plan" is what the UI assembles: one base codeset for everything, plus
// optional per-key overrides, plus an optional SECOND device per key (one press
// blasts both - e.g. Power to a TV and a soundbar). Fetching is per codeset, so
// a plan that names three different brands pulls three CSVs, each once.
//   { base: "codes/LG/..csv", keys: { Power: { path: "codes/Samsung/..csv", second: "..." } } }
function resolvePlan(plan, label, cb) {
  const per = (plan && plan.keys) || {};
  const pathFor = (key) => (per[key] && per[key].path) || (plan && plan.base) || null;
  const wanted = new Set();
  for (const key of IR_KEYS) {
    for (const p of [pathFor(key), per[key] && per[key].second]) if (p) wanted.add(p);
  }
  if (!wanted.size) return cb(new Error("no codeset selected"));

  const paths = [...wanted];
  const sets = {};
  let pending = paths.length;
  let failed = null;
  for (const p of paths) {
    fetchCodeset(p, (err, cs) => {
      if (err) failed = failed || err;
      else sets[p] = cs;
      if (--pending) return;
      if (failed) return cb(failed);
      const spec = { name: label || "custom", source: "irdb: " + paths.join(", "), duty_cycle: 33, keys: {} };
      for (const key of IR_KEYS) {
        const row = (sets[pathFor(key)] || { keys: {} }).keys[key];
        if (!row) continue; // this key is simply not programmed
        const entry = {
          irdb: irdbRow(row),
          ...(key === "Power" ? { optional: true, post_delay: 1000 } : {}),
        };
        const sp = per[key] && per[key].second;
        const srow = sp && (sets[sp] || { keys: {} }).keys[key];
        if (srow) entry.second = { irdb: irdbRow(srow) };
        spec.keys[key] = entry;
      }
      if (!Object.keys(spec.keys).length) return cb(new Error("codeset has no usable keys"));
      cb(null, spec);
    });
  }
}

// Accept either the plan object or a bare codeset path (the pre-per-key shape).
const asPlan = (planOrPath) => (typeof planOrPath === "string" ? { base: planOrPath, keys: {} } : planOrPath || {});

// ---- running the BLE tool -----------------------------------------------------------
function runTool(args, timeoutMs, cb) {
  if (!fs.existsSync(PY)) return cb(new Error("BLE support not installed"));
  const child = spawn(PY, [TOOL, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const cap = (d) => {
    out += d.toString();
    if (out.length > 8000) out = out.slice(-8000);
  };
  child.stdout.on("data", cap);
  child.stderr.on("data", cap);
  const to = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch (e) {}
  }, timeoutMs);
  child.on("close", (code) => {
    clearTimeout(to);
    cb(null, { ok: code === 0, code, output: out.trim().split("\n").slice(-8).join("\n") });
  });
  child.on("error", (e) => {
    clearTimeout(to);
    cb(e);
  });
}

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

// test = write the chosen codeset to the config + one-shot blast (nothing is
// stored on the remote); program = persist the keymap onto the remote's keys.
// The blast is built from the SAME plan the program would write, so what you
// hear/see in the test is exactly what lands on the remote - including a
// key's second device.
// A test writes its OWN config file. `status.configured` is read from CODES_FILE
// and the screen reports it as what was last written to the remote - so a test,
// which stores nothing on the remote at all, must not be able to claim that.
function testKey(mac, planOrPath, key, cb) {
  if (!MAC_RE.test(mac)) return cb(new Error("invalid MAC"));
  if (!IR_KEYS.includes(key)) return cb(new Error("invalid key"));
  resolvePlan(asPlan(planOrPath), null, (err, spec) => {
    if (err) return cb(err);
    if (!spec.keys[key]) return cb(new Error("codeset has no " + key));
    try {
      fs.writeFileSync(TEST_CODES_FILE, JSON.stringify(spec, null, 2));
    } catch (e) {
      return cb(e);
    }
    runTool(["blast", mac, "--config", TEST_CODES_FILE, "--key", key], 30000, cb);
  });
}

function program(mac, planOrPath, label, cb) {
  if (!MAC_RE.test(mac)) return cb(new Error("invalid MAC"));
  resolvePlan(asPlan(planOrPath), label, (err, spec) => {
    if (err) return cb(err);
    try {
      fs.writeFileSync(CODES_FILE, JSON.stringify(spec, null, 2));
    } catch (e) {
      return cb(e);
    }
    runTool(["program", mac, "--config", CODES_FILE], 60000, cb);
  });
}

function erase(mac, cb) {
  if (!MAC_RE.test(mac)) return cb(new Error("invalid MAC"));
  runTool(["erase", mac], 30000, (err, r) => {
    // The codes file is this box's record of what the remote carries. Leaving it
    // behind makes the screen go on naming codes that are no longer there.
    if (!err && r && r.ok) {
      try {
        fs.unlinkSync(CODES_FILE);
      } catch (e) {}
    }
    cb(err, r);
  });
}

function status(cb) {
  probeDeps((depsOk) => {
    let configured = null;
    try {
      const c = JSON.parse(fs.readFileSync(CODES_FILE, "utf8"));
      configured = { name: c.name || "", source: c.source || "" };
    } catch (e) {}
    suggestedBrand((brand) => {
      cb({
        toolPresent: fs.existsSync(TOOL),
        venvPresent: fs.existsSync(PY),
        depsOk,
        installing: depsState.running,
        installStep: depsState.step,
        installError: depsState.error,
        configured,
        suggestedBrand: brand, // the connected TV's brand (EDID/CEC), or null
      });
    });
  });
}

module.exports = {
  status,
  programmableRemotes,
  installDeps,
  fetchBrands,
  fetchCodeset,
  brandDevices,
  readPlan,
  writePlan,
  checkProtocols,
  testKey,
  program,
  erase,
  _test: { signature, groupSets, bestType, deviceKind, typeLabel, sanitizePlan },
};
