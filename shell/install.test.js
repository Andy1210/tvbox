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
    const b = bodies[req.url];
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
