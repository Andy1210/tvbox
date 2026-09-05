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

// A native app is installable from the store for the same reason a `service`
// package is: the registry is curated, and launching the flathub app the manifest
// names is no more powerful than the host Node code a plugin already runs. Refusing
// it here would leave hand-copying as the only way to install one.
test("trustErrors: allows a native app with its flatpak dep and a plugin", () => {
  assert.deepEqual(
    store.trustErrors({
      type: "native",
      service: "retroarch",
      requires: { flatpak: ["org.libretro.RetroArch"] },
      runtime: { native: { flatpak: "org.libretro.RetroArch" } },
    }),
    [],
  );
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
  // `native` used to be the example here, back when it was not a type the shell
  // knew. Anything still outside the known set has to be refused.
  assert.match(store.trustErrors({ type: "widget" })[0], /type/);
  assert.match(store.trustErrors({})[0], /type/);
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
    const at = req.url.split("?")[0]; // a static host routes on the path, not the query
    if (at === "/index.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(index));
    }
    const body = tree[at.replace(/^\//, "")];
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

test("verGt orders prerelease below the matching release", () => {
  assert.equal(store.verGt("1.2.0", "1.2.0-beta.1"), true); // release > its prerelease
  assert.equal(store.verGt("1.2.0-beta.1", "1.2.0"), false);
  assert.equal(store.verGt("1.2.0-beta.2", "1.2.0-beta.1"), true); // numeric identifier compare
  assert.equal(store.verGt("1.2.0-beta.10", "1.2.0-beta.2"), true); // numeric, not lexical
  assert.equal(store.verGt("1.2.0-rc.1", "1.2.0-beta.9"), true); // rc > beta (lexical)
  assert.equal(store.verGt("1.2.0-beta", "1.2.0-beta.1"), false); // shorter prerelease is lower
  assert.equal(store.verGt("1.3.0-beta.1", "1.2.0"), true); // higher core wins regardless
  assert.equal(store.verGt("1.2.0+build9", "1.2.0"), false); // build metadata ignored
});

test("verGt compares large numeric identifiers without precision loss", () => {
  // parseInt would round both to the same float (> Number.MAX_SAFE_INTEGER)
  assert.equal(store.verGt("1.0.9007199254740993", "1.0.9007199254740992"), true);
  assert.equal(store.verGt("1.0.9007199254740992", "1.0.9007199254740993"), false);
  assert.equal(store.verGt("1.0.0-beta.9007199254740993", "1.0.0-beta.9007199254740992"), true);
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
    const at = req.url.split("?")[0]; // a static host routes on the path, not the query
    if (at === "/index.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ registryVersion: 1, apps: [manifest(state.indexVersion)], packages: { verapp: { files } } }),
      );
    }
    if (at === "/apps/verapp/manifest.json") {
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
    // Every test here leaves the box as it found it: an app left installed is
    // an app the later tests have to see, and it now gets a row of its own in
    // any list where a source did not answer.
    await store.uninstall("verapp");
    server.close();
  }
});

// ---- several registries merged into one catalogue ----
// A manifest-only app is enough for these: install() writes the index entry
// itself to ~/.tvbox/apps/<id>.json, so what is on disk names the registry it
// came from without any package plumbing in the way.
function registry(apps) {
  const state = { apps };
  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0] !== "/index.json") {
      res.writeHead(404);
      return res.end("no");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ registryVersion: 1, apps: state.apps }));
  });
  return {
    state,
    listen: async () => {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return "http://127.0.0.1:" + server.address().port + "/index.json";
    },
    close: () => server.close(),
  };
}
const manifestOnly = (id, name, version) => ({
  id,
  name,
  version,
  type: "webclient",
  status: "ready",
  runtime: { serve: "remote" },
});

test("two registries merge into one catalogue, each app labelled with its source", async () => {
  const a = registry([manifestOnly("offapp", "OffApp", "1.0.0")]);
  const b = registry([manifestOnly("brewapp", "BrewApp", "1.0.0")]);
  const [urlA, urlB] = [await a.listen(), await b.listen()];
  const config = {
    rawStore: () => ({ registry: urlA, sources: [{ url: urlB, name: "Homebrew" }] }),
    appConfig: () => ({}),
  };
  try {
    const list = await store.listForUi(config)(true);
    // Catalogue only. The list also carries installed apps that no source
    // lists, and tests above this one leave some installed.
    const catalogue = list.apps.filter((e) => !e.unlisted);
    assert.deepEqual(
      catalogue.map((e) => e.id),
      ["offapp", "brewapp"],
      "the primary registry's apps come first, in its own order",
    );
    assert.equal(catalogue[1].source.url, urlB);
    assert.equal(catalogue[1].source.name, "Homebrew");
    assert.equal(catalogue[1].source.official, false, "an added registry is never labelled official");
    assert.equal(list.error, null);
    assert.equal(list.sources.length, 2);
    assert.deepEqual(
      list.sources.map((s) => s.count),
      [1, 1],
    );
  } finally {
    a.close();
    b.close();
  }
});

