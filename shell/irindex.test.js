// The published TV-code index, as the box reads it: what it accepts from a file off the
// internet, and what it asks for. No network - the fetcher is injected.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const irindex = require("./irindex");

const { sanitizeIndex, sanitizeDevice, setFetch, reset, base, DEFAULT_BASE } = irindex._test;

const code = () => ({
  protocol: "NECx2",
  entry: { irdb: { protocol: "NECx2", device: 7, subdevice: 7, function: 7 } },
});
const device = (over) => ({
  id: "abc123def456",
  label: "TV",
  kind: "tv",
  variant: "NECx2 7,7",
  count: 27,
  types: ["TV"],
  sources: ["irdb"],
  keys: { VolumeUp: code(), Power: code() },
  ...over,
});
const index = (over) => ({
  format: 1,
  generated: "2026-08-10T20:00:00.000Z",
  revision: "abc123abc123",
  notice: "Contains/accesses irdb by Simon Peter and contributors, used under permission.",
  brands: [{ brand: "Samsung", slug: "samsung-1a2b3c", devices: 64, kinds: ["tv", "audio"] }],
  ...over,
});

// Anything that FETCHES runs in a child process with its own home: the module caches an
// index under ~/.tvbox/cache, and a test that wrote into the developer's real one would
// then be answered from disk and prove nothing.
function inBox(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "irx-"));
  fs.mkdirSync(path.join(home, ".tvbox", "cache"), { recursive: true });
  const script = `
    const os = require("os");
    os.homedir = () => ${JSON.stringify(home)};
    const ix = require(${JSON.stringify(path.join(__dirname, "irindex.js"))});
    const asked = [];
    const serve = (files) => ix._test.setFetch((url, max, cb) => {
      asked.push(url);
      const hit = Object.entries(files).find(([suffix]) => url.endsWith(suffix));
      process.nextTick(() => (hit ? cb(null, JSON.stringify(hit[1])) : cb(new Error("HTTP 404"))));
    });
    const say = (o) => console.log(JSON.stringify(o));
    ${body}
  `;
  return { home, out: JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim()) };
}

test.afterEach(() => {
  setFetch(null);
  reset();
});

test("an index of another format is not read", () => {
  assert.equal(sanitizeIndex(index({ format: 2 })), null, "a future build must not be half-understood");
  assert.equal(sanitizeIndex(index({ brands: [] })), null);
  assert.equal(sanitizeIndex(null), null);
  assert.equal(sanitizeIndex(index()).brands.length, 1);
});

test("every field a URL or a screen is built from is bounded", () => {
  const dirty = sanitizeIndex(
    index({
      revision: "r".repeat(80),
      notice: "n".repeat(5000),
      brands: [
        { brand: "Samsung", slug: "../../etc/passwd", devices: 5 },
        { brand: "Sony", slug: "sony-9f8e7d", devices: 1e9 },
        { brand: "", slug: "empty-000000", devices: 1 },
        { brand: "x".repeat(500), slug: "long-000000", devices: 1 },
      ],
    }),
  );
  assert.equal(dirty.revision.length, 40);
  assert.equal(dirty.notice.length, 2000);
  assert.deepEqual(
    dirty.brands.map((b) => b.slug),
    ["sony-9f8e7d", "long-000000"],
    "a slug that is not a slug never becomes a request",
  );
  assert.equal(dirty.brands[0].devices, 9999);
  assert.equal(dirty.brands[1].brand.length, 60);
});

test("a device with no code the box could send is not a device", () => {
  assert.equal(sanitizeDevice(device({ keys: {} })), null);
  assert.equal(sanitizeDevice(device({ id: "no" })), null);
  assert.equal(sanitizeDevice(device({ keys: { Power: { protocol: "x", entry: { nonsense: 1 } } } })), null);
  const d = sanitizeDevice(device({ kind: "nonsense", sources: ["irdb", "made-up"], count: -5 }));
  assert.equal(d.kind, "other");
  assert.deepEqual(d.sources, ["irdb"]);
  assert.equal(d.count, 1);
  assert.deepEqual(d.protocols, ["NECx2"]);
  assert.deepEqual(Object.keys(d.keys).sort(), ["Power", "VolumeUp"]);
});

