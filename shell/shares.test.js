// Network shares: what a form is allowed to store, and what gets mounted.
//
// Nothing here runs rclone. What is worth pinning is the validation (a share name
// and a host both end up on a command line and in a path), the credential contract
// every form on this box follows, and the fact that a share removed from the list
// is a mount that has to stop.
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const shares = require("./shares");

const FULL = { name: "nas", host: "192.168.1.10", share: "media", path: "Filmek", user: "tv", pass: "obscured" };

test("a share is validated into what can be a path and a command-line argument", () => {
  const s = shares.shareFrom({ host: "nas.local", share: "media", path: "/Filmek/2024/", name: "NAS Films" });
  assert.strictEqual(s.name, "nas-films", "the name is a mount folder, so it is slugged");
  assert.strictEqual(s.path, "Filmek/2024", "a path pasted from a file manager keeps its stray slashes to itself");
  assert.strictEqual(s.host, "nas.local");
  assert.strictEqual(shares.mountPoint(s), path.join(os.homedir(), ".tvbox", "shares", "nas-films"));
});

test("what cannot be a host, a share or a sub-folder is refused", () => {
  const bad = [
    [{ host: "nas;rm -rf /", share: "media" }, "bad_host"],
    [{ host: "", share: "media" }, "bad_host"],
    [{ host: "nas", share: "med/ia" }, "bad_share"],
    [{ host: "nas", share: "" }, "bad_share"],
    [{ host: "nas", share: "media", path: "../../etc" }, "bad_path"],
    [{ host: "nas", share: "media", path: "a//b" }, "bad_path"],
    [{ host: "nas", share: "media", name: "..." }, "bad_name"],
  ];
  for (const [input, reason] of bad) {
    assert.throws(() => shares.shareFrom(input), new RegExp(reason), JSON.stringify(input));
  }
});

test("an omitted password keeps the stored one and an empty one clears it", () => {
  // The same contract as every other credential form here. A guest share with no
  // password is legitimate, so "unchanged" and "cleared" cannot both be falsy.
  const kept = shares.shareFrom({ host: "nas", share: "media", name: "nas" }, FULL);
  assert.strictEqual(kept.pass, "obscured");
  const cleared = shares.shareFrom({ host: "nas", share: "media", name: "nas", pass: "" }, FULL);
  assert.strictEqual(cleared.pass, "");
});

test("the credentials reach rclone through the environment, never the command line", () => {
  const env = shares.envFor(FULL, {});
  assert.strictEqual(env.RCLONE_CONFIG_TVBOXSMB_TYPE, "smb");
  assert.strictEqual(env.RCLONE_CONFIG_TVBOXSMB_HOST, "192.168.1.10");
  assert.strictEqual(env.RCLONE_CONFIG_TVBOXSMB_PASS, "obscured");
  const argv = shares.mountArgs(FULL).join(" ");
  assert.ok(!argv.includes("obscured"), "anyone on the box can read a command line");
  assert.match(argv, /tvboxsmb:media\/Filmek/);
  assert.match(argv, /--read-only/, "this is a player: a mistyped delete over SMB is not recoverable");
});

// A film is streamed once; an emulator seeks around a disc image for hours. Measured
// over SMB, a random 64 kB read from a GameCube image cost 79 ms at the median
// against 1.1 ms locally - which is what the freezing mid-game was made of. So the
// mount profile follows what the share HOLDS, and the two must not blur together.
test("a share of games is mounted to be cached, a share of films to be streamed", () => {
  const films = shares.mountArgs({ ...FULL, cache: "media" }).join(" ");
  assert.match(films, /--vfs-cache-mode minimal/);
  assert.ok(!films.includes("--vfs-cache-max-size"), "nothing is kept, so there is nothing to cap");

  const games = shares.mountArgs({ ...FULL, cache: "games" }).join(" ");
  assert.match(games, /--vfs-cache-mode full/, "the file is fetched once and read locally after that");
  assert.match(games, /--vfs-cache-max-age 720h/, "rclone's own hour would re-fetch the game every evening");
  assert.match(games, /--vfs-cache-max-size/, "a cap, so a library cannot grow into the whole card");
  assert.match(games, /--vfs-cache-min-free-space/, "and a floor under the box's own free space");
  assert.match(games, /--read-only/, "still a player: caching is not a licence to write");
});