test("a registry that is down costs its own apps and nothing else", async () => {
  const a = registry([manifestOnly("offapp", "OffApp", "1.0.0")]);
  const urlA = await a.listen();
  const config = {
    // A port nothing listens on: this source fails while the other answers.
    rawStore: () => ({ registry: urlA, sources: ["http://127.0.0.1:1/index.json"] }),
    appConfig: () => ({}),
  };
  try {
    const list = await store.listForUi(config)(true);
    assert.deepEqual(
      list.apps.map((e) => e.id),
      ["offapp"],
    );
    assert.equal(list.error, null, "one dead source must not blank the whole store");
    assert.equal(list.sources[1].count, 0);
    assert.ok(list.sources[1].error, "the failure travels next to the source it belongs to");
  } finally {
    a.close();
  }
});

test("an id offered by two registries resolves to the first configured, and names the other", async () => {
  const a = registry([manifestOnly("dup", "FromPrimary", "1.0.0")]);
  const b = registry([manifestOnly("dup", "FromExtra", "2.0.0")]);
  const [urlA, urlB] = [await a.listen(), await b.listen()];
  const config = { rawStore: () => ({ registry: urlA, sources: [urlB] }), appConfig: () => ({}) };
  try {
    const list = await store.listForUi(config)(true);
    const catalogue = list.apps.filter((e) => !e.unlisted);
    assert.equal(catalogue.length, 1, "one id is one row, whatever it is offered by");
    assert.equal(catalogue[0].name, "FromPrimary");
    assert.equal(catalogue[0].version, "1.0.0", "a higher version elsewhere does not win the id");
    assert.deepEqual(
      list.apps[0].alsoIn.map((x) => x.url),
      [urlB],
    );
  } finally {
    a.close();
    b.close();
  }
});

// The one that matters: without the pin, a registry added later could publish a
// higher version under an installed app's id and the nightly auto-update would
// re-install the app from it, unattended and unannounced.
test("an app stays with the registry it was installed from, even when another claims its id", async () => {
  const a = registry([]); // the primary, empty for now
  const b = registry([manifestOnly("brewapp", "Brew", "1.0.0")]);
  const [urlA, urlB] = [await a.listen(), await b.listen()];
  const config = { rawStore: () => ({ registry: urlA, sources: [urlB] }), appConfig: () => ({}) };
  const installedManifest = () => JSON.parse(fs.readFileSync(path.join(TMP, ".tvbox", "apps", "brewapp.json"), "utf8"));
  try {
    assert.equal((await store.install(config, "brewapp")).ok, true);
    assert.equal(installedManifest().name, "Brew");

    // The primary now offers the same id at a much higher version.
    a.state.apps = [manifestOnly("brewapp", "Hijacked", "9.0.0")];
    let list = await store.listForUi(config)(true);
    let catalogue = list.apps.filter((e) => !e.unlisted);
    assert.equal(catalogue.length, 1);
    assert.equal(catalogue[0].name, "Brew", "the pinned source keeps the id");
    assert.equal(catalogue[0].version, "1.0.0");
    assert.equal(catalogue[0].updateAvailable, false, "another registry's version is not an update");
    assert.deepEqual(list.updates, [], "so the nightly auto-update has nothing to act on");
    assert.deepEqual(
      catalogue[0].alsoIn.map((x) => x.url),
      [urlA],
    );

    // ...and a real update, from the pinned source, still works.
    b.state.apps = [manifestOnly("brewapp", "Brew", "1.1.0")];
    list = await store.listForUi(config)(true);
    catalogue = list.apps.filter((e) => !e.unlisted);
    assert.equal(catalogue[0].updateAvailable, true);
    assert.deepEqual(list.updates, ["brewapp"]);
    assert.equal((await store.install(config, "brewapp")).ok, true);
    assert.equal(installedManifest().name, "Brew");
    assert.equal(installedManifest().version, "1.1.0");
    store.uninstall("brewapp");
  } finally {
    a.close();
    b.close();
  }
});

