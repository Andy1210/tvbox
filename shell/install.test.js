// Regression: installed web-client bundles must live in the persistent
// ~/.tvbox/apps-data (not inside the versioned shell), and a pre-existing
// install from the OLD in-shell location must migrate on load - otherwise an
// OTA update reverts the tile to "Install". Run: node --test shell/install.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Isolate HOME to a temp dir BEFORE requiring install.js - APPS_DATA is computed
// from os.homedir() at import, and os.homedir() honours $HOME on POSIX.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-appsdata-"));
process.env.HOME = TMP;
// Seed "old" bundles across TWO prior OTA version dirs (the location every
// update used to lose) - a UNION migration must carry both, not just one.
function seed(version, id, body) {
  const d = path.join(TMP, ".tvbox", "versions", version, "shell", "apps-data", id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "index.html"), body);
}
seed("v1.0.0", "plex", "<html>plex</html>");
seed("v1.0.1", "jellyfin", "<html>jellyfin</html>");

const apps = require("./install");

test("installed bundles live in the persistent ~/.tvbox/apps-data", () => {
  const dst = apps.appDataDir("plex");
  assert.ok(dst.startsWith(path.join(TMP, ".tvbox", "apps-data")), "not persistent: " + dst);
});

test("pre-existing installs across OTA versions all migrate on load (union)", () => {
  apps.loadManifests();
  for (const id of ["plex", "jellyfin"]) {
    assert.equal(apps.isInstalled(id), true, id + " not restored after migration");
    assert.ok(fs.existsSync(path.join(apps.appDataDir(id), "index.html")), id + " files missing");
  }
});

// ---- UI-installable deps (requires.download, no root) ----
var NOPE = "tvbox_nope_" + process.arch; // a bin guaranteed not on PATH

test("appDeps.installable: true only when every missing bin is a download dep for this arch", () => {
  // missing + no download entry -> not UI-installable (needs apt/CLI)
  var aptOnly = { requires: { bin: [NOPE] } };
  assert.equal(apps.appDeps(aptOnly).depsOk, false);
  assert.equal(apps.appDeps(aptOnly).installable, false);

  // missing + a download entry for THIS arch -> UI-installable
  var dl = {
    requires: {
      bin: [NOPE],
      download: [{ bin: NOPE, arch: { [process.arch]: { url: "https://x/a.tar.gz", sha256: "0".repeat(64) } } }],
    },
  };
  assert.equal(apps.appDeps(dl).installable, true);

  // download entry only for another arch -> not installable here
  var otherArch = {
    requires: { bin: [NOPE], download: [{ bin: NOPE, arch: { not_this_arch: { url: "https://x" } } }] },
  };
  assert.equal(apps.appDeps(otherArch).installable, false);

  // nothing missing -> installable false (nothing to do)
  assert.equal(apps.appDeps({ requires: {} }).installable, false);
  assert.equal(apps.appDeps({ requires: {} }).depsOk, true);
});

test("installDownload validates the entry before touching the network", () => {
  assert.throws(() => apps.installDownload({ bin: "bad name!" }), /valid bin name/);
  assert.throws(() => apps.installDownload({ bin: "foo", arch: {} }), /no download for arch/);
  assert.throws(() => apps.installDownload({ bin: "foo", arch: { [process.arch]: { url: "http://x/a" } } }), /https/);
  assert.throws(
    () => apps.installDownload({ bin: "foo", arch: { [process.arch]: { url: "https://x/a", sha256: "short" } } }),
    /sha256/,
  );
});

