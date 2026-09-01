// The published TV-code index, as the box reads it.
//
// scripts/ir-index/build.js merges irdb and Flipper-IRDB into one small static site
// (.github/workflows/demo.yml publishes it next to the launcher demo), and this is the
// client: one index file listing the brands, one file per brand listing its devices
// with the code each button sends.
//
// It replaced per-codeset downloading, and the reason is arithmetic: a brand meant up
// to 400 irdb CSVs plus ~95 Flipper files, and api.github.com allows 60
// unauthenticated requests an hour - so the box carried a download job with
// concurrency, partial caching and a give-up counter. A brand is now ~1.5 KB.
//
// Nothing here is needed to PROGRAM a remote: a saved plan carries the codes
// themselves (shell/firetvir.js), so a box with no route to the index can still write
// what someone already chose.
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { isAllowedFetchUrl } = require("./netguard");
const { CACHE_DIR, fetchText, readCache, writeCache } = require("./irhttp");

const DEFAULT_BASE = "https://andy1210.github.io/tvbox/ir/";
const INDEX_CACHE = path.join(CACHE_DIR, "ir-index-v1.json");
const TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_INDEX_BYTES = 4e6; // ~100 KB today
const MAX_BRAND_BYTES = 2e6; // the biggest brand file is ~40 KB
const FORMAT = 1;

// A fork points its boxes at its own build with `firetvir.indexBase` in
// ~/.tvbox/config.json. Vetted by netguard's one rule for a self-hosted override -
// https to any host, plain http only to the LAN - which is the same rule
// `update.feed` gets, and this answer is less dangerous than that one.
function base() {
  let v = "";
  try {
    v = String((config.rawFiretvir() || {}).indexBase || "");
  } catch (e) {}
  if (!isAllowedFetchUrl(v)) return DEFAULT_BASE;
  return v.endsWith("/") ? v : v + "/";
}

// Injectable so the tests can answer without a network (the same reason
// shell/system.js takes an execFile).
let get = fetchText;

const validSlug = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,45}$/.test(s) && !s.includes("--");

let indexMemo = null;

// The cached copy goes through the SAME check a fresh answer does. It is a file in a
// writable directory, so "we already checked this once" is not a property it has -
// and what comes out of it names fetch URLs and paints rows.
function loadIndexCache() {
  if (indexMemo && Date.now() - indexMemo.ts < TTL_MS) return indexMemo;
  const c = readCache(INDEX_CACHE, MAX_INDEX_BYTES);
  if (!c || !(Date.now() - c.ts < TTL_MS)) return null;
  const index = sanitizeIndex(c.index);
  return index ? (indexMemo = { ts: c.ts, index }) : null;
}

// A published index is a file off the internet, so every field the UI or a fetch URL
// is built from is checked here rather than downstream. The answer carries `format`
// so that re-checking a cached copy is the same call, not a second rule.
function sanitizeIndex(raw) {
  if (!raw || typeof raw !== "object" || raw.format !== FORMAT) return null;
  const brands = [];
  for (const b of Array.isArray(raw.brands) ? raw.brands.slice(0, 5000) : []) {
    if (!b || !validSlug(b.slug)) continue;
    const brand = String(b.brand || "").slice(0, 60);
    if (!brand) continue;
    brands.push({
      brand,
      slug: b.slug,
      devices: Math.max(0, Math.min(9999, Math.round(Number(b.devices) || 0))),
      kinds: (Array.isArray(b.kinds) ? b.kinds : []).slice(0, 8).map((k) => String(k).slice(0, 12)),
    });
  }
  if (!brands.length) return null;
  // The revision becomes part of a CACHE FILE NAME, so it is a token here, not just a
  // bounded string: a `../` in it would put a write outside the cache directory.
  const revision = String(raw.revision || "").slice(0, 40);
  return {
    format: FORMAT,
    revision: /^[a-z0-9]+$/.test(revision) ? revision : "0",
    generated: String(raw.generated || "").slice(0, 40),
    notice: String(raw.notice || "").slice(0, 2000),
    brands,
  };
}

