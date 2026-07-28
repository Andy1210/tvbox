// Tests for the file server's decisions. What matters here is not rclone (nothing
// below runs it) but WHICH folders the box offers, WHAT it ends up serving, and that
// it refuses to serve at all without a password - it binds to the LAN by design.
//
// HOME is redirected before the require: the candidate roots resolve at import.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-fileserver-test-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const mk = (...p) => fs.mkdirSync(path.join(HOME, ...p), { recursive: true });
// user content and box machinery side by side, exactly as a real box has them
mk(".tvbox", "ambient");
mk(".tvbox", "roms");
mk(".tvbox", "shell"); // machinery
mk(".tvbox", "shell-userdata"); // machinery (app logins)
mk(".tvbox", "versions"); // machinery
mk(".tvbox", "bin"); // machinery
mk(".tvbox", "voice-notes"); // a folder no version of this code knows about
mk("Videos");
mk(".var", "app", "org.libretro.RetroArch", "config");
const fileserver = require("./fileserver");

const byId = () => new Map(fileserver.candidates().map((c) => [c.id, c]));
const deps = (onPath) => ({
  onPath: () => onPath,
  childEnv: () => ({}),
  supervisor: {
    spawned: [],
    spawn(name, spec) {
      this.spawned.push({ name, spec });
    },
    stop() {},
  },
});

test("user content is offered and the box's machinery is not", () => {
  const c = byId();
  // the offered name IS the served one - the picker names what to look for on the
  // computer, so these must not drift apart
  assert.strictEqual(c.get("tvbox:ambient").name, "screensaver");
  assert.strictEqual(c.get("tvbox:roms").name, "games");
  for (const m of ["shell", "shell-userdata", "versions", "bin"])
    assert.strictEqual(c.has("tvbox:" + m), false, m + " is machinery, not content");
});

test("a folder this code has never heard of is offered anyway", () => {
  // The whole point of discovering rather than listing: an app that introduces a
  // folder tomorrow needs no change here.
  const entry = byId().get("tvbox:voice-notes");
  assert.ok(entry, "an unknown folder under ~/.tvbox must still be offered");
  assert.strictEqual(entry.name, "voice-notes", "and it keeps its own name");
});

test("an installed app's data dir is offered under the app's name", () => {
  // This is what makes a console BIOS folder reachable at all.
  const entry = byId().get("flatpak:org.libretro.RetroArch");
  assert.ok(entry);
  assert.strictEqual(entry.name, "RetroArch", "not the reverse-DNS id");
});

test("the home folder's own directories are offered", () => {
  assert.strictEqual(byId().get("home:Videos").name, "Videos");
});

test("~/.tvbox itself is offered, but flagged", () => {
  const entry = byId().get("tvbox:.");
  assert.ok(entry);
  assert.strictEqual(entry.warn, true, "it holds the box's settings and the apps' logins");
});

test("the served root holds exactly what was picked, and nothing from last time", () => {
  let r = fileserver.buildRoot(["tvbox:ambient", "flatpak:org.libretro.RetroArch"]);
  assert.deepStrictEqual(r.shared.map((s) => s.name).sort(), ["RetroArch", "screensaver"], "friendly names, not paths");
  assert.deepStrictEqual(fs.readdirSync(fileserver.ROOT).sort(), ["RetroArch", "screensaver"]);
  // unpicking rebuilds from scratch - a folder must not stay reachable
  r = fileserver.buildRoot(["tvbox:roms"]);
  assert.deepStrictEqual(fs.readdirSync(fileserver.ROOT), ["games"]);
  assert.strictEqual(r.shared[0].path, path.join(HOME, ".tvbox", "roms"));
});

test("the links point at the real folders, so writing through one lands in it", () => {
  fileserver.buildRoot(["tvbox:ambient"]);
  const via = path.join(fileserver.ROOT, "screensaver", "from-a-pc.txt");
  fs.writeFileSync(via, "hello");
  assert.strictEqual(fs.readFileSync(path.join(HOME, ".tvbox", "ambient", "from-a-pc.txt"), "utf8"), "hello");
  fs.rmSync(via);
});

