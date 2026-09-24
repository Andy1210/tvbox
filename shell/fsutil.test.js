const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fsutil = require("./fsutil");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-fsutil-"));

test("an atomic write replaces the file whole and leaves no temp file", () => {
  const f = path.join(dir, "a.json");
  fsutil.writeJsonAtomic(f, { a: 1 }, { mode: 0o600 });
  fsutil.writeJsonAtomic(f, { a: 2 }, { mode: 0o600 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 2 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
  );
});

test("without a mode an existing file keeps its own", () => {
  const f = path.join(dir, "x.sh");
  fs.writeFileSync(f, "old");
  fs.chmodSync(f, 0o750);
  fsutil.writeFileAtomic(f, "new");
  assert.equal(fs.readFileSync(f, "utf8"), "new");
  assert.equal(fs.statSync(f).mode & 0o777, 0o750);
});

test("a failed write leaves the previous content in place", () => {
  const f = path.join(dir, "keep.json");
  fs.writeFileSync(f, '{"keep":true}');
  const bad = {
    toJSON() {
      throw new Error("boom");
    },
  };
  assert.throws(() => fsutil.writeJsonAtomic(f, bad));
  assert.equal(fs.readFileSync(f, "utf8"), '{"keep":true}');
});

test("a file that does not parse is moved aside, never read as empty", () => {
  const f = path.join(dir, "c.json");
  fs.writeFileSync(f, '{"half":');
  const r = fsutil.readJsonGuarded(f);
  assert.equal(r.corrupt, true);
  assert.ok(!fs.existsSync(f));
  assert.equal(fs.readFileSync(r.movedTo, "utf8"), '{"half":');
  assert.deepStrictEqual(fsutil.readJsonGuarded(f), { missing: true });
});

test("a copy replaces the target by rename", () => {
  const src = path.join(dir, "src");
  const dst = path.join(dir, "dst");
  fs.writeFileSync(src, "payload");
  fs.writeFileSync(dst, "previous");
  const ino = fs.statSync(dst).ino;
  fsutil.copyFileAtomic(src, dst, { mode: 0o755 });
  assert.equal(fs.readFileSync(dst, "utf8"), "payload");
  assert.notEqual(fs.statSync(dst).ino, ino, "a running script must not be rewritten in place");
  assert.equal(fs.statSync(dst).mode & 0o777, 0o755);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a temp left by an interrupted write is removed by the next process's first write", () => {
  const sub = fs.mkdtempSync(path.join(dir, "sweep-"));
  const f = path.join(sub, "c.json");
  const stale = path.join(sub, ".c.json.1.1000.tmp");
  const fresh = path.join(sub, ".c.json.2.2000.tmp");
  const other = path.join(sub, ".d.json.1.1000.tmp");
  for (const t of [stale, fresh, other]) fs.writeFileSync(t, "x");
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);
  fs.utimesSync(other, old, old);
  fsutil.writeJsonAtomic(f, { c: 1 });
  assert.ok(!fs.existsSync(stale), "the old temp of this file is gone");
  assert.ok(fs.existsSync(fresh), "a recent one may still be on its way to a rename");
  assert.ok(fs.existsSync(other), "another file's temp is not ours to remove");
});