test("a raw capture is accepted only within what a keymap action can hold", () => {
  const raw = (over) => ({
    protocol: "raw",
    entry: { raw: Array.from({ length: 20 }, () => 50), frequency: 38000, ...over },
  });
  assert.ok(irindex.sanitizeCode(raw()));
  assert.equal(irindex.sanitizeCode(raw({ frequency: 1000 })), null, "not a carrier a remote emits");
  assert.equal(irindex.sanitizeCode({ protocol: "raw", entry: { raw: [1, 2], frequency: 38000 } }), null);
  assert.equal(
    irindex.sanitizeCode({ protocol: "raw", entry: { raw: Array.from({ length: 600 }, () => 50), frequency: 38000 } }),
    null,
  );
  assert.equal(
    irindex.sanitizeCode({ protocol: "raw", entry: { raw: [50, 50, 50, 50, 50, 70000], frequency: 38000 } }),
    null,
    "wider than the uint16 the remote stores it in",
  );
});

test("the index is fetched once and then answered from memory", () => {
  const { out } = inBox(`
    serve({ "index.json": ${JSON.stringify(index())} });
    ix.fetchIndex((err, one) => {
      ix.fetchIndex((e2, two) => say({ brand: one.brands[0].brand, same: one.revision === two.revision, asked }));
    });
  `);
  assert.equal(out.brand, "Samsung");
  assert.ok(out.same);
  assert.equal(out.asked.length, 1, "the second reader pays nothing");
  assert.ok(out.asked[0].startsWith(DEFAULT_BASE), out.asked[0]);
});

test("a brand is only fetched if the index lists it", () => {
  const { out } = inBox(`
    serve({
      "index.json": ${JSON.stringify(index())},
      "brands/samsung-1a2b3c.json": { brand: "Samsung", devices: [${JSON.stringify(device())}, { id: "junk!" }] },
    });
    ix.fetchBrand("../../etc/passwd", (bad) => {
      ix.fetchBrand("nosuch-000000", (unknown) => {
        ix.fetchBrand("samsung-1a2b3c", (err, answer) => say({
          bad: bad && bad.message,
          unknown: unknown && unknown.message,
          brandRequests: asked.filter((u) => u.includes("brands/")).length,
          brand: answer && answer.brand,
          n: answer && answer.devices.length,
        }));
      });
    });
  `);
  assert.match(out.bad, /invalid brand/);
  assert.match(out.unknown, /unknown brand/, "the index is what decides a slug exists");
  assert.equal(out.brandRequests, 1, "nothing went out for the two that were refused");
  assert.equal(out.brand, "Samsung");
  assert.equal(out.n, 1, "the junk device is dropped, the good one kept");
});

test("a fork can point its boxes at its own build, over https only", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "irx-"));
  fs.mkdirSync(path.join(home, ".tvbox"));
  const run = (cfg) => {
    fs.writeFileSync(path.join(home, ".tvbox", "config.json"), JSON.stringify(cfg));
    return execFileSync(
      process.execPath,
      [
        "-e",
        `const os=require("os");os.homedir=()=>${JSON.stringify(home)};` +
          `console.log(require(${JSON.stringify(path.join(__dirname, "irindex.js"))})._test.base())`,
      ],
      { encoding: "utf8" },
    ).trim();
  };
  assert.equal(run({}), DEFAULT_BASE);
  assert.equal(run({ firetvir: { indexBase: "https://example.test/ir" } }), "https://example.test/ir/");
  assert.equal(run({ firetvir: { indexBase: "http://example.test/ir" } }), DEFAULT_BASE, "plaintext is refused");
  assert.equal(base(), DEFAULT_BASE);
});

