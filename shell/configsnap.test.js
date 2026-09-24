// Config snapshots (shell/configsnap.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const configsnap = require("./configsnap");

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-snap-"));
  const cfg = path.join(root, "config.json");
  const dir = path.join(root, "config-snapshots");
  configsnap._test.setPathsForTest({ dir, config: cfg });
  return { root, cfg, dir };
}

test("a copy is kept 0600 in a 0700 directory, and an unchanged config is not copied again", () => {
  const t = tmp();
  fs.writeFileSync(t.cfg, JSON.stringify({ a: 1 }));
  const id = configsnap.take(1_700_000_000_000);
  assert.ok(id);
  assert.strictEqual(fs.statSync(t.dir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(t.dir, "config-" + id + ".json")).mode & 0o777, 0o600);
  assert.strictEqual(configsnap.take(1_700_000_001_000), null);
  fs.writeFileSync(t.cfg, JSON.stringify({ a: 2 }));
  assert.ok(configsnap.take(1_700_000_002_000));
  assert.strictEqual(configsnap.list().length, 2);
});

test("only the newest KEEP copies survive", () => {
  const t = tmp();
  for (let i = 0; i < configsnap.KEEP + 3; i++) {
    fs.writeFileSync(t.cfg, JSON.stringify({ i }));
    configsnap.take(1_700_000_000_000 + i * 1000);
  }
  const l = configsnap.list();
  assert.strictEqual(l.length, configsnap.KEEP);
  assert.strictEqual(l[0].at, 1_700_000_000_000 + (configsnap.KEEP + 2) * 1000);
});

test("a config that does not parse is never kept", () => {
  const t = tmp();
  fs.writeFileSync(t.cfg, "{not json");
  assert.strictEqual(configsnap.take(), null);
  assert.deepStrictEqual(configsnap.list(), []);
});

test("restore writes the copy back and keeps the config it replaced", () => {
  const t = tmp();
  fs.writeFileSync(t.cfg, JSON.stringify({ good: true }));
  const id = configsnap.take(1_700_000_000_000);
  fs.writeFileSync(t.cfg, JSON.stringify({ good: false }));
  let written = null;
  const r = configsnap.restore(id, (cfg) => {
    written = cfg;
  });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(written, { good: true });
  assert.strictEqual(configsnap.list().length, 2); // the replaced one was kept first
});

test("restore refuses ids that are not a listed copy", () => {
  tmp();
  let wrote = false;
  const never = () => (wrote = true);
  assert.strictEqual(configsnap.restore("../../etc/passwd", never).ok, false);
  assert.strictEqual(configsnap.restore("1700000000000", never).ok, false);
  assert.strictEqual(configsnap.restore(123, never).ok, false);
  assert.strictEqual(wrote, false);
});

test("a copy that was replaced by a symlink is not followed", () => {
  const t = tmp();
  fs.writeFileSync(t.cfg, JSON.stringify({ a: 1 }));
  const id = configsnap.take(1_700_000_000_000);
  const f = path.join(t.dir, "config-" + id + ".json");
  fs.unlinkSync(f);
  const other = path.join(t.root, "other.json");
  fs.writeFileSync(other, JSON.stringify({ evil: true }));
  fs.symlinkSync(other, f);
  let wrote = false;
  const r = configsnap.restore(id, () => (wrote = true));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(wrote, false);
});

test("restore stops when the config it would replace cannot be kept first", () => {
  const t = tmp();
  fs.writeFileSync(t.cfg, JSON.stringify({ good: true }));
  const id = configsnap.take(1_700_000_000_000);
  fs.writeFileSync(t.cfg, JSON.stringify({ good: false }));
  const fsutil = require("./fsutil");
  const real = fsutil.writeFileAtomic;
  fsutil.writeFileAtomic = () => {
    throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
  };
  let wrote = false;
  try {
    const r = configsnap.restore(id, () => (wrote = true));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(wrote, false);
  } finally {
    fsutil.writeFileAtomic = real;
  }
});

test("restore goes ahead when the current config is already the newest copy", () => {
  const t = tmp();
  fs.writeFileSync(t.cfg, JSON.stringify({ v: 1 }));
  const older = configsnap.take(1_700_000_000_000);
  fs.writeFileSync(t.cfg, JSON.stringify({ v: 2 }));
  configsnap.take(1_700_000_001_000);
  // Nothing needs writing, so a failing write must not block the restore.
  const fsutil = require("./fsutil");
  const real = fsutil.writeFileAtomic;
  fsutil.writeFileAtomic = () => {
    throw new Error("should not be called");
  };
  try {
    let written = null;
    const r = configsnap.restore(older, (cfg) => (written = cfg));
    assert.deepStrictEqual(r, { ok: true });
    assert.deepStrictEqual(written, { v: 1 });
  } finally {
    fsutil.writeFileAtomic = real;
  }
});