// Brand caches are named after the index revision, so a rebuild retires them without
// anyone clearing anything - and the ones from the previous revision are swept, or a
// box that browses often would keep every generation of every brand it looked at.
function pruneBrandCaches(revision) {
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (name.startsWith("ir-brand-") && !name.startsWith("ir-brand-" + revision + "-")) {
        fs.unlinkSync(path.join(CACHE_DIR, name));
      }
    }
  } catch (e) {}
}

function fetchIndex(cb) {
  const cached = loadIndexCache();
  if (cached) return cb(null, cached.index);
  get(base() + "index.json", MAX_INDEX_BYTES, (err, body) => {
    if (err) return cb(err);
    let index;
    try {
      index = sanitizeIndex(JSON.parse(body));
    } catch (e) {
      return cb(new Error("bad index json"));
    }
    if (!index) return cb(new Error("index is empty or of another format"));
    indexMemo = { ts: Date.now(), index };
    writeCache(INDEX_CACHE, indexMemo);
    pruneBrandCaches(index.revision);
    cb(null, index);
  });
}

// ---- one brand's devices -----------------------------------------------------------
// The keys a published device row may carry. This is a COPY of the generator's list
// (scripts/ir-index/keys.js): the shell ships without scripts/, so it cannot require it,
// and irindex.test.js asserts the two still agree - a key missing here is silently
// dropped from every device the box reads, which looks like the index not having it.
// The first four are what can be programmed onto a remote's own buttons; the rest exist
// to be BLASTED, which needs no key to bind to.
const IR_KEYS = ["VolumeUp", "VolumeDown", "Mute", "Power", "HDMI1", "HDMI2", "HDMI3", "HDMI4", "Input"];
// The ones a remote's own keymap can hold - the firmware assigns a scan id only to
// these. Everything after them in IR_KEYS is blast-only. Same four, and the same order,
// as the generator's identity list (scripts/ir-index/keys.js IR_KEYS).
const PROGRAMMABLE_KEYS = IR_KEYS.slice(0, 4);
const KINDS = new Set(["tv", "audio", "settop", "player", "climate", "other"]);
const MAX_DEVICES = 400;
// Mirrors the generator's own ceiling (scripts/ir-index/flipper.js): a keymap action
// stores each timing as a uint16 of 10 microseconds.
const MAX_RAW_TIMINGS = 512;
const MAX_RAW_UNIT = 65535;

// One key's code, checked field by field. This ends up as arguments to the python
// keymap builder and inside a file that programs a remote, so a published index (or a
// hand-edited plan - shell/firetvir.js reuses this) cannot put anything else there.
function sanitizeCode(raw) {
  if (!raw || typeof raw !== "object") return null;
  const protocol = String(raw.protocol || "").slice(0, 24);
  if (!/^[A-Za-z0-9_-]+$/.test(protocol)) return null;
  const e = raw.entry;
  if (!e || typeof e !== "object") return null;
  if (e.raw !== undefined) {
    const freq = Math.round(Number(e.frequency));
    if (!Array.isArray(e.raw) || e.raw.length < 6 || e.raw.length > MAX_RAW_TIMINGS) return null;
    if (!Number.isFinite(freq) || freq < 20000 || freq > 60000) return null;
    const timings = [];
    for (const v of e.raw) {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 1 || n > MAX_RAW_UNIT) return null;
      timings.push(n);
    }
    return { protocol, entry: { raw: timings, frequency: freq } };
  }
  if (e.flipper) {
    const f = e.flipper;
    // Either case, stored as one. The generator uppercases what it publishes, but a
    // hand-written plan carries whatever was copied out of a `.ir` file, and the python
    // side parses both - so refusing lowercase would drop a device for a difference that
    // does not exist.
    const hex = (v) => (/^[0-9a-fA-F]{2}( [0-9a-fA-F]{2})*$/.test(String(v || "")) ? String(v).toUpperCase() : null);
    const address = hex(f.address);
    const command = hex(f.command);
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(String(f.protocol || "")) || !address || !command) return null;
    return { protocol, entry: { flipper: { protocol: f.protocol, address, command } } };
  }
  if (e.irdb) {
    const i = e.irdb;
    const num = (v, lo) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= 0xffff ? Number(v) : null);
    const device = num(i.device, 0);
    const sub = num(i.subdevice, -1);
    const fn = num(i.function, 0);
    if (!/^[A-Za-z0-9_ -]{1,24}$/.test(String(i.protocol || "")) || device === null || fn === null) return null;
    return {
      protocol,
      entry: { irdb: { protocol: String(i.protocol), device, subdevice: sub === null ? -1 : sub, function: fn } },
    };
  }
  return null;
}