// Unattended updates are the moment a source's trust is spent with nobody
// watching, so they are the source's own setting: an owner can leave the
// official catalogue on it and still review what an added registry ships.
test("the nightly run only offers apps whose registry is on unattended updates", async () => {
  const a = registry([manifestOnly("offapp", "OffApp", "1.0.0")]);
  const b = registry([manifestOnly("brewapp", "Brew", "1.0.0")]);
  const [urlA, urlB] = [await a.listen(), await b.listen()];
  const store_ = { registry: urlA, sources: [{ url: urlB }] };
  const config = { rawStore: () => store_, appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "offapp")).ok, true);
    assert.equal((await store.install(config, "brewapp")).ok, true);
    a.state.apps = [manifestOnly("offapp", "OffApp", "1.1.0")];
    b.state.apps = [manifestOnly("brewapp", "Brew", "1.1.0")];

    let list = await store.listForUi(config)(true);
    assert.deepEqual(list.updates.sort(), ["brewapp", "offapp"], "both are offered to press");
    assert.deepEqual(list.autoUpdates, ["offapp"], "an added registry is not unattended by default");
    assert.equal(list.sources[1].autoUpdate, false);

    store_.sources = [{ url: urlB, autoUpdate: true }];
    list = await store.listForUi(config)(true);
    assert.deepEqual(list.autoUpdates.sort(), ["brewapp", "offapp"]);

    // ...and the primary can be taken off it while an added one stays on.
    store_.autoUpdate = false;
    list = await store.listForUi(config)(true);
    assert.deepEqual(list.autoUpdates, ["brewapp"]);
    store.uninstall("offapp");
    store.uninstall("brewapp");
  } finally {
    a.close();
    b.close();
  }
});

test("an app whose registry was removed is not handed to another one overnight", async () => {
  const a = registry([]);
  const b = registry([manifestOnly("orphan", "Brew", "1.0.0")]);
  const [urlA, urlB] = [await a.listen(), await b.listen()];
  const store_ = { registry: urlA, sources: [{ url: urlB }] };
  const config = { rawStore: () => store_, appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "orphan")).ok, true);
    // The owner drops the registry it came from, and the primary happens to carry
    // the same id at a higher version.
    store_.sources = [];
    a.state.apps = [manifestOnly("orphan", "Official", "2.0.0")];
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((x) => x.id === "orphan");
    assert.equal(e.pinnedElsewhere, true);
    assert.equal(e.updateAvailable, true, "the update is still offered to press");
    assert.deepEqual(list.autoUpdates, [], "...but the box does not take it by itself");
    store.uninstall("orphan");
  } finally {
    a.close();
    b.close();
  }
});

test("sources: the extra registries are capped, deduplicated and scheme-checked", () => {
  const many = Array.from({ length: 15 }, (_, i) => "https://example.test/" + i + "/index.json");
  const cfg = (sources) => ({ rawStore: () => ({ sources }) });
  assert.equal(store.sources(cfg(many)).length, store.MAX_EXTRA_SOURCES + 1, "primary plus the cap");
  assert.equal(store.sources(cfg(["https://a.test/index.json", "https://a.test/index.json"])).length, 2);
  // A public http registry would be an unauthenticated channel for host-side app
  // code, so it is refused here the way the OTA feed refuses one.
  assert.equal(store.sources(cfg(["http://example.test/index.json"])).length, 1);
  assert.equal(store.sources(cfg([])).length, 1);
  assert.equal(store.sources(cfg([]))[0].official, true);
});

// Two caps, one number: config.js drops what it will not store and store.js
// ignores what it will not fetch. They are separate on purpose (a config file
// edited by hand never passes through the form), so this is what keeps them equal.
test("the cap config.js stores is the cap store.js reads", () => {
  const config = require("./config");
  const many = Array.from({ length: 20 }, (_, i) => ({ url: "https://example.test/" + i + "/index.json" }));
  const saved = config.setStore({ sources: many });
  assert.equal(saved.sources.length, store.MAX_EXTRA_SOURCES);
  config.setStore({ sources: [] });
});

test("an unreachable registry says so, instead of 'not in registry'", async () => {
  // Forcing a refresh on install means the registry has to answer. When it does
  // not, the app is not missing - the network is - and saying the wrong one of
  // those sends the next person looking in the wrong place.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-store-off-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    delete require.cache[require.resolve("./store")];
    const fresh = require("./store");
    // A port nothing listens on: the fetch fails rather than answering 404.
    const cfg = { rawStore: () => ({ registry: "http://127.0.0.1:1/index.json" }) };
    const r = await fresh.install(cfg, "anything");
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /registry unreachable/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    delete require.cache[require.resolve("./store")];
  }
});

