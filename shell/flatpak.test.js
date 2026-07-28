// Tests for the flatpak module. Nothing here runs the flatpak CLI: what is worth
// pinning is the pure part - which refs an app depends on and in which arch, and
// how `flatpak list` output is read - because those decide what the store shows
// and what an update touches. HOME is redirected before the require: the install
// bases are resolved at module load.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-flatpak-test-"));
process.env.HOME = HOME;
const flatpak = require("./flatpak");

const RA = "org.libretro.RetroArch";
const PLEX = "tv.plex.PlexHTPC";

// Pretend a ref is installed: what makes it "installed" is its files/ subdir.
function putApp(ref, arch) {
  const dir = path.join(HOME, ".local", "share", "flatpak", "app", ref, arch, "stable", "active", "files");
  fs.mkdirSync(dir, { recursive: true });
  return path.dirname(dir);
}

test("the arch is flatpak's name for it, never Node's", () => {
  const a = flatpak.arch();
  assert.ok(!["arm64", "x64"].includes(a), a);
  if (process.arch === "arm64") assert.strictEqual(a, "aarch64");
  if (process.arch === "x64") assert.strictEqual(a, "x86_64");
});

test("a ref is installed once its files/ dir exists, and reads back its root", () => {
  assert.strictEqual(flatpak.isInstalled(RA), false);
  const root = putApp(RA, flatpak.arch());
  assert.strictEqual(flatpak.isInstalled(RA), true);
  assert.strictEqual(flatpak.root(RA, flatpak.arch()), root);
  // an app installed for a DIFFERENT arch is not this box's app
  assert.strictEqual(flatpak.root(RA, "sparc"), null);
});

test("the short name is what a tile says, not the reverse-DNS id", () => {
  assert.strictEqual(flatpak.shortName(RA), "RetroArch");
  assert.strictEqual(flatpak.shortName(PLEX), "PlexHTPC");
});

test("refsFor covers both ways an app depends on a flatpak", () => {
  // the app RUNS it: box arch, because a native app must be the real thing
  const native = flatpak.refsFor({ requires: { flatpak: [RA] }, runtime: { native: { flatpak: RA } } });
  assert.deepStrictEqual(native, [{ ref: RA, arch: flatpak.arch() }]);
  // the app's bundle was EXTRACTED from it: whatever arch the recipe names, since
  // any arch's files work for a web bundle
  const extracted = flatpak.refsFor({ install: { source: { type: "flatpak", ref: PLEX, arch: "x86_64" } } });
  assert.deepStrictEqual(extracted, [{ ref: PLEX, arch: "x86_64" }]);
  // a source with no arch keeps the historical default rather than guessing the box's
  const noArch = flatpak.refsFor({ install: { source: { type: "flatpak", ref: PLEX } } });
  assert.deepStrictEqual(noArch, [{ ref: PLEX, arch: "x86_64" }]);
});

test("refsFor lists a ref once, and only refs that pass the ref rule", () => {
  const both = flatpak.refsFor({
    requires: { flatpak: [RA, RA] },
    install: { source: { type: "flatpak", ref: RA, arch: "x86_64" } },
  });
  assert.deepStrictEqual(both, [{ ref: RA, arch: flatpak.arch() }], "the running arch wins; it is one download");
  assert.deepStrictEqual(flatpak.refsFor({ requires: { flatpak: ["not a ref", "../../x"] } }), []);
  assert.deepStrictEqual(flatpak.refsFor(null), []);
  // a non-flatpak source contributes nothing
  assert.deepStrictEqual(flatpak.refsFor({ install: { source: { type: "url", url: "https://x/y.tgz" } } }), []);
});

test("`flatpak list` output is read by column, and junk lines are skipped", () => {
  const map = flatpak.parseList(
    [
      RA + "\t1.22.2\t" + flatpak.arch() + "\tuser",
      PLEX + "\t1.70.1\tx86_64\tuser",
      "not a ref at all\t1.0\tx86_64\tuser",
      "",
    ].join("\n"),
  );
  assert.strictEqual(map.size, 2);
  assert.strictEqual(map.get(RA).version, "1.22.2");
  assert.strictEqual(map.get(PLEX).arch, "x86_64");
  assert.strictEqual(map.get(PLEX).installation, "user");
});

test("a ref installed for two arches reports the box's", () => {
  const map = flatpak.parseList(
    [RA + "\t1.0.0\tsparc\tuser", RA + "\t1.22.2\t" + flatpak.arch() + "\tuser"].join("\n"),
  );
  assert.strictEqual(map.get(RA).version, "1.22.2");
  const other = flatpak.parseList(
    [RA + "\t1.22.2\t" + flatpak.arch() + "\tuser", RA + "\t1.0.0\tsparc\tuser"].join("\n"),
  );
  assert.strictEqual(other.get(RA).version, "1.22.2", "order must not decide which one wins");
});

test("the commit of a ref that is not installed is null, not a throw", () => {
  assert.strictEqual(flatpak.commitSync("com.example.NotHere"), null);
  assert.strictEqual(flatpak.commitSync("not a ref"), null);
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
