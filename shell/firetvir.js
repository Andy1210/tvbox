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
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

const TVBOX = path.join(os.homedir(), ".tvbox");
const PYENV = path.join(TVBOX, "pyenv");
const PY = path.join(PYENV, "bin", "python3");
const TOOL = path.join(TVBOX, "firetv_remote_ir.py");
const CODES_FILE = path.join(TVBOX, "firetv_tv_codes.json");
const CACHE_DIR = path.join(TVBOX, "cache");
const INDEX_CACHE = path.join(CACHE_DIR, "irdb-tv-index.json");
const INDEX_TTL_MS = 30 * 24 * 3600 * 1000;
// The user's "latest deps" stance, but pinned so an install is reproducible;
// dbus-fast ships aarch64 manylinux wheels, so no compiler is needed on the box.
const PIP_PACKAGES = ["bleak==3.0.2", "dbus-fast==5.0.22"];
const INDEX_URL = "https://api.github.com/repos/probonopd/irdb/git/trees/master?recursive=1";
const RAW_BASE = "https://raw.githubusercontent.com/probonopd/irdb/master/";
const MAX_INDEX_BYTES = 30e6;
const MAX_CSV_BYTES = 512e3;

// Wayland env for wlr-randr (the shell inherits it; fill gaps like main.js WL_ENV).
const WL_ENV = {
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/" + process.getuid(),
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
};
// TV make -> irdb brand folder. The box learns the make from the HDMI EDID
// (wlr-randr "Make:") or the CEC vendor id; we map the common ones so the UI
// can pre-select a brand. Non-exhaustive on purpose - an unknown TV just means
// no suggestion, and the user picks manually.
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
// The connected TV's brand, from EDID make first (most reliable), else the CEC
// vendor id the CEC bridge stored. Best-effort + fast; empty -> no suggestion.
function suggestedBrand(cb) {
  execFile("wlr-randr", [], { env: { ...process.env, ...WL_ENV }, timeout: 4000 }, (err, out) => {
    const m = !err && /Make:\s*(.+)/.exec(out || "");
    const fromEdid = m && makeToBrand(m[1]);
    if (fromEdid) return cb(fromEdid);
    let vendor = "";
    try {
      vendor = fs.readFileSync(path.join(TVBOX, "cec_tv_vendor"), "utf8").trim().toLowerCase();
    } catch (e) {}
    cb(CEC_VENDOR_BRAND[vendor] || null);
  });
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

// ---- tiny https GET with one redirect + size cap ---------------------------------
function httpsGet(url, maxBytes, cb, redirected) {
  const req = https.get(url, { headers: { "User-Agent": "tvbox", Accept: "*/*" }, timeout: 30000 }, (res) => {
    if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && !redirected) {
      res.resume();
      return httpsGet(new URL(res.headers.location, url).href, maxBytes, cb, true);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return cb(new Error("HTTP " + res.statusCode + (res.statusCode === 403 ? " (rate limited? retry later)" : "")));
    }
    const chunks = [];
    let size = 0;
    res.on("data", (d) => {
      size += d.length;
      if (size > maxBytes) {
        req.destroy();
        return cb(new Error("response too large"));
      }
      chunks.push(d);
    });
    res.on("end", () => cb(null, Buffer.concat(chunks).toString("utf8")));
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => cb(e));
}

// ---- irdb brand index -------------------------------------------------------------
function loadIndexCache() {
  try {
    const c = JSON.parse(fs.readFileSync(INDEX_CACHE, "utf8"));
    if (Date.now() - c.ts < INDEX_TTL_MS && Array.isArray(c.brands)) return c;
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
    const brands = new Map();
    for (const ent of tree) {
      const m = /^codes\/([^/]+)\/TV\/([^/]+\.csv)$/.exec(ent.path || "");
      if (!m) continue;
      if (!brands.has(m[1])) brands.set(m[1], []);
      brands.get(m[1]).push({ name: m[2].replace(/\.csv$/, ""), path: ent.path });
    }
    const out = [...brands.entries()]
      .map(([brand, sets]) => ({ brand, sets: sets.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.brand.localeCompare(b.brand));
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(INDEX_CACHE, JSON.stringify({ ts: Date.now(), brands: out }));
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

function pickRow(rows, synonyms) {
  let best = null;
  let bestScore = -1;
  for (const r of rows) {
    const name = r.functionname.toUpperCase().trim();
    for (let i = 0; i < synonyms.length; i++) {
      let score = -1;
      if (name === synonyms[i]) score = 100 - i;
      else if (name.includes(synonyms[i])) score = (name.includes("/") ? 20 : 50) - i;
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
  if (!validCodesetPath(relPath)) return cb(new Error("invalid codeset path"));
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

function specFromCodeset(cs, label) {
  const spec = { name: label || cs.path, source: "irdb: " + cs.path, duty_cycle: 33, keys: {} };
  for (const [key, row] of Object.entries(cs.keys)) {
    spec.keys[key] = {
      irdb: { protocol: row.protocol, device: row.device, subdevice: row.subdevice, function: row.function },
      ...(key === "Power" ? { optional: true, post_delay: 1000 } : {}),
    };
  }
  return spec;
}

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
function testKey(mac, relPath, key, cb) {
  if (!MAC_RE.test(mac)) return cb(new Error("invalid MAC"));
  if (!["VolumeUp", "VolumeDown", "Mute", "Power"].includes(key)) return cb(new Error("invalid key"));
  fetchCodeset(relPath, (err, cs) => {
    if (err) return cb(err);
    if (!cs.keys[key]) return cb(new Error("codeset has no " + key));
    const spec = specFromCodeset(cs);
    try {
      fs.writeFileSync(CODES_FILE, JSON.stringify(spec, null, 2));
    } catch (e) {
      return cb(e);
    }
    runTool(["blast", mac, "--config", CODES_FILE, "--key", key], 30000, cb);
  });
}

function program(mac, relPath, label, cb) {
  if (!MAC_RE.test(mac)) return cb(new Error("invalid MAC"));
  fetchCodeset(relPath, (err, cs) => {
    if (err) return cb(err);
    if (!Object.keys(cs.keys).length) return cb(new Error("codeset has no usable keys"));
    const spec = specFromCodeset(cs, label);
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
  runTool(["erase", mac], 30000, cb);
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
  checkProtocols,
  testKey,
  program,
  erase,
};