function sanitizeDevice(raw) {
  if (!raw || !/^[a-f0-9]{6,32}$/.test(String(raw.id || ""))) return null;
  const keys = {};
  for (const k of IR_KEYS) {
    const code = sanitizeCode((raw.keys || {})[k]);
    if (code) keys[k] = code;
  }
  if (!Object.keys(keys).length) return null;
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).filter((s) => s === "irdb" || s === "flipper");
  return {
    id: String(raw.id),
    label: String(raw.label || "").slice(0, 60) || "?",
    kind: KINDS.has(raw.kind) ? raw.kind : "other",
    variant: String(raw.variant || "").slice(0, 40),
    count: Math.max(1, Math.min(9999, Math.round(Number(raw.count) || 1))),
    types: (Array.isArray(raw.types) ? raw.types : []).slice(0, 8).map((t) => String(t).slice(0, 40)),
    sources: sources.length ? sources : ["irdb"],
    protocols: [...new Set(Object.values(keys).map((c) => c.protocol))],
    keys,
  };
}

// How many codesets carried none of the four keys, as a number the screen can print.
const count = (v) => Math.max(0, Math.min(9999, Math.round(Number(v) || 0)));

const brandCacheFile = (revision, slug) => path.join(CACHE_DIR, "ir-brand-" + revision + "-" + slug + ".json");

function fetchBrand(slug, cb) {
  if (!validSlug(slug)) return cb(new Error("invalid brand"));
  fetchIndex((err, index) => {
    if (err) return cb(err);
    const listed = index.brands.find((b) => b.slug === slug);
    if (!listed) return cb(new Error("unknown brand"));
    // Same rule as the index cache: a stored answer is re-checked device by device.
    const file = brandCacheFile(index.revision, slug);
    const cached = readCache(file, MAX_BRAND_BYTES);
    if (cached && Array.isArray(cached.devices)) {
      const devices = cached.devices.slice(0, MAX_DEVICES).map(sanitizeDevice).filter(Boolean);
      if (devices.length) return cb(null, { brand: listed.brand, slug, devices, skipped: count(cached.skipped) });
    }
    get(base() + "brands/" + encodeURIComponent(slug) + ".json", MAX_BRAND_BYTES, (e2, body) => {
      if (e2) return cb(e2);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e3) {
        return cb(new Error("bad brand json"));
      }
      const devices = (Array.isArray(parsed.devices) ? parsed.devices.slice(0, MAX_DEVICES) : [])
        .map(sanitizeDevice)
        .filter(Boolean);
      if (!devices.length) return cb(new Error("brand carries no usable device"));
      const answer = { brand: listed.brand, slug, devices, skipped: count(parsed.skipped) };
      writeCache(file, answer);
      cb(null, answer);
    });
  });
}

module.exports = {
  IR_KEYS,
  PROGRAMMABLE_KEYS,
  fetchIndex,
  fetchBrand,
  sanitizeCode,
  validSlug,
  _test: {
    sanitizeIndex,
    sanitizeDevice,
    setFetch: (fn) => {
      get = fn || fetchText;
    },
    reset: () => {
      indexMemo = null;
    },
    base,
    DEFAULT_BASE,
  },
};
