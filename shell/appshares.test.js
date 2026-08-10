// Tests for what a box offers to a peer. Nothing here runs rclone: what matters
// is WHICH folders a manifest can reach, what ends up in the served directory,
// and that the server refuses to come up without a credential.
//
// HOME is redirected before the require: the share root resolves at import.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-appshares-test-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;

const RA = path.join(HOME, ".var", "app", "org.libretro.RetroArch");
const mk = (...p) => fs.mkdirSync(path.join(...p), { recursive: true });
mk(RA, "config", "retroarch", "saves");
mk(RA, "config", "retroarch", "states");
mk(HOME, "secrets");

const appshares = require("./appshares");
test.after(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

// The anchor an app's declared paths resolve against, as install.appShareRoot
// hands it over: the app's flatpak data dir, or null for a ref it never declared.
const rootOf = (m) => (m.shares && m.shares.flatpak === "org.libretro.RetroArch" ? RA : null);

const retroarch = {
  id: "retroarch",
  name: "RetroArch",
  shares: { flatpak: "org.libretro.RetroArch", paths: ["config/retroarch/saves", "config/retroarch/states"] },
};

test("a declared folder becomes a share, named after its last segment", () => {
  const e = appshares.entries([retroarch], rootOf);
  assert.deepStrictEqual(
    e.map((x) => x.id),
    ["retroarch/saves", "retroarch/states"],
  );
  assert.equal(e[0].path, path.join(RA, "config", "retroarch", "saves"));
  assert.ok(e.every((x) => x.present));
});

test("an app that names a flatpak it does not depend on shares nothing", () => {
  const foreign = { id: "x", name: "X", shares: { flatpak: "org.other.App", paths: ["saves"] } };
  assert.deepStrictEqual(appshares.entries([foreign], rootOf), []);
});

test("two declared paths ending in the same segment get distinct names", () => {
  mk(RA, "gc", "saves");
  const m = {
    id: "retroarch",
    name: "RetroArch",
    shares: { flatpak: "org.libretro.RetroArch", paths: ["config/retroarch/saves", "gc/saves"] },
  };
  assert.deepStrictEqual(
    appshares.entries([m], rootOf).map((x) => x.name),
    ["saves", "saves-2"],
  );
});

test("a folder the app has not created yet stays listed, but not present", () => {
  const m = {
    id: "retroarch",
    name: "RetroArch",
    shares: { flatpak: "org.libretro.RetroArch", paths: ["config/retroarch/nothing-here"] },
  };
  const e = appshares.entries([m], rootOf);
  assert.equal(e.length, 1);
  assert.equal(e[0].present, false);
});

test("a destination the app has not created yet is made, but never past a symlink", () => {
  // The fresh-box case: nothing has run yet, so there is no saves folder to pull
  // into - and refusing there would make a new box the one place saves cannot go.
  const fresh = path.join(RA, "config", "retroarch", "fresh", "saves");
  assert.equal(appshares.ensureDir(RA, fresh), true);
  assert.ok(fs.statSync(fresh).isDirectory());
  assert.equal(appshares.ensureDir(RA, fresh), true, "an existing folder is simply accepted");

  const planted = path.join(RA, "config", "retroarch", "elsewhere");
  fs.mkdirSync(path.join(HOME, "secrets"), { recursive: true });
  fs.symlinkSync(path.join(HOME, "secrets"), planted);
  assert.equal(appshares.ensureDir(RA, path.join(planted, "saves")), false, "the deepest existing folder is outside");
  assert.ok(!fs.existsSync(path.join(HOME, "secrets", "saves")), "and nothing was created there");
  fs.rmSync(planted);
});

test("a symlink out of the app's own root is not a share", () => {
  const escape = path.join(RA, "config", "retroarch", "escape");
  fs.symlinkSync(path.join(HOME, "secrets"), escape);
  const m = {
    id: "retroarch",
    name: "RetroArch",
    shares: { flatpak: "org.libretro.RetroArch", paths: ["config/retroarch/escape"] },
  };
  assert.equal(appshares.entries([m], rootOf)[0].present, false, "resolved target is outside the app root");
  assert.equal(appshares.contained(RA, escape), false);
  assert.equal(appshares.contained(RA, path.join(RA, "config")), true);
  fs.rmSync(escape);
});

test("only the shares that are switched on reach the served directory", () => {
  const all = appshares.entries([retroarch], rootOf);
  const built = appshares.buildRoot(all, ["retroarch/saves"]);
  assert.deepStrictEqual(
    built.shared.map((s) => s.id),
    ["retroarch/saves"],
  );
  // namespaced per app, so two apps cannot collide on a share name
  assert.ok(fs.existsSync(path.join(appshares.ROOT, "retroarch", "saves")));
  assert.ok(!fs.existsSync(path.join(appshares.ROOT, "retroarch", "states")));
  // and turning one off rebuilds the root rather than leaving a live link behind
  appshares.buildRoot(all, ["retroarch/states"]);
  assert.ok(!fs.existsSync(path.join(appshares.ROOT, "retroarch", "saves")));
});

test("the server refuses to run without a token or without anything to serve", () => {
  const deps = {
    onPath: () => true,
    childEnv: () => ({}),
    entries: () => appshares.entries([retroarch], rootOf),
    supervisor: {
      spawn() {
        throw new Error("must not spawn");
      },
    },
  };
  assert.equal(appshares.start({ enabled: ["retroarch/saves"] }, deps).error, "token_missing");
  assert.equal(appshares.start({ token: "t", enabled: [] }, deps).error, "nothing_shared");
});

test("it serves read-only, and the token never reaches argv", () => {
  let spawned = null;
  const deps = {
    onPath: () => true,
    childEnv: () => ({}),
    entries: () => appshares.entries([retroarch], rootOf),
    supervisor: { spawn: (name, opts) => (spawned = { name, opts }) },
  };
  const r = appshares.start({ token: "secret-token", enabled: ["retroarch/saves"] }, deps);
  assert.equal(r.ok, true);
  const argv = spawned.opts.argv();
  assert.deepStrictEqual(argv.slice(0, 4), ["rclone", "serve", "webdav", appshares.ROOT]);
  assert.ok(argv.includes("--read-only"), "a peer pulls; it must not be able to write");
  assert.ok(!argv.join(" ").includes("secret-token"), "the credential goes through the environment");
  assert.equal(spawned.opts.env.RCLONE_PASS, "secret-token");
});

test("a port the shell already listens on falls back to the default", () => {
  assert.equal(appshares.portOf(8098), appshares.DEFAULT_PORT, "the file server's");
  assert.equal(appshares.portOf(8099), appshares.DEFAULT_PORT, "the pairing server's");
  assert.equal(appshares.portOf(9000), 9000);
  assert.equal(appshares.portOf("nonsense"), appshares.DEFAULT_PORT);
});

test("tokens are long, random and URL-safe", () => {
  const a = appshares.newToken();
  const b = appshares.newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32, a.length + " characters");
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});