test("installUiDeps is a no-op (ok) for an app with no download deps", () => {
  var r = apps.installUiDeps({ id: "x", requires: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.installed, []);
});

// ---- package apps (Kodi model: the app ships its own code/UI) ----
const http = require("node:http");
const crypto = require("node:crypto");

// Serve an in-memory {relPath: body} map so installPackage has a real registry
// to fetch from; returns { base, files, close } where files carries sha256s.
function servePackage(tree) {
  const bodies = {};
  const files = [];
  for (const rel of Object.keys(tree)) {
    const buf = Buffer.from(tree[rel]);
    bodies["/apps/pkgtest/" + rel] = buf;
    files.push({ path: rel, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
  }
  const server = http.createServer((req, res) => {
    const b = bodies[req.url.split("?")[0]]; // a static host ignores the cache-busting query
    if (b) {
      res.writeHead(200);
      res.end(b);
    } else {
      res.writeHead(404);
      res.end("no");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = "http://127.0.0.1:" + server.address().port + "/apps/pkgtest/";
      resolve({ base, files, close: () => server.close() });
    });
  });
}

test("installPackage fetches a package, verifies sha256, and installs the dir atomically", async () => {
  const srv = await servePackage({
    "manifest.json": '{"id":"pkgtest","name":"Pkg","type":"webclient"}',
    "plugin.js": "module.exports = () => ({});\n",
    "web/index.html": "<html>pkg</html>",
    "web/assets/app.js": "console.log(1)",
  });
  try {
    const dst = await apps.installPackage("pkgtest", srv.base, srv.files);
    assert.ok(fs.existsSync(path.join(dst, "manifest.json")), "manifest missing");
    assert.equal(fs.readFileSync(path.join(dst, "web", "index.html"), "utf8"), "<html>pkg</html>");
    assert.ok(fs.existsSync(path.join(dst, "web", "assets", "app.js")), "nested asset missing");
    // mkdtemp suffixes the name (.pkgtest.tmp-AbCd), so scan the parent for ANY
    // leftover rather than the literal prefix (which never exists as a dir)
    const leaked = fs.readdirSync(path.dirname(dst)).filter((n) => n.startsWith(".pkgtest.tmp-"));
    assert.deepEqual(leaked, [], "temp dir left behind: " + leaked.join(", "));
  } finally {
    srv.close();
  }
});

test("installPackage rejects a sha256 mismatch and leaves no install", async () => {
  const srv = await servePackage({ "manifest.json": '{"id":"bad","name":"B"}' });
  srv.files[0].sha256 = "0".repeat(64); // corrupt the expected hash
  try {
    await assert.rejects(() => apps.installPackage("badpkg", srv.base, srv.files), /sha256 mismatch/);
    assert.equal(fs.existsSync(path.join(apps.USER_APPS_DIR, "badpkg")), false);
  } finally {
    srv.close();
  }
});

test("installPackage refuses path traversal + a package with no manifest.json", async () => {
  await assert.rejects(
    () => apps.installPackage("trav", "https://x/", [{ path: "../evil", sha256: "a".repeat(64) }]),
    /bad package file path/,
  );
  const srv = await servePackage({ "web/index.html": "<html/>" }); // no manifest.json
  try {
    await assert.rejects(() => apps.installPackage("nomani", srv.base, srv.files), /manifest.json/);
  } finally {
    srv.close();
  }
});

test("installPackage pins every file to the registry origin (no off-host SSRF)", async () => {
  // an absolute-URL file path would make new URL() drop the base and fetch off-registry
  await assert.rejects(
    () =>
      apps.installPackage("evil", "https://reg.example/apps/evil/", [
        { path: "http://attacker/x", sha256: "a".repeat(64) },
      ]),
    /leaves the registry origin/,
  );
});

test("installPackage rejects a package whose manifest id doesn't match the install id", async () => {
  const srv = await servePackage({ "manifest.json": '{"id":"other","name":"O"}' });
  try {
    await assert.rejects(() => apps.installPackage("mismatch", srv.base, srv.files), /!= install id/);
    assert.equal(fs.existsSync(path.join(apps.USER_APPS_DIR, "mismatch")), false);
  } finally {
    srv.close();
  }
});

// A native app is launched from runtime.native.flatpak but its dependency is
// checked through requires.flatpak. Naming the ref in only one of them would make
// the tile claim it is ready with nothing installed, and the launch would fail, so
// the manifest validator refuses that shape.
const NATIVE_BASE = { id: "ra", name: "RA", type: "native", status: "ready" };

test("a native app must list its runtime flatpak ref in requires.flatpak", () => {
  const m = {
    ...NATIVE_BASE,
    requires: { flatpak: ["org.libretro.RetroArch"] },
    runtime: { native: { flatpak: "org.libretro.RetroArch", args: ["--fullscreen"] } },
  };
  assert.ok(apps.validateManifest(m, "ra.json"), "the matching pair is accepted");

  const mismatched = {
    ...NATIVE_BASE,
    requires: { flatpak: ["org.libretro.Something.Else"] },
    runtime: { native: { flatpak: "org.libretro.RetroArch" } },
  };
  assert.equal(apps.validateManifest(mismatched, "ra.json"), null, "a ref missing from requires is refused");

  const undeclared = { ...NATIVE_BASE, runtime: { native: { flatpak: "org.libretro.RetroArch" } } };
  assert.equal(apps.validateManifest(undeclared, "ra.json"), null, "no requires.flatpak at all is refused");
});

test("a native app declaring a plain bin needs no requires.flatpak", () => {
  const m = { ...NATIVE_BASE, runtime: { native: { bin: "moonlight" } } };
  assert.ok(apps.validateManifest(m, "ra.json"));
});

test("a native app with an unusable runtime.native is refused", () => {
  for (const native of [undefined, {}, { flatpak: "bad ref" }, { bin: "../../bin/sh" }]) {
    assert.equal(apps.validateManifest({ ...NATIVE_BASE, runtime: { native } }, "ra.json"), null);
  }
});

test("a bridge is a file the package ships, never a name or a path", () => {
  const withBridge = (bridge) => ({
    id: "x",
    name: "X",
    type: "webclient",
    status: "ready",
    runtime: { serve: "static", bridge },
  });
  assert.ok(apps.validateManifest(withBridge("./bridge.js"), "x.json"), "package-local adapter");
  // The value reaches require(), so nothing that can leave the package dir may
  // pass the manifest gate - main.js pins it again at resolution time. A bare
  // name is refused too: the shell ships no bridges of its own, so a manifest
  // asking for one is asking for something that cannot exist.
  for (const bad of [
    "qwebchannel",
    "../../etc/x.js",
    "./sub/dir.js",
    "/abs/path.js",
    "./bridge.json",
    "./Bridge.js",
    5,
    {},
  ]) {
    assert.equal(apps.validateManifest(withBridge(bad), "x.json"), null, JSON.stringify(bad));
  }
});

test("pairing entries are bounded and need a kind plus a label", () => {
  const withPairing = (pairing) => ({ id: "x", name: "X", type: "webclient", status: "ready", pairing });
  assert.ok(apps.validateManifest(withPairing([{ kind: "roms", label: "Upload" }]), "x.json"));
  assert.ok(apps.validateManifest(withPairing([{ kind: "roms", label: { en: "Upload" } }]), "x.json"));
  assert.equal(apps.validateManifest(withPairing([{ kind: "BAD KIND", label: "x" }]), "x.json"), null);
  assert.equal(apps.validateManifest(withPairing([{ kind: "roms" }]), "x.json"), null, "label is required");
  assert.equal(apps.validateManifest(withPairing("roms"), "x.json"), null, "must be an array");
  assert.equal(
    apps.validateManifest(withPairing(new Array(5).fill({ kind: "roms", label: "x" })), "x.json"),
    null,
    "at most 4",
  );
});

// A manifest's `backup.paths` reach the filesystem on BOTH sides of a backup -
// read on the source box, written on the target - so the validator is a security
// surface, not a convenience. A manifest dropped into ~/.tvbox/apps/ never sees
// CI's JSON Schema; this is the only check it gets.
test("backup.paths must be relative in-app paths", () => {
  const withBackup = (backup) => ({ id: "x", name: "X", type: "webclient", status: "ready", backup });
  assert.ok(apps.validateManifest(withBackup({ paths: ["saves", "config/retroarch.cfg"] }), "x.json"));
  for (const bad of [
    { paths: [] },
    { paths: "saves" },
    { paths: ["/etc/passwd"] },
    { paths: ["../../.ssh/id_rsa"] },
    { paths: ["saves/../../.ssh"] },
    { paths: ["./saves"] },
    { paths: ["saves//x"] },
    { paths: [123] },
    { paths: new Array(17).fill("a") },
    { paths: ["a"], flatpak: "not a ref" },
    { paths: ["state"] }, // reserved: the payload prefix for ~/.tvbox sidecars
    { paths: ["state/foo"] },
    [],
    "saves",
  ]) {
    assert.equal(apps.validateManifest(withBackup(bad), "x.json"), null, JSON.stringify(bad));
  }
});

// `shares.paths` decide what a peer box can read over the LAN, so the validator is
// the review surface: what a manifest may offer is readable before it is installed,
// and there is no runtime call that could widen it afterwards.
test("shares.paths must be relative in-app paths", () => {
  const withShares = (shares) => ({ id: "x", name: "X", type: "webclient", status: "ready", shares });
  assert.ok(apps.validateManifest(withShares({ paths: ["config/retroarch/saves"] }), "x.json"));
  for (const bad of [
    { paths: [] },
    { paths: "saves" },
    { paths: ["/etc/passwd"] },
    { paths: ["../../.ssh"] },
    { paths: ["saves/../../.ssh"] },
    { paths: ["./saves"] },
    { paths: ["saves//x"] },
    { paths: [123] },
    { paths: new Array(9).fill("a") },
    { paths: ["a"], flatpak: "not a ref" },
    [],
    "saves",
  ]) {
    assert.equal(apps.validateManifest(withShares(bad), "x.json"), null, JSON.stringify(bad));
  }
});

test("a shares.flatpak the app does not depend on is refused at load, not at use", () => {
  // A well-formed foreign ref passes a syntax check and is then refused by
  // appShareRoot, so the manifest loads and its shares silently disappear from the
  // screen that offers them - which reads as the feature being broken.
  const withShares = (m) => ({ id: "x", name: "X", type: "webclient", status: "ready", ...m });
  assert.equal(
    apps.validateManifest(withShares({ shares: { flatpak: "org.libretro.RetroArch", paths: ["saves"] } }), "x.json"),
    null,
    "not declared in requires.flatpak",
  );
  assert.ok(
    apps.validateManifest(
      withShares({
        requires: { flatpak: ["org.libretro.RetroArch"] },
        shares: { flatpak: "org.libretro.RetroArch", paths: ["saves"] },
      }),
      "x.json",
    ),
  );
});

test("a share resolves against the app's own root, and only its own", () => {
  const own = { id: "x", name: "X", shares: { paths: ["saves"] } };
  assert.equal(apps.appShareRoot(own), apps.appDataDir("x"), "no flatpak named: the app's own bundle dir");
  const ra = {
    id: "retroarch",
    name: "RetroArch",
    requires: { flatpak: ["org.libretro.RetroArch"] },
    shares: { flatpak: "org.libretro.RetroArch", paths: ["config/retroarch/saves"] },
  };
  assert.equal(apps.appShareRoot(ra), path.join(TMP, ".var", "app", "org.libretro.RetroArch"));
  const foreign = { id: "x", name: "X", shares: { flatpak: "org.libretro.RetroArch", paths: ["saves"] } };
  assert.equal(apps.appShareRoot(foreign), null, "a ref the app doesn't declare is refused");
  assert.equal(apps.appShareRoot({ id: "x" }), null, "nothing declared, nothing to offer");
});

// backup.js reads the shell's own ~/.tvbox sidecars into every backup; install.js
// decides which names an APP may claim. The two lists have to agree, or a new
// sidecar added to one is claimable through the other.
test("every shell sidecar the backup carries is reserved against apps", () => {
  const backupSrc = fs.readFileSync(path.join(__dirname, "backup.js"), "utf8");
  const extra = /const EXTRA_FILES = \[([^\]]*)\]/.exec(backupSrc);
  assert.ok(extra, "EXTRA_FILES not found in backup.js - update this test with it");
  const names = extra[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.ok(names.length, "EXTRA_FILES parsed empty");
  for (const name of names) {
    assert.ok(apps.RESERVED_STATE_FILES.has(name), name + " is carried by backup.js but not reserved in install.js");
  }
});

// backup.state names files in ~/.tvbox/ next to config.json, so the id prefix is
// the whole boundary: without it a manifest could ask for the shell's secrets.
test("backup.state may only name the app's own id-prefixed sidecars", () => {
  assert.ok(apps.stateFileOk("retroarch", "retroarch-share.json"));
  for (const bad of [
    "config.json",
    "spotify-accounts.json",
    "../config.json",
    "retroarch/../config.json",
    "sub/retroarch-x.json",
    "retroarchXshare.json",
    ".retroarch-share.json",
    "retroarch.json", // the dot forms are what let id `config` name config.json
    "retroarch.anything",
    "",
  ]) {
    assert.equal(apps.stateFileOk("retroarch", bad), false, JSON.stringify(bad));
  }
  // The id prefix on its own is NOT a boundary: an app id is only constrained to
  // [a-z0-9_-], so a manifest can call itself `config` or `spotify` and would
  // otherwise match the very files holding the box's credentials.
  assert.equal(apps.stateFileOk("config", "config.json"), false, "an app named config must not reach config.json");
  assert.equal(apps.stateFileOk("spotify", "spotify-accounts.json"), false, "nor a shell sidecar");
  assert.equal(apps.stateFileOk("spotify", "spotify-refresh-token"), false);
  assert.equal(apps.stateFileOk("restore", "restore-localstorage.json"), false);
  assert.equal(apps.stateFileOk("reconcile", "reconcile.json"), false);
  const withState = (state) => ({
    id: "retroarch",
    name: "RetroArch",
    type: "webclient",
    status: "ready",
    backup: { paths: ["saves"], state },
  });
  assert.ok(apps.validateManifest(withState(["retroarch-share.json"]), "x.json"));
  assert.equal(apps.validateManifest(withState(["config.json"]), "x.json"), null);
  assert.equal(apps.validateManifest(withState("retroarch-share.json"), "x.json"), null, "must be an array");
});

// The root a declared path resolves against, and the refusal that keeps an app
// from naming a flatpak it has nothing to do with.
test("backup paths resolve under the app's own root only", () => {
  const own = { id: "x", name: "X", type: "webclient", status: "ready", backup: { paths: ["saves"] } };
  assert.equal(apps.appBackupRoot(own), apps.appDataDir("x"));
  const ra = {
    id: "retroarch",
    name: "RetroArch",
    type: "webclient",
    status: "ready",
    requires: { flatpak: ["org.libretro.RetroArch"] },
    backup: { flatpak: "org.libretro.RetroArch", paths: ["config"] },
  };
  assert.equal(apps.appBackupRoot(ra), path.join(TMP, ".var", "app", "org.libretro.RetroArch"));
  const foreign = { ...ra, backup: { flatpak: "com.spotify.Client", paths: ["config"] } };
  assert.equal(apps.appBackupRoot(foreign), null, "a ref the app doesn't declare is refused");
  assert.equal(apps.appBackupRoot({ id: "x" }), null, "nothing declared, nothing to carry");
});

// ---- an extracted bundle vs the flatpak it came from ----
//
// A bundle is a COPY of the flatpak's files, and the flatpak moves on its own (the
// nightly update timer), so the copy goes stale with nothing in it changing to say
// so. This is the check that notices; the commit is read through the flatpak module,
// which is stubbed here so no flatpak has to be installed to run the tests.
const flatpak = require("./flatpak");
const PLEXISH = { id: "plex", type: "webclient", install: { source: { type: "flatpak", ref: "tv.plex.PlexHTPC" } } };

function withFlatpakAt(commit, fn) {
  const realRoot = flatpak.root,
    realCommit = flatpak.commitSync;
  flatpak.root = () => "/fake/flatpak/active";
  flatpak.commitSync = () => commit;
  try {
    return fn();
  } finally {
    flatpak.root = realRoot;
    flatpak.commitSync = realCommit;
  }
}
// installApp records where a bundle came from; do the same without running an
// extract, since acquiring anything would need a real flatpak.
function recordSource(id, ident) {
  const dir = path.join(TMP, ".tvbox", "apps-data", ".sources");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(ident));
}

test("a bundle with nothing recorded is refreshed once, then tracked", () => {
  // plex is installed by the migration test above
  fs.rmSync(path.join(TMP, ".tvbox", "apps-data", ".sources"), { recursive: true, force: true });
  withFlatpakAt("commit-a", () => {
    assert.strictEqual(apps.bundleStale(PLEXISH), true, "an untracked bundle must be levelled once");
    recordSource("plex", { type: "flatpak", ref: "tv.plex.PlexHTPC", arch: "x86_64", commit: "commit-a" });
    assert.strictEqual(apps.bundleStale(PLEXISH), false, "same commit is not stale");
  });
});

test("a bundle is stale exactly when its flatpak's commit moved", () => {
  recordSource("plex", { type: "flatpak", ref: "tv.plex.PlexHTPC", arch: "x86_64", commit: "commit-a" });
  // A rebuild can keep the version string, so the commit is what decides.
  withFlatpakAt("commit-b", () => assert.strictEqual(apps.bundleStale(PLEXISH), true));
  withFlatpakAt("commit-a", () => assert.strictEqual(apps.bundleStale(PLEXISH), false));
});

test("nothing is stale without a flatpak to compare against", () => {
  recordSource("plex", { type: "flatpak", ref: "tv.plex.PlexHTPC", arch: "x86_64", commit: "commit-a" });
  // An absent or unreadable flatpak says nothing: answering true here would ask for
  // a re-extract that can only fail (or trigger a fresh download at boot).
  withFlatpakAt(null, () => assert.strictEqual(apps.bundleStale(PLEXISH), false));
  assert.strictEqual(apps.bundleStale(PLEXISH), false, "no flatpak installed at all");
});

test("only a flatpak source can go stale on its own", () => {
  // url/git sources are pinned by the manifest: they change through a registry
  // update, which re-extracts anyway.
  for (const source of [
    { type: "url", url: "https://example.test/app.tgz", sha256: "a".repeat(64) },
    { type: "git", url: "https://example.test/app.git", commit: "b".repeat(40) },
  ])
    withFlatpakAt("commit-b", () =>
      assert.strictEqual(apps.bundleStale({ id: "plex", type: "webclient", install: { source } }), false, source.type),
    );
  // and an app with no bundle installed has nothing to refresh
  withFlatpakAt("commit-b", () => assert.strictEqual(apps.bundleStale({ ...PLEXISH, id: "not-installed-app" }), false));
});

// The state a settings restore leaves behind: the backup carries the manifest
// (~/.tvbox/apps/<id>.json) but never the extracted bundle. bundleStale answers
// false for it on purpose - there is no bundle to compare against the flatpak - so
// something else has to notice, or the app is stranded: HOME hides it (ready:false)
// and the store calls it installed because the manifest is there, leaving
// remove-then-install by hand on a TV as the only way out.
test("an app whose bundle is missing entirely is flagged for the refresh tick", () => {
  // plex's bundle was seeded+migrated by the tests above, so use a fresh id
  const RESTORED = { ...PLEXISH, id: "restored-app" };
  assert.strictEqual(apps.isInstalled("restored-app"), false, "precondition: no bundle on disk");
  assert.strictEqual(apps.bundleMissing(RESTORED), true, "a manifest with no bundle must be picked up");
  // ...and bundleStale still says false, which is exactly why bundleMissing exists
  withFlatpakAt("commit-a", () => assert.strictEqual(apps.bundleStale(RESTORED), false));

  // once the bundle exists it is no longer "missing" (the tick must not loop on it)
  fs.mkdirSync(apps.appDataDir("restored-app"), { recursive: true });
  assert.strictEqual(apps.bundleMissing(RESTORED), false, "a present bundle is not missing");

  // and it must NOT drag in apps that have no bundle to begin with: a pure manifest
  // app (youtube/xcloud/jellyfin - just a remote URL) restores complete, and a
  // native app (retroarch) has no install.source either. Flagging those would send
  // the tick installing things forever.
  assert.strictEqual(apps.bundleMissing({ id: "youtube", type: "webclient" }), false, "pure manifest");
  assert.strictEqual(apps.bundleMissing({ id: "retroarch", type: "native", install: {} }), false, "native app");
  assert.strictEqual(apps.bundleMissing(null), false, "no manifest at all");
});

test("a stale cached copy is refetched past the cache, not called corrupt", async () => {
  // A registry on a CDN can answer with a copy from before its last publish while
  // the index already describes the new one. The hash check must stay strict, but
  // "the edge is behind" and "this file is bad" are different things, and only one
  // of them is worth failing an install over.
  const good = Buffer.from('{"id":"pkgtest","name":"Pkg","type":"webclient"}');
  const stale = Buffer.from('{"id":"pkgtest","name":"OLD","type":"webclient"}');
  let servedStale = 0;
  const server = http.createServer((req, res) => {
    const [at, query] = req.url.split("?");
    if (at !== "/apps/pkgtest/manifest.json") {
      res.writeHead(404);
      return res.end("no");
    }
    // The plain URL is what an edge has cached; a URL it has never seen is a miss
    // and reaches the origin.
    res.writeHead(200);
    if (!query) {
      servedStale++;
      return res.end(stale);
    }
    res.end(good);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port + "/apps/pkgtest/";
  const files = [{ path: "manifest.json", sha256: crypto.createHash("sha256").update(good).digest("hex") }];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-stale-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    delete require.cache[require.resolve("./install")];
    const fresh = require("./install");
    await fresh.installPackage("pkgtest", base, files, () => {});
    const got = fs.readFileSync(path.join(home, ".tvbox", "apps", "pkgtest", "manifest.json"), "utf8");
    assert.match(got, /"name":"Pkg"/, "the good copy is what landed");
    assert.strictEqual(servedStale, 1, "the stale copy was tried once, then bypassed");
  } finally {
    process.env.HOME = prevHome;
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    delete require.cache[require.resolve("./install")];
  }
});

// The legacy Spotify token is the one shell sidecar whose name was wrong in both
// lists for a while, so pin the name that is actually on disk.
test("the legacy Spotify token is reserved under the name that exists", () => {
  assert.ok(apps.RESERVED_STATE_FILES.has("spotify-token"));
  assert.equal(apps.stateFileOk("spotify", "spotify-token"), false);
});

// A manifest-declared switch: an on/off setting for an app whose own screen cannot
// hold one (a native app, or a remote site that is not our UI). The key reaches a
// config write, so its shape is pinned here as well as in CI - a manifest dropped
// into ~/.tvbox/apps never sees CI.
const SWITCH_BASE = { id: "youtube", name: "YouTube", type: "webclient", status: "ready" };
const withSwitches = (switches) => ({ ...SWITCH_BASE, switches });

test("a switch needs a usable key and a label, and may default to on", () => {
  assert.ok(apps.validateManifest(withSwitches([{ key: "cast", label: "Cast", default: true }]), "youtube.json"));
  assert.ok(
    apps.validateManifest(withSwitches([{ key: "cast", label: { hu: "Cast", en: "Cast" }, hint: "..." }]), "y.json"),
    "a locale map and a hint are both allowed",
  );
  for (const bad of [
    [{ label: "no key" }],
    [{ key: "Cast", label: "capitals are not a config key" }],
    [{ key: "with space", label: "x" }],
    [{ key: "cast" }],
    [{ key: "cast", label: 7 }],
    [{ key: "cast", label: "x", default: "yes" }],
    // Passes the charset, but is not a property when assigned to a plain object.
    [{ key: "__proto__", label: "x" }],
    [{ key: "constructor", label: "x" }],
    "not an array",
    Array.from({ length: 9 }, (_, i) => ({ key: "k" + i, label: "x" })),
  ]) {
    assert.equal(apps.validateManifest(withSwitches(bad), "youtube.json"), null, JSON.stringify(bad).slice(0, 60));
  }
});

test("two switches cannot share one key", () => {
  // Both rows would write the same value, so the screen would show whichever row
  // happened to be drawn last.
  const dup = [
    { key: "cast", label: "A" },
    { key: "cast", label: "B" },
  ];
  assert.equal(apps.validateManifest(withSwitches(dup), "youtube.json"), null);
});

test("an app that declares no switches is unaffected", () => {
  assert.ok(apps.validateManifest({ ...SWITCH_BASE }, "youtube.json"));
});