test("a share stored before this setting existed is mounted the way it always was", () => {
  const old = { name: "nas", host: "nas", share: "media" }; // no `cache` field at all
  assert.match(shares.mountArgs(old).join(" "), /--vfs-cache-mode minimal/);
  assert.strictEqual(shares.status([old], { onPath: () => true }).shares[0].cache, "media");
});

test("what a share holds is remembered across an edit, and cannot be anything else", () => {
  const games = shares.shareFrom({ host: "nas", share: "roms", name: "roms", cache: "games" });
  assert.strictEqual(games.cache, "games");
  // An edit that says nothing about it must not quietly move it back. The password
  // is cleared rather than set on purpose: setting one runs `rclone obscure`, and a
  // test that needs a binary installed is a test that fails on a fresh runner.
  assert.strictEqual(shares.shareFrom({ host: "nas", share: "roms", name: "roms", pass: "" }, games).cache, "games");
  assert.strictEqual(shares.shareFrom({ host: "nas", share: "roms", name: "roms", path: "gc" }, games).cache, "games");
  assert.throws(() => shares.shareFrom({ host: "nas", share: "roms", name: "roms", cache: "whatever" }), /bad_cache/);
});

test("no share with no user is still a guest, not an empty user", () => {
  assert.strictEqual(shares.envFor({ host: "nas", share: "m" }, {}).RCLONE_CONFIG_TVBOXSMB_USER, "guest");
});

// A supervisor that only records what it was asked to run.
function fakeSupervisor() {
  const live = new Set();
  return {
    spawned: [],
    stopped: [],
    names() {
      return [...live];
    },
    spawn(name, spec) {
      live.add(name);
      this.spawned.push({ name, argv: spec.argv(), env: spec.env });
    },
    stop(name) {
      live.delete(name);
      this.stopped.push(name);
    },
  };
}
const deps = (supervisor, rclone = true) => ({
  supervisor,
  onPath: () => rclone,
  childEnv: () => ({}),
});

test("a share that is no longer configured is a mount that stops", () => {
  const sup = fakeSupervisor();
  shares.apply([FULL, { ...FULL, name: "second" }], deps(sup));
  assert.deepStrictEqual(sup.spawned.map((s) => s.name).sort(), ["share:nas", "share:second"]);
  shares.apply([FULL], deps(sup));
  assert.deepStrictEqual(sup.stopped, ["share:second"], "what the user removed must not keep running");
});

test("without rclone nothing is mounted, and it says which", () => {
  const sup = fakeSupervisor();
  const r = shares.apply([FULL], deps(sup, false));
  assert.deepStrictEqual(r, { ok: false, error: "rclone_missing" });
  assert.deepStrictEqual(sup.spawned, []);
});

test("the status the launcher sees never carries a password", () => {
  const st = shares.status([FULL], deps(fakeSupervisor()));
  assert.strictEqual(st.shares[0].hasPass, true);
  assert.strictEqual("pass" in st.shares[0], false);
  assert.strictEqual(st.shares[0].name, "nas");
});

test("only a mounted share is a place to browse", (t) => {
  // A configured share is not a root until it is actually mounted: the box may be
  // off the network, or rclone may not have come up yet. What is mounted is read
  // from mountinfo, because an unmounted mount point is just an empty directory
  // and readdir cannot tell the difference.
  const point = shares.mountPoint(FULL);
  const tmp = path.join(os.tmpdir(), "tvbox-shares-mountinfo-" + process.pid);
  require("fs").writeFileSync(tmp, "31 25 0:44 / " + point + " rw,nosuid,nodev,relatime shared:1 - fuse.rclone\n");
  t.after(() => require("fs").unlinkSync(tmp));
  assert.deepStrictEqual(shares.mountedRoots([FULL], tmp), [{ name: "nas", path: point }]);
  assert.deepStrictEqual(shares.mountedRoots([{ ...FULL, name: "other" }], tmp), []);
});

test("rclone's listing keeps a folder name that has spaces in it", () => {
  const out = [
    "          -1 2024-01-01 10:00:00        -1 Filmek",
    "          -1 2024-01-01 10:00:00        -1 Sorozatok 2024",
  ].join("\n");
  assert.deepStrictEqual(shares.dirNames(out), ["Filmek", "Sorozatok 2024"]);
});