// Moving an app from one registry to another, on purpose.
//
// The pin exists so a local build cannot be taken over by a published app of the
// same id - which is right, and which also means an app can never LEAVE the
// registry it came from without saying so. This is that sentence: install it
// again, naming where from. Same version included, because a debug build usually
// carries the same number as the published one it is standing in for.
test("install(id, sourceUrl) takes the app from the registry it names, and re-pins to it", async () => {
  const http = require("node:http");
  const entry = (v) => ({
    id: "twoapp",
    name: "Two",
    type: "webclient",
    status: "ready",
    version: v,
    runtime: { serve: "remote", url: "https://example.com" },
  });

  const official = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ registryVersion: 1, apps: [entry("1.0.0")] }));
  });
  const local = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ registryVersion: 1, apps: [entry("1.0.0")] }));
  });
  await new Promise((r) => official.listen(0, "127.0.0.1", r));
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const officialUrl = "http://127.0.0.1:" + official.address().port + "/index.json";
  const localUrl = "http://127.0.0.1:" + local.address().port + "/index.json";
  const config = {
    rawStore: () => ({ registry: officialUrl, sources: [{ url: localUrl, name: "dev" }] }),
    appConfig: () => ({}),
  };

  try {
    // Installed from the primary, as an ordinary install is.
    const first = await store.install(config, "twoapp");
    assert.equal(first.ok, true, "install failed: " + JSON.stringify(first));
    let list = await store.listForUi(config)(true);
    let e = list.apps.find((a) => a.id === "twoapp");
    assert.equal(e.source.url, officialUrl, "the primary is where an unpinned app comes from");
    assert.deepEqual(
      e.alsoIn.map((x) => x.url),
      [localUrl],
      "the other registry is offered, with enough to draw a button",
    );
    assert.equal(e.alsoIn[0].name, "dev");

    // The same version, from the other registry. No version comparison stands in
    // the way, which is what makes a debug build installable over its published
    // twin.
    assert.equal((await store.install(config, "twoapp", localUrl)).ok, true);
    list = await store.listForUi(config)(true);
    e = list.apps.find((a) => a.id === "twoapp");
    assert.equal(e.source.url, localUrl, "it stands with the registry it was last taken from");
    assert.deepEqual(
      e.alsoIn.map((x) => x.url),
      [officialUrl],
    );

    // And back again, which is the half that makes the switch usable rather than
    // a one-way door.
    assert.equal((await store.install(config, "twoapp", officialUrl)).ok, true);
    list = await store.listForUi(config)(true);
    assert.equal(list.apps.find((a) => a.id === "twoapp").source.url, officialUrl);
  } finally {
    store.uninstall("twoapp");
    official.close();
    local.close();
  }
});

test("install() refuses a registry that is not configured, and one that does not have the app", async () => {
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        registryVersion: 1,
        apps: [
          {
            id: "oneapp",
            name: "One",
            type: "webclient",
            status: "ready",
            version: "1.0.0",
            runtime: { serve: "remote", url: "https://example.com" },
          },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + server.address().port + "/index.json";
  const config = { rawStore: () => ({ registry: url }), appConfig: () => ({}) };
  try {
    // A url arriving from a caller is not a source. Trusting one because it was
    // named in an install request would make "add a registry" - the place the
    // decision is supposed to live - a formality.
    const outside = await store.install(config, "oneapp", "https://elsewhere.example/index.json");
    assert.equal(outside.ok, false);
    assert.match(outside.error, /not a configured registry/);

    // And a configured one that simply does not carry it says so, rather than
    // reporting the app missing everywhere.
    const missing = await store.install(config, "nosuch", url);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /does not offer it/);
  } finally {
    server.close();
  }
});

test("a named registry that answered reports its own state, not another one's", async () => {
  // The press was for ONE registry. Another source being down says nothing about
  // it, and answering "unreachable" sends whoever pressed it to look at a
  // registry they did not choose.
  const http = require("node:http");
  const up = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        registryVersion: 1,
        apps: [
          {
            id: "here",
            name: "Here",
            type: "webclient",
            status: "ready",
            version: "1.0.0",
            runtime: { serve: "remote", url: "https://example.com" },
          },
        ],
      }),
    );
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const upUrl = "http://127.0.0.1:" + up.address().port + "/index.json";
  // A source that is configured and answers nothing at all.
  const deadUrl = "http://127.0.0.1:1/index.json";
  const config = {
    rawStore: () => ({ registry: upUrl, sources: [{ url: deadUrl, name: "down" }] }),
    appConfig: () => ({}),
  };

  try {
    const r = await store.install(config, "nothere", upUrl);
    assert.equal(r.ok, false);
    assert.match(r.error, /does not offer it/, "the registry that was named is the one being reported on");
  } finally {
    up.close();
  }
});