test("an id that is not a candidate is ignored, not turned into a path", () => {
  const r = fileserver.buildRoot(["tvbox:../../etc", "home:/etc", "nonsense", "flatpak:../secrets"]);
  assert.deepStrictEqual(r.shared, []);
  assert.deepStrictEqual(fs.readdirSync(fileserver.ROOT), []);
});

test("two folders with the same name both stay reachable, under the name they were offered as", () => {
  mk(".tvbox", "Videos"); // the box's own Videos, next to the home folder's
  const c = byId();
  assert.strictEqual(c.get("tvbox:Videos").name, "Videos");
  assert.strictEqual(c.get("home:Videos").name, "Videos-2", "the clash is settled where the folder is offered");
  const both = fileserver.buildRoot(["home:Videos", "tvbox:Videos"]);
  assert.deepStrictEqual(both.shared.map((s) => s.name).sort(), ["Videos", "Videos-2"], "neither replaces the other");
  // and the suffix does not depend on what else happens to be shared: a client's
  // bookmark must not move because someone unshared an unrelated folder
  const alone = fileserver.buildRoot(["home:Videos"]);
  assert.deepStrictEqual(
    alone.shared.map((s) => s.name),
    ["Videos-2"],
  );
  fs.rmSync(path.join(HOME, ".tvbox", "Videos"), { recursive: true, force: true });
});

test("a name at the length limit stays within it once it is suffixed", () => {
  const long = "L".repeat(64); // exactly what nameOk allows
  mk(".tvbox", long);
  mk(long);
  const c = byId();
  assert.strictEqual(c.get("tvbox:" + long).name, long);
  const second = c.get("home:" + long).name;
  assert.strictEqual(second.length, 64, "the suffix comes out of the budget, not on top of it");
  assert.strictEqual(second, "L".repeat(62) + "-2");
  fs.rmSync(path.join(HOME, ".tvbox", long), { recursive: true, force: true });
  fs.rmSync(path.join(HOME, long), { recursive: true, force: true });
});

test("the served root is not inside anything it can serve", () => {
  // Sharing ~/.tvbox used to put the share root INSIDE the share, and the root holds
  // a link back to ~/.tvbox - a client walking the tree then recurses
  // (tvbox/fileserver/root/tvbox/...) as deep as it has patience for.
  const tvbox = path.join(HOME, ".tvbox");
  assert.ok(!fileserver.ROOT.startsWith(tvbox + path.sep), fileserver.ROOT + " is inside " + tvbox);
  for (const c of fileserver.candidates())
    assert.ok(!fileserver.ROOT.startsWith(c.path + path.sep), "reachable through " + c.id);
  // and sharing the box's own folder still works, it just cannot see the root
  const r = fileserver.buildRoot(["tvbox:."]);
  assert.deepStrictEqual(
    r.shared.map((x) => x.name),
    ["tvbox"],
  );
  assert.strictEqual(fs.existsSync(path.join(HOME, ".tvbox", "fileserver")), false, "the old location is cleaned up");
});

test("a port rclone could never bind is refused, not passed on", () => {
  // Anything unbindable turns into a respawn loop under the supervisor, which from
  // the TV just looks like the feature not working.
  for (const bad of [0, -1, 80, 1023, 65536, 1.5, "abc", null, undefined, "8098; rm -rf /"])
    assert.strictEqual(fileserver.portOf(bad), fileserver.DEFAULT_PORT, JSON.stringify(bad));
  for (const ok of [1024, 8098, 65535, "9000"]) assert.strictEqual(fileserver.portOf(ok), Number(ok));
  // and the ports the shell itself is already listening on: rclone would lose the
  // bind and land in the same loop
  for (const taken of [8097, 8099]) assert.strictEqual(fileserver.portOf(taken), fileserver.DEFAULT_PORT);
  const d = deps(true);
  fileserver.start({ pass: "goodenough", folders: ["tvbox:roms"], port: 80 }, d);
  assert.ok(d.supervisor.spawned[0].spec.argv().includes(":" + fileserver.DEFAULT_PORT), "fell back, did not obey");
});

