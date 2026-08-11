#!/usr/bin/env node
// Build the TV-code index the boxes read: two databases in, one small static site out.
//
//   node scripts/ir-index/build.js --irdb <checkout> --flipper <checkout> --out <dir>
//
// Why this is not done on the box any more: a brand meant up to 400 irdb CSV fetches
// plus ~95 Flipper files, six at a time, and api.github.com allows 60 unauthenticated
// requests an hour - so the box carried a download job with concurrency, partial
// caching and a give-up counter to make that bearable. Here it is one pass over two
// git checkouts, and a box fetches one small JSON per brand instead.
//
// The output is published by .github/workflows/demo.yml to
// https://andy1210.github.io/tvbox/ir/ and read by shell/irindex.js.
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const irdb = require("./irdb");
const flipper = require("./flipper");
const { IR_KEYS, groupSets } = require("./group");

// irdb LICENSE.md clause 2 requires this verbatim wherever the database is used. The
// launcher shows the same string on the About screen (`about.irdbNotice`); it travels
// with the data as well so a copy of the index is never without it.
const IRDB_NOTICE =
  "Contains/accesses irdb by Simon Peter and contributors, used under permission. " +
  "For licensing details and for information on how to contribute to the database, " +
  "see https://github.com/probonopd/irdb";
const FLIPPER_NOTICE =
  "Contains Flipper-IRDB by UberGuidoZ and contributors (https://github.com/UberGuidoZ/Flipper-IRDB), " +
  "released under CC0 1.0 Universal.";

const FORMAT_VERSION = 1;

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// A brand is one row in the picker whatever spelling each database uses for it.
const brandKey = (b) =>
  String(b)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
// The brand's own name plus a hash of it, and every part of that is bounded so the
// result cannot be a slug the box refuses (`validSlug` in shell/irindex.js: starts
// alphanumeric, no `--`, at most 46 characters). Getting this wrong is silent - the
// brand file is written, the index lists it, and the box drops the row on arrival - so
// the shape is enforced here AND checked against the client's rule before publishing.
const SLUG_MAX_NAME = 32;
const slugOf = (b) => {
  const name = String(b)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX_NAME)
    .replace(/^-+|-+$/g, "");
  const hash = crypto.createHash("sha1").update(brandKey(b)).digest("hex").slice(0, 6);
  return (name || "brand") + "-" + hash;
};

// The rule the box applies to a slug it is asked to fetch (shell/irindex.js
// `validSlug`). Kept here as well rather than imported, because the generator must not
// require the shell's runtime modules - and a copy that drifts fails the build below
// instead of quietly costing a brand.
const validSlug = (s) => /^[a-z0-9][a-z0-9-]{0,45}$/.test(s) && !s.includes("--");

function readSets(root, mod, label) {
  const sets = mod.sets(root);
  let withKeys = 0;
  for (const s of sets) {
    try {
      s.keys = mod.codesFromText(fs.readFileSync(s.file, "utf8"));
    } catch (e) {
      s.keys = {};
    }
    if (Object.keys(s.keys).length) withKeys++;
  }
  console.log("%s: %d codesets, %d carry at least one of the four buttons", label, sets.length, withKeys);
  return sets;
}