test("the registry an app is pinned to stays on offer even when it did not answer", async () => {
  // A local registry is off more often than it is on. Without this the way back
  // disappears exactly when it is needed, while the screen still offers a
  // one-press Update that would re-pin the app to whichever source did answer.
  const http = require("node:http");
  const entry = (name) => ({
    id: "pinapp",
    name,
    type: "webclient",
    status: "ready",
    version: "1.0.0",
    runtime: { serve: "remote", url: "https://example.com" },
  });
  const official = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ registryVersion: 1, apps: [entry("Official")] }));
  });
  const local = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ registryVersion: 1, apps: [entry("Dev")] }));
  });
  await new Promise((r) => official.listen(0, "127.0.0.1", r));
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const officialUrl = "http://127.0.0.1:" + official.address().port + "/index.json";
  const localUrl = "http://127.0.0.1:" + local.address().port + "/index.json";
  const config = {
    rawStore: () => ({ registry: officialUrl, sources: [{ url: localUrl, name: "dev" }] }),
    appConfig: () => ({}),
  };

  try {
    assert.equal((await store.install(config, "pinapp", localUrl)).ok, true);
    // The registry it came from goes away, as a laptop does.
    await new Promise((r) => local.close(r));

    const list = await store.listForUi(config)(true);
    const e = list.apps.find((a) => a.id === "pinapp");
    assert.equal(e.pinnedElsewhere, true, "the screen has to be able to say where it came from");
    assert.ok(
      e.alsoIn.some((x) => x.url === localUrl),
      "the way back is still on offer",
    );
    assert.deepEqual(list.autoUpdates, [], "and the nightly run must not take it back by itself");
  } finally {
    store.uninstall("pinapp");
    official.close();
  }
});

test("a registry that lists one id twice draws one button, not two", async () => {
  // `alsoIn` is registry-controlled UI state: two entries carrying the same url
  // become two buttons with one focus key, of which only one can be pressed.
  const http = require("node:http");
  const one = (name) => ({
    id: "dupe",
    name,
    type: "webclient",
    status: "ready",
    version: "1.0.0",
    runtime: { serve: "remote", url: "https://example.com" },
  });
  const primary = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ registryVersion: 1, apps: [one("Primary")] }));
  });
  const twice = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ registryVersion: 1, apps: [one("A"), one("B"), one("C")] }));
  });
  await new Promise((r) => primary.listen(0, "127.0.0.1", r));
  await new Promise((r) => twice.listen(0, "127.0.0.1", r));
  const primaryUrl = "http://127.0.0.1:" + primary.address().port + "/index.json";
  const twiceUrl = "http://127.0.0.1:" + twice.address().port + "/index.json";
  const config = { rawStore: () => ({ registry: primaryUrl, sources: [{ url: twiceUrl }] }), appConfig: () => ({}) };

  try {
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((a) => a.id === "dupe");
    assert.deepEqual(
      e.alsoIn.map((x) => x.url),
      [twiceUrl],
    );
  } finally {
    primary.close();
    twice.close();
  }
});

// An app nobody offers any more.
//
// It keeps running - the launcher builds its grid from ~/.tvbox/apps and no
// catalogue is consulted - but Remove lives only in a store row, so before this
// a retired app could not be taken off the television at all.