test("a filesystem it cannot write to is reported, not thrown", () => {
  // start() runs straight from the settings POST, so a throw here would travel into
  // the HTTP handler and take the shell down over one feature's bad day.
  const parent = path.dirname(fileserver.ROOT);
  fs.mkdirSync(parent, { recursive: true });
  fs.rmSync(fileserver.ROOT, { recursive: true, force: true });
  fs.chmodSync(parent, 0o500); // read-only: mkdir of the root must fail
  try {
    const built = fileserver.buildRoot(["tvbox:ambient"]);
    assert.strictEqual(built.error, "share_failed");
    assert.deepStrictEqual(built.shared, []);
    assert.deepStrictEqual(fileserver.start({ pass: "goodenough", folders: ["tvbox:ambient"] }, deps(true)), {
      ok: false,
      error: "share_failed",
    });
  } finally {
    fs.chmodSync(parent, 0o700);
  }
});

test("it will not serve without a password", () => {
  const d = deps(true);
  for (const pass of [undefined, "", "short"])
    assert.deepStrictEqual(fileserver.start({ pass, folders: ["tvbox:ambient"] }, d), {
      ok: false,
      error: "password_required",
    });
  assert.deepStrictEqual(d.supervisor.spawned, [], "nothing may listen on the LAN meanwhile");
});

test("it will not serve an empty share, or without rclone", () => {
  assert.deepStrictEqual(fileserver.start({ pass: "goodenough", folders: [] }, deps(true)), {
    ok: false,
    error: "no_folders",
  });
  assert.deepStrictEqual(fileserver.start({ pass: "goodenough", folders: ["tvbox:ambient"] }, deps(false)), {
    ok: false,
    error: "rclone_missing",
  });
});

test("serving passes the credentials through the environment, never argv", () => {
  const d = deps(true);
  const r = fileserver.start({ pass: "goodenough", user: "me", folders: ["tvbox:roms"], port: 8098 }, d);
  assert.strictEqual(r.ok, true);
  const spec = d.supervisor.spawned[0].spec;
  const argv = spec.argv();
  assert.ok(!argv.join(" ").includes("goodenough"), "anyone on the box can read a command line");
  assert.strictEqual(spec.env.RCLONE_PASS, "goodenough");
  assert.strictEqual(spec.env.RCLONE_USER, "me");
  assert.deepStrictEqual(argv.slice(0, 4), ["rclone", "serve", "webdav", fileserver.ROOT]);
  assert.ok(argv.includes("--copy-links"), "the share root is symlinks; unfollowed they are useless");
  assert.ok(argv.includes(":8098"));
});

test("stopping takes the view of the box's folders away with it", () => {
  const d = deps(true);
  fileserver.start({ pass: "goodenough", folders: ["tvbox:roms"] }, d);
  assert.ok(fs.existsSync(fileserver.ROOT));
  fileserver.stop(d);
  assert.strictEqual(fs.existsSync(fileserver.ROOT), false);
  assert.strictEqual(fileserver.status({}, d).running, false);
});

test("status tells the launcher what it needs and never the password", () => {
  const s = fileserver.status({ enabled: true, pass: "goodenough", folders: ["tvbox:roms"] }, deps(true));
  assert.strictEqual(s.hasPass, true);
  assert.strictEqual(JSON.stringify(s).includes("goodenough"), false);
  assert.ok(s.candidates.length > 3);
  assert.ok(
    s.candidates.every((c) => !("path" in c)),
    "the launcher has no business with absolute paths",
  );
});

test("the pinned rclone downloads are real, checksummed and per-arch", () => {
  for (const [arch, spec] of Object.entries(fileserver.RCLONE_DOWNLOAD.arch)) {
    assert.match(spec.url, /^https:\/\/github\.com\/rclone\/rclone\/releases\/download\//, arch);
    assert.match(spec.sha256, /^[0-9a-f]{64}$/, arch);
    assert.ok(spec.extract.endsWith("/rclone"), arch);
  }
});

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});
