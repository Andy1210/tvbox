// Store trust rules for the CURATED registry (node --test, no Electron).
// The registry is merge-reviewed, so a store app may carry a `service` plugin
// or be a `builtin` view; the one hard line is no third-party root `aptRepo`.
// Kept in sync with tvbox-apps/scripts/build-index.mjs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Isolate HOME before requiring store (install.js derives ~/.tvbox paths at
// import) so the seed migration reads a temp dir, not the real box.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-store-"));
process.env.HOME = TMP;
const store = require("./store");

test("trustErrors: allows a plain remote webclient", () => {
  assert.deepEqual(store.trustErrors({ type: "webclient", runtime: { serve: "remote" } }), []);
});

test("trustErrors: allows a webclient package that carries a service plugin (curated)", () => {
  assert.deepEqual(store.trustErrors({ type: "webclient", service: "livetv", runtime: { serve: "local" } }), []);
  assert.deepEqual(store.trustErrors({ type: "webclient", service: "spotify", runtime: { serve: "local" } }), []);
});

test("trustErrors: rejects a builtin type (apps are packages now)", () => {
  assert.match(store.trustErrors({ type: "builtin", service: "x" })[0], /webclient/);
});

test("trustErrors: allows requires.download + requires.apt", () => {
  assert.deepEqual(store.trustErrors({ type: "webclient", requires: { apt: ["mpv"], download: [{ bin: "x" }] } }), []);
});

test("trustErrors: rejects a third-party root aptRepo", () => {
  const errs = store.trustErrors({ type: "webclient", requires: { aptRepo: { line: "deb ..." } } });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /aptRepo/);
});

test("trustErrors: rejects an unknown type", () => {
  assert.match(store.trustErrors({ type: "native" })[0], /type/);
});

// ---- package apps installed end-to-end from a registry index ----
// The whole path: fetchIndex reads `packages`, attaches _pkg, install() routes
// to apps.installPackage, which fetches the dir next to the index (Kodi model:
// the app ships its own code/UI, not just a manifest).
const http = require("node:http");
const crypto = require("node:crypto");

test("install() of a package app writes the whole dir (manifest + plugin + web) to ~/.tvbox/apps/<id>/", async () => {
  const tree = {
    "apps/pkgapp/manifest.json":
      '{"id":"pkgapp","name":"PkgApp","type":"webclient","status":"ready","service":"pkgapp","runtime":{"serve":"local"}}',
    "apps/pkgapp/plugin.js": "module.exports = () => ({});\n",
    "apps/pkgapp/web/index.html": "<html>pkgapp</html>",
  };
  const files = Object.keys(tree)
    .filter((k) => k.startsWith("apps/pkgapp/"))
    .map((k) => ({
      path: k.slice("apps/pkgapp/".length),
      sha256: crypto.createHash("sha256").update(tree[k]).digest("hex"),
    }));
  const index = {
    registryVersion: 1,
    apps: [JSON.parse(tree["apps/pkgapp/manifest.json"])],
    packages: { pkgapp: { files } },
  };
  const server = http.createServer((req, res) => {
    if (req.url === "/index.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(index));
    }
    const body = tree[req.url.replace(/^\//, "")];
    if (body) {
      res.writeHead(200);
      return res.end(body);
    }
    res.writeHead(404);
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const registry = "http://127.0.0.1:" + server.address().port + "/index.json";
  const config = { rawStore: () => ({ registry }), appConfig: () => ({}) };
  try {
    const r = await store.install(config, "pkgapp");
    assert.equal(r.ok, true, "install failed: " + JSON.stringify(r));
    assert.equal(r.service, true, "service flag not carried from the package manifest");
    const dir = path.join(TMP, ".tvbox", "apps", "pkgapp");
    assert.equal(fs.readFileSync(path.join(dir, "web", "index.html"), "utf8"), "<html>pkgapp</html>");
    assert.ok(fs.existsSync(path.join(dir, "plugin.js")), "plugin.js not installed");
    // uninstall removes the whole package dir
    assert.equal(store.uninstall("pkgapp").ok, true);
    assert.equal(fs.existsSync(dir), false, "package dir not removed on uninstall");
  } finally {
    server.close();
  }
});

// ---- per-app versioning + update detection (apps update from the registry
// independently of any tvbox/shell release) ----
test("verGt compares major.minor.patch", () => {
  assert.equal(store.verGt("1.1.0", "1.0.0"), true);
  assert.equal(store.verGt("1.0.10", "1.0.9"), true);
  assert.equal(store.verGt("2.0.0", "1.9.9"), true);
  assert.equal(store.verGt("1.0.0", "1.0.0"), false);
  assert.equal(store.verGt("1.0.0", "1.1.0"), false);
  assert.equal(store.verGt("1.2", "1.1.9"), true); // missing patch = 0
});

test("listForUi flags updateAvailable when the registry version is newer than installed", async () => {
  const manifest = (v) => ({
    id: "verapp",
    name: "VerApp",
    type: "webclient",
    status: "ready",
    version: v,
    runtime: { serve: "local" },
  });
  const files = [{ path: "manifest.json", sha256: null }];
  const state = { indexVersion: "1.0.0" };
  const rebuild = () => {
    const body = JSON.stringify(manifest("1.0.0")); // the PACKAGE always ships 1.0.0 on disk
    files[0].sha256 = crypto.createHash("sha256").update(body).digest("hex");
    return body;
  };
  const pkgBody = rebuild();
  const server = http.createServer((req, res) => {
    if (req.url === "/index.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ registryVersion: 1, apps: [manifest(state.indexVersion)], packages: { verapp: { files } } }),
      );
    }
    if (req.url === "/apps/verapp/manifest.json") {
      res.writeHead(200);
      return res.end(pkgBody);
    }
    res.writeHead(404);
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const registry = "http://127.0.0.1:" + server.address().port + "/index.json";
  const config = { rawStore: () => ({ registry }), appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "verapp")).ok, true);
    // registry still 1.0.0 -> no update
    let list = await store.listForUi(config)(true);
    let e = list.apps.find((a) => a.id === "verapp");
    assert.equal(e.installed, true);
    assert.equal(e.updateAvailable, false, "should not offer an update at equal versions");
    // bump the REGISTRY entry to 1.1.0 (installed manifest on disk stays 1.0.0)
    state.indexVersion = "1.1.0";
    list = await store.listForUi(config)(true);
    e = list.apps.find((a) => a.id === "verapp");
    assert.equal(e.installedVersion, "1.0.0");
    assert.equal(e.version, "1.1.0");
    assert.equal(e.updateAvailable, true, "should offer an update when registry > installed");
    assert.deepEqual(list.updates, ["verapp"]);
  } finally {
    server.close();
  }
});
