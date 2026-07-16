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

test("installDownloadDeps is a no-op (ok) for an app with no download deps", () => {
  var r = apps.installDownloadDeps({ id: "x", requires: {} });
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