// Hash every distinct code entry through the box's own encoders, in one python pass.
function frameHashes(rows) {
  const uniq = new Map(); // entry JSON -> hash
  for (const r of rows) uniq.set(JSON.stringify(r.entry), null);
  const keys = [...uniq.keys()];
  const input = keys.map((k) => JSON.stringify({ entry: JSON.parse(k) })).join("\n");
  const py = cp.spawnSync("python3", [path.join(__dirname, "frame_sig.py")], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (py.status !== 0) {
    throw new Error("frame_sig.py failed: " + (py.stderr || py.error || "status " + py.status));
  }
  const out = py.stdout.split("\n");
  if (out.length < keys.length) throw new Error("frame_sig.py answered " + out.length + " of " + keys.length + " rows");
  keys.forEach((k, i) => uniq.set(k, out[i].trim()));
  let unencodable = 0;
  for (const r of rows) {
    r.frame = uniq.get(JSON.stringify(r.entry)) || "";
    if (!r.frame) unencodable++;
  }
  console.log("frames: %d distinct codes, %d of them this box cannot encode", uniq.size, unencodable);
  return uniq;
}

function main() {
  const irdbRoot = arg("irdb");
  const flipperRoot = arg("flipper");
  const out = arg("out", "ir-index");
  if (!irdbRoot || !flipperRoot) {
    console.error("usage: build.js --irdb <checkout> --flipper <checkout> --out <dir>");
    process.exit(2);
  }
  const generated = new Date().toISOString();

  const sets = [...readSets(irdbRoot, irdb, "irdb"), ...readSets(flipperRoot, flipper, "Flipper-IRDB")];

  // Every key row of every set, so the frame hashes are computed once for all of them.
  const rows = [];
  for (const s of sets) for (const k of IR_KEYS) if (s.keys[k]) rows.push(s.keys[k]);
  frameHashes(rows);

  // Merge the two spellings of a brand, then merge each brand's codesets into devices.
  const brands = new Map();
  for (const s of sets) {
    const key = brandKey(s.brand);
    if (!key) continue;
    let b = brands.get(key);
    if (!b) brands.set(key, (b = { names: new Map(), sets: [] }));
    b.names.set(s.brand, (b.names.get(s.brand) || 0) + 1);
    b.sets.push(s);
  }

  // The output directory is deleted before it is written, so it has to be a directory
  // this script made: `--out .` would otherwise erase the working tree, and a mistyped
  // existing path erases whatever was there.
  if (fs.existsSync(out)) {
    const held = fs.readdirSync(out);
    const ours = held.includes("index.json") && held.includes("brands");
    if (held.length && !ours) {
      console.error("refusing to replace %s: not empty and not a generated index", out);
      process.exit(2);
    }
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(out, "brands"), { recursive: true });

  const listed = [];
  let totalDevices = 0;
  let bytes = 0;
  for (const [, b] of [...brands.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // The spelling most of its codesets use, so a brand reads the way the bigger
    // database writes it rather than however the last file did.
    const brand = [...b.names.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
    const { devices, skipped } = groupSets(b.sets);
    if (!devices.length) continue;
    const slug = slugOf(brand);
    if (!validSlug(slug)) throw new Error(`slug the box would refuse: ${slug} (brand ${brand})`);
    const body = JSON.stringify({ brand, slug, generated, devices, skipped });
    fs.writeFileSync(path.join(out, "brands", slug + ".json"), body);
    bytes += body.length;
    totalDevices += devices.length;
    listed.push({
      brand,
      slug,
      devices: devices.length,
      sets: b.sets.length,
      kinds: [...new Set(devices.map((d) => d.kind))],
    });
  }

  const index = {
    format: FORMAT_VERSION,
    generated,
    // The box keys its per-brand caches on this, so a rebuild retires them without
    // anyone having to clear anything.
    revision: crypto.createHash("sha1").update(generated).digest("hex").slice(0, 12),
    notice: [IRDB_NOTICE, FLIPPER_NOTICE].join("\n\n"),
    brands: listed.sort((a, b) => a.brand.localeCompare(b.brand)),
  };
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index));
  fs.writeFileSync(path.join(out, "NOTICE.txt"), index.notice + "\n");

  console.log(
    "wrote %s: %d brands, %d devices, %d KB of brand files, index %d KB",
    out,
    listed.length,
    totalDevices,
    Math.round(bytes / 1024),
    Math.round(JSON.stringify(index).length / 1024),
  );
}

if (require.main === module) main();
module.exports = { brandKey, slugOf, validSlug, IRDB_NOTICE, FLIPPER_NOTICE, FORMAT_VERSION };