test("an installed app that no source lists still gets a row, marked as unlisted", async () => {
  const r = registry([manifestOnly("goneapp", "GoneApp", "1.0.0")]);
  const url = await r.listen();
  const config = { rawStore: () => ({ registry: url, sources: [] }), appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "goneapp")).ok, true);
    // The registry drops it, the box keeps it.
    r.state.apps = [];
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((a) => a.id === "goneapp");
    assert.ok(e, "an installed app must not vanish from the store just because the registry did");
    assert.equal(e.unlisted, true);
    assert.equal(e.unlistedReason, "retired");
    assert.equal(e.installed, true);
    assert.equal(e.source, null);
    assert.equal(e.updateAvailable, false, "there is nothing to update from");
    assert.equal(e.installedVersion, "1.0.0");
    assert.equal(e.version, "1.0.0", "a version of undefined reaches the screen as 'vundefined'");
    assert.equal(
      e.unlistedFrom,
      null,
      "that registry is still configured and simply stopped offering it - naming it would read as advice to add it back",
    );
    assert.deepEqual(list.updates, [], "not offered as an update");
    assert.deepEqual(list.autoUpdates, []);

    // And it can actually be taken off, which is the whole point.
    assert.equal((await store.uninstall("goneapp")).ok, true);
    const after = await store.listForUi(config)(true);
    assert.equal(
      after.apps.find((a) => a.id === "goneapp"),
      undefined,
    );
  } finally {
    r.close();
  }
});

test("a source that did not answer never makes an app look retired", async () => {
  // The dangerous direction. A registry that failed to load lists nothing, and
  // reading that as "no source offers this" would tell somebody their apps were
  // retired every time the network was down - while the way back is to fix the
  // source that sentence just talked them out of trusting.
  const r = registry([manifestOnly("liveapp", "LiveApp", "1.0.0")]);
  const url = await r.listen();
  const config = { rawStore: () => ({ registry: url, sources: [] }), appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "liveapp")).ok, true);
    r.close();
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((a) => a.id === "liveapp");
    assert.ok(!e || !e.unlisted, "an unreachable registry is not a retirement");
    await store.uninstall("liveapp");
  } finally {
    r.close();
  }
});

test("one source failing still leaves the row, and it does not claim the app was retired", async () => {
  // The other side of the rule above, and the expensive one: a configured
  // registry that is gone for good fails on EVERY refresh, so requiring every
  // source to answer took Remove away for good rather than for the length of an
  // outage. Measured on both boxes here - a dev registry left on the source
  // list hid two retired apps permanently.
  const main = registry([manifestOnly("stuckapp", "StuckApp", "1.0.0")]);
  const dev = registry([]);
  const [mainUrl, devUrl] = [await main.listen(), await dev.listen()];
  const config = {
    rawStore: () => ({ registry: mainUrl, sources: [{ url: devUrl, name: "Dev" }] }),
    appConfig: () => ({}),
  };
  try {
    assert.equal((await store.install(config, "stuckapp")).ok, true);
    main.state.apps = [];
    dev.close();
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((a) => a.id === "stuckapp");
    assert.ok(e, "the row is where Remove lives, and one unreachable registry must not take it away");
    assert.equal(e.unlisted, true);
    assert.equal(e.unlistedReason, "unchecked", "a source that did not answer cannot be read as a retirement");
    assert.equal(e.installed, true);
    assert.equal(e.updateAvailable, false);
    assert.equal(e.installedVersion, "1.0.0");
    assert.equal(e.unlistedFrom, null, "the registry to look at is the one that failed, not one to add back");
    assert.deepEqual(list.updates, []);
    assert.equal(list.error, null, "one source of two failing is not the catalogue failing");
    assert.equal((await store.uninstall("stuckapp")).ok, true);
  } finally {
    // Cleanup belongs here as well as in the assertion above: an assertion that
    // fails earlier would otherwise leave the app installed, and an installed
    // app is exactly what the later tests in this file have to see.
    await store.uninstall("stuckapp");
    main.close();
    dev.close();
  }
});

test("with every source down the row stays away, because that is a passing outage", async () => {
  // The launcher swaps the whole list for a retry screen when nothing answered,
  // so a row here would not be seen - and "this box cannot tell" is a sentence
  // about a catalogue that loaded, not about a box with no network.
  const only = registry([manifestOnly("darkapp", "DarkApp", "1.0.0")]);
  const url = await only.listen();
  const config = { rawStore: () => ({ registry: url, sources: [] }), appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "darkapp")).ok, true);
    only.close();
    const list = await store.listForUi(config)(true);
    assert.ok(list.error, "every source failing is the catalogue failing");
    const e = list.apps.find((a) => a.id === "darkapp");
    assert.ok(!e || !e.unlisted, "nothing about the app is knowable, so nothing is claimed");
  } finally {
    await store.uninstall("darkapp");
    only.close();
  }
});

