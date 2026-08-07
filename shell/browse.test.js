// Walking the box's own folders and a plugged-in stick.
//
// Most of what is asserted here is a refusal. A local app shares the shell's
// origin, so this route is reachable by every app on the box, and removable media
// is by definition someone else's filesystem - it can carry a symlink to `/`, a
// `..` in a path, or a folder named to look like one of ours. The listing itself
// is the easy half.
//
// HOME is redirected before the require: the roots resolve through contentdirs,
// which reads it at import.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-browse-test-")));
const HOME = path.join(TMP, "home");
process.env.HOME = HOME;
const mk = (...p) => fs.mkdirSync(path.join(...p), { recursive: true });
const touch = (p, body) => fs.writeFileSync(p, body || "x");

mk(HOME, "Videos", "Sorozat");
mk(HOME, ".tvbox", "ambient");
mk(HOME, ".tvbox", "shell"); // machinery: not a source
mk(TMP, "outside"); // nothing under a root
mk(TMP, "stick", "Filmek"); // stands in for a mounted USB stick
touch(path.join(HOME, "Videos", "film.mkv"));
touch(path.join(HOME, "Videos", "Film 10.mkv"));
touch(path.join(HOME, "Videos", "Film 2.mkv"));
touch(path.join(HOME, "Videos", ".hidden.mkv"));
touch(path.join(TMP, "outside", "secret.txt"));
// A stick carrying a link out of itself. This is not paranoia: an ext4 stick
// prepared on a computer can hold any symlink at all.
fs.symlinkSync(TMP, path.join(TMP, "stick", "escape"));
// A folder whose name STARTS with a root's name, to pin that the containment
// check compares path segments and not string prefixes.
mk(HOME, "Videos-private");
touch(path.join(HOME, "Videos-private", "private.mkv"));

const browse = require("./browse");
const removable = require("./removable");

// What is plugged in is cached for a couple of seconds (one lsblk per navigation
// would be one forked process per keypress). Every test below decides for itself
// what is plugged in, so each starts from a cold cache.
test.beforeEach(() => removable.invalidate());

const STICK = {
  name: "sda",
  path: "/dev/sda",
  type: "disk",
  rm: true,
  tran: "usb",
  vendor: "SanDisk",
  model: "Ultra",
  children: [
    {
      name: "sda1",
      path: "/dev/sda1",
      type: "part",
      rm: true,
      fstype: "exfat",
      label: "FILMEK",
      mountpoint: null,
      size: 31000000000,
    },
  ],
};

// deps with a fake lsblk: `mountpoint` is where the stick claims to be mounted,
// null for one that is only plugged in.
function deps(mountpoint) {
  const stick = JSON.parse(JSON.stringify(STICK));
  stick.children[0].mountpoint = mountpoint || null;
  return {
    onPath: () => true,
    execFile: (cmd, args, opts, cb) => {
      const done = typeof opts === "function" ? opts : cb;
      setImmediate(() => done(null, JSON.stringify({ blockdevices: [stick] }), ""));
    },
  };
}
const sources = (d) => new Promise((res) => browse.sources(d, res));
const list = (d, p) => new Promise((res) => browse.list(d, p, res));

test("the sources are the user's own folders plus what is plugged in", async () => {
  const s = await sources(deps(null));
  const ids = s.sources.map((x) => x.id);
  assert.ok(ids.includes("home:Videos"), "the home folders are offered");
  assert.ok(ids.includes("tvbox:ambient"), "so is user content under ~/.tvbox");
  assert.ok(!ids.includes("tvbox:shell"), "and the box's machinery is not");
  const stick = s.sources.find((x) => x.kind === "removable");
  assert.strictEqual(stick.name, "FILMEK");
  assert.strictEqual(stick.mounted, false, "plugged in is not mounted");
  assert.strictEqual(stick.device, "/dev/sda1", "the UI needs this to mount it on open");
});

test("a box with no udisks still offers its own folders", async () => {
  const s = await sources({ onPath: () => false, execFile: () => assert.fail("nothing to run") });
  assert.ok(s.sources.length > 0);
  assert.strictEqual(s.removable.supported, false, "the UI says USB is unavailable rather than showing nothing");
});

test("a folder lists folders first, then files in natural order", async () => {
  const r = await list(deps(null), path.join(HOME, "Videos"));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    r.entries.map((e) => e.name),
    ["Sorozat", "Film 2.mkv", "Film 10.mkv", "film.mkv"],
    "10 sorts after 2, and case is not a sorting axis",
  );
  assert.strictEqual(
    r.entries.find((e) => e.name === ".hidden.mkv"),
    undefined,
    "a TV browser is not a file manager",
  );
  assert.strictEqual(r.parent, null, "at the top of a source there is nowhere further up");
  assert.strictEqual(r.root.id, "home:Videos");
  assert.strictEqual(r.entries[0].dir, true);
});

test("a folder inside a source can be walked back out of", async () => {
  const r = await list(deps(null), path.join(HOME, "Videos", "Sorozat"));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.parent, fs.realpathSync(path.join(HOME, "Videos")));
});

test("nothing outside a root can be listed", async () => {
  const r = await list(deps(null), path.join(TMP, "outside"));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "forbidden");
});

test("a `..` cannot climb out of a source", async () => {
  const r = await list(deps(null), path.join(HOME, "Videos", "..", "..", "outside"));
  assert.strictEqual(r.error, "forbidden");
});

test("a folder that merely starts with a root's name is not inside it", async () => {
  // "…/Videos-private".startsWith("…/Videos") is true, which is exactly the bug
  // the separator in the containment check exists to prevent. (It is a source in
  // its own right here, so the test asks it of the STICK's root instead.)
  const mounted = path.join(TMP, "stick");
  fs.mkdirSync(path.join(TMP, "stick-private"), { recursive: true });
  const r = await list(deps(mounted), path.join(TMP, "stick-private"));
  assert.strictEqual(r.error, "forbidden");
});

test("a symlink on the stick cannot lead out of it", async () => {
  const mounted = path.join(TMP, "stick");
  const ok = await list(deps(mounted), path.join(mounted, "Filmek"));
  assert.strictEqual(ok.ok, true, "the stick itself browses");
  const escaped = await list(deps(mounted), path.join(mounted, "escape"));
  assert.strictEqual(escaped.error, "forbidden", "both sides are compared as real paths");
});

test("a symlink out of the stick is not even listed", async () => {
  // It could not be opened (the test above), but listing it would report the
  // TARGET's size and mtime - an oracle for what exists on the box, from a stick
  // anyone can prepare on a computer.
  const mounted = path.join(TMP, "stick");
  fs.symlinkSync(path.join(HOME, ".tvbox"), path.join(mounted, "config-peek"));
  const r = await list(deps(mounted), mounted);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    r.entries.map((e) => e.name).sort(),
    ["Filmek"],
    "only what stays inside the stick is offered",
  );
});

test("an unmounted stick is a source but not a place", async () => {
  const r = await list(deps(null), path.join(TMP, "stick"));
  assert.strictEqual(r.error, "forbidden", "it becomes browsable when it is mounted, not before");
});

test("a file is not a folder, and a relative path is not a path", async () => {
  const f = await list(deps(null), path.join(HOME, "Videos", "film.mkv"));
  assert.strictEqual(f.error, "not_a_directory");
  const rel = await list(deps(null), "Videos");
  assert.strictEqual(rel.error, "bad_path");
  const gone = await list(deps(null), path.join(HOME, "Videos", "nope"));
  assert.strictEqual(gone.error, "not_found");
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