test("a cached answer is checked again, not trusted because it is ours", () => {
  // The caches are files in a writable directory, and what comes out of them names
  // fetch URLs and paints rows. A slug that is not a slug, or a device with a code
  // this box could not send, must not survive a trip through the disk.
  const { home, out } = inBox(`
    const fs = require("fs");
    const path = require("path");
    const cache = path.join(require("os").homedir(), ".tvbox", "cache");
    fs.writeFileSync(path.join(cache, "ir-index-v1.json"), JSON.stringify({
      ts: Date.now(),
      index: { format: 1, revision: "cached00", generated: "", notice: "", brands: [
        { brand: "Samsung", slug: "samsung-000002", devices: 3 },
        { brand: "Evil", slug: "../../etc/passwd", devices: 1 },
      ] },
    }));
    fs.writeFileSync(path.join(cache, "ir-brand-cached00-samsung-000002.json"), JSON.stringify({
      devices: [${JSON.stringify(device())}, { id: "abcabcabcabc", label: "bad", keys: { Power: { protocol: "raw", entry: { raw: [1, 2], frequency: 38000 } } } }],
    }));
    serve({});
    ix.fetchIndex((err, index) => {
      ix.fetchBrand("samsung-000002", (e2, answer) => say({
        err: err && err.message,
        slugs: index.brands.map((b) => b.slug),
        devices: answer && answer.devices.length,
        asked,
      }));
    });
  `);
  assert.equal(out.err, null, "a good cached index is still used - no network here at all");
  assert.deepEqual(out.slugs, ["samsung-000002"], "the path-traversal slug is dropped on the way out of the cache");
  assert.equal(out.devices, 1, "and so is the cached device whose code is too short to be a frame");
  assert.deepEqual(out.asked, [], "nothing was fetched");
  assert.ok(fs.existsSync(path.join(home, ".tvbox", "cache", "ir-index-v1.json")));
});

test("a cache file bigger than the fetch cap is not read at all", () => {
  const { out } = inBox(`
    const fs = require("fs");
    const path = require("path");
    const file = path.join(require("os").homedir(), ".tvbox", "cache", "ir-index-v1.json");
    fs.writeFileSync(file, "[" + "0,".repeat(3e6) + "0]");
    serve({ "index.json": ${JSON.stringify(index())} });
    ix.fetchIndex((err, i) => say({ err: err && err.message, revision: i && i.revision, asked }));
  `);
  assert.equal(out.revision, "abc123abc123", "it went to the network instead");
  assert.equal(out.asked.length, 1);
});

test("a brand answer is cached per index revision, and the old generation is swept", () => {
  // Brand files are named after the revision so a rebuild retires them; without the
  // sweep a box that browses often would keep every generation of every brand.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "irx-"));
  fs.mkdirSync(path.join(home, ".tvbox", "cache"), { recursive: true });
  const stale = path.join(home, ".tvbox", "cache", "ir-brand-oldrevision0-samsung-1a2b3c.json");
  fs.writeFileSync(stale, JSON.stringify({ devices: [] }));
  const script = `
    const os = require("os");
    os.homedir = () => ${JSON.stringify(home)};
    const ix = require(${JSON.stringify(path.join(__dirname, "irindex.js"))});
    ix._test.setFetch((url, max, cb) => process.nextTick(() => cb(null, JSON.stringify(
      url.includes("brands/") ? { brand: "Samsung", devices: [${JSON.stringify(device())}] } : ${JSON.stringify(index())}
    ))));
    ix.fetchBrand("samsung-1a2b3c", (err, a) => console.log(JSON.stringify({ err: err && err.message, n: a && a.devices.length })));
  `;
  const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim();
  assert.deepEqual(JSON.parse(out), { err: null, n: 1 });
  const cache = fs.readdirSync(path.join(home, ".tvbox", "cache"));
  assert.ok(cache.includes("ir-brand-abc123abc123-samsung-1a2b3c.json"), cache.join(","));
  assert.ok(!cache.includes(path.basename(stale)), "the previous revision's copy is gone");
});