test("the registry it came from is named only when the box no longer has it", async () => {
  // The half that turns the screen from a dead end into an action - and only
  // then, because the usual case is a registry that is still configured and has
  // simply dropped the app.
  const gone = registry([manifestOnly("movedapp", "MovedApp", "1.0.0")]);
  const main = registry([]);
  const [goneUrl, mainUrl] = [await gone.listen(), await main.listen()];
  let sources = [{ url: goneUrl, name: "Dev" }];
  const config = { rawStore: () => ({ registry: mainUrl, sources }), appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "movedapp")).ok, true);
    // The owner removes that source from the box.
    sources = [];
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((a) => a.id === "movedapp");
    assert.equal(e.unlisted, true);
    assert.equal(e.unlistedFrom, goneUrl, "adding that registry back is what would make it updatable again");
    await store.uninstall("movedapp");
  } finally {
    gone.close();
    main.close();
  }
});

test("an app this box refuses to read keeps a row, and is not called retired", async () => {
  // A refusal is not an absence, and it is not silence either. The likeliest
  // reasons are forward-compatible - a manifestVersion or a capability a box
  // does not know yet - so calling it retired would tell every older box in the
  // field that the app is gone. But dropping the row instead takes Remove with
  // it, which is the one thing this list exists to keep reachable: measured,
  // that left an installed app that could not be taken off the television at
  // all, which is the state the feature was written to fix.
  const r = registry([manifestOnly("newapp", "NewApp", "1.0.0")]);
  const url = await r.listen();
  const config = { rawStore: () => ({ registry: url, sources: [] }), appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "newapp")).ok, true);
    r.state.apps = [{ ...manifestOnly("newapp", "NewApp", "2.0.0"), manifestVersion: 99 }];
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((a) => a.id === "newapp");
    assert.ok(e, "no row means no Remove, and it is installed");
    assert.equal(e.unlistedReason, "unreadable", "the sentence is about this box, not about the app being gone");
    assert.equal(e.unlistedFrom, null, "a registry still serving it is not somewhere to send anyone");
    assert.equal((await store.uninstall("newapp")).ok, true, "and it can actually be taken off");
  } finally {
    r.close();
  }
});

test("a trust refusal is not dressed up as a version skew", async () => {
  // The box refused this one ON PURPOSE, and no amount of updating it will
  // change that - so it must not be told that updating might bring the app
  // back. Same row, same Remove, different sentence.
  const r = registry([manifestOnly("trustapp", "TrustApp", "1.0.0")]);
  const url = await r.listen();
  const config = { rawStore: () => ({ registry: url, sources: [] }), appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "trustapp")).ok, true);
    r.state.apps = [
      { ...manifestOnly("trustapp", "TrustApp", "2.0.0"), requires: { aptRepo: { uri: "http://x", key: "k" } } },
    ];
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((a) => a.id === "trustapp");
    assert.ok(e, "still removable");
    assert.equal(e.unlistedReason, "blocked");
    await store.uninstall("trustapp");
  } finally {
    r.close();
  }
});

test("a refusal keeps its row even while another source is unreachable", async () => {
  // Whether this box can read an app is answered by the source that DID reply.
  // Waiting for the ones that did not cost the row - and the row is where
  // Remove lives, so the app became unremovable from the television.
  const a = registry([manifestOnly("mixapp", "MixApp", "1.0.0")]);
  const b = registry([]);
  const [urlA, urlB] = [await a.listen(), await b.listen()];
  const config = {
    rawStore: () => ({ registry: urlA, sources: [{ url: urlB, name: "Other" }] }),
    appConfig: () => ({}),
  };
  try {
    assert.equal((await store.install(config, "mixapp")).ok, true);
    a.state.apps = [{ ...manifestOnly("mixapp", "MixApp", "2.0.0"), manifestVersion: 99 }];
    b.close();
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((a2) => a2.id === "mixapp");
    assert.ok(e, "one silent source must not take the row away");
    assert.equal(e.unlistedReason, "unreadable");
    await store.uninstall("mixapp");
  } finally {
    a.close();
  }
});

test("an unchecked row groups with the other reasons rather than among them", async () => {
  // `unchecked` and `retired` can never share a list - one needs every source
  // to have answered and the other needs one not to have - but `unchecked`,
  // `unreadable` and `blocked` do share one, because a refusal is knowable from
  // the source that DID answer.
  const a = registry([
    manifestOnly("eee", "Eee", "1.0.0"),
    manifestOnly("fff", "Fff", "1.0.0"),
    manifestOnly("ggg", "Ggg", "1.0.0"),
  ]);
  const dead = registry([]);
  const [aUrl, deadUrl] = [await a.listen(), await dead.listen()];
  const config = {
    rawStore: () => ({ registry: aUrl, sources: [{ url: deadUrl, name: "Dev" }] }),
    appConfig: () => ({}),
  };
  try {
    for (const id of ["eee", "fff", "ggg"]) assert.equal((await store.install(config, id)).ok, true);
    // eee unchecked (nobody lists it), fff unreadable, ggg blocked.
    a.state.apps = [
      { ...manifestOnly("fff", "Fff", "2.0.0"), manifestVersion: 99 },
      { ...manifestOnly("ggg", "Ggg", "2.0.0"), requires: { aptRepo: { uri: "http://x", key: "k" } } },
    ];
    dead.close();
    const list = await store.listForUi(config)(true);
    const reasons = list.apps.filter((x) => x.unlisted).map((x) => x.unlistedReason);
    const runs = reasons.filter((x, i) => x !== reasons[i - 1]);
    assert.deepEqual(runs, [...new Set(reasons)], "one run per reason, so the panel draws each heading once");
    assert.deepEqual(runs, ["unchecked", "unreadable", "blocked"]);
  } finally {
    for (const id of ["eee", "fff", "ggg"]) await store.uninstall(id);
    a.close();
    dead.close();
  }
});

test("a registry the box no longer has is still named when a different source is down", async () => {
  // The suppression this nearly grew: "installed from X" is a plain fact, and
  // source Y failing says nothing about X. Naming X is the only thing that
  // turns the screen into an action, so it must survive an unrelated outage.
  const gone = registry([manifestOnly("fromapp", "FromApp", "1.0.0")]);
  const main = registry([]);
  const dead = registry([]);
  const [goneUrl, mainUrl, deadUrl] = [await gone.listen(), await main.listen(), await dead.listen()];
  let sources = [{ url: goneUrl, name: "Old" }];
  const config = { rawStore: () => ({ registry: mainUrl, sources }), appConfig: () => ({}) };
  try {
    assert.equal((await store.install(config, "fromapp")).ok, true);
    // The owner removes the registry it came from, and an unrelated one is down.
    sources = [{ url: deadUrl, name: "Dev" }];
    dead.close();
    const list = await store.listForUi(config)(true);
    const e = list.apps.find((x) => x.id === "fromapp");
    assert.equal(e.unlistedReason, "unchecked");
    assert.equal(e.unlistedFrom, goneUrl, "adding that registry back is still what would make it updatable");
  } finally {
    await store.uninstall("fromapp");
    gone.close();
    main.close();
    dead.close();
  }
});

test("the rows nobody offers arrive grouped by reason, not interleaved", async () => {
  // The panel draws one heading when the reason changes, so an id-sorted mix
  // put the same heading on screen three times - and a heading is the largest
  // text there. Grouping belongs here, where the list is built.
  const r = registry([
    manifestOnly("aaa", "Aaa", "1.0.0"),
    manifestOnly("bbb", "Bbb", "1.0.0"),
    manifestOnly("ccc", "Ccc", "1.0.0"),
    manifestOnly("ddd", "Ddd", "1.0.0"),
  ]);
  const url = await r.listen();
  const config = { rawStore: () => ({ registry: url, sources: [] }), appConfig: () => ({}) };
  try {
    for (const id of ["aaa", "bbb", "ccc", "ddd"]) assert.equal((await store.install(config, id)).ok, true);
    // aaa retired, bbb unreadable, ccc retired, ddd blocked - alphabetically
    // interleaved on purpose.
    r.state.apps = [
      { ...manifestOnly("bbb", "Bbb", "2.0.0"), manifestVersion: 99 },
      { ...manifestOnly("ddd", "Ddd", "2.0.0"), requires: { aptRepo: { uri: "http://x", key: "k" } } },
    ];
    const list = await store.listForUi(config)(true);
    const reasons = list.apps.filter((a) => a.unlisted).map((a) => a.unlistedReason);
    const runs = reasons.filter((x, i) => x !== reasons[i - 1]);
    assert.deepEqual(
      runs,
      [...new Set(reasons)],
      "each reason appears in one run, so the panel draws each heading once",
    );
    assert.deepEqual(runs, ["retired", "unreadable", "blocked"], "and in that order, worst-explained last");
    const firstUnlisted = list.apps.findIndex((a) => a.unlisted);
    assert.ok(
      list.apps.slice(0, firstUnlisted).every((a) => !a.unlisted),
      "the catalogue stays ahead of the tail - the sort must not reach into it",
    );
    for (const id of ["aaa", "bbb", "ccc", "ddd"]) await store.uninstall(id);
  } finally {
    r.close();
  }
});
