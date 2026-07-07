// tvbox app store - a git-hosted registry: one index.json of vetted app
// manifests (built by the tvbox-apps repo's CI). "Installing" a store app just
// writes its manifest to ~/.tvbox/apps/<id>.json - the tile appears live via
// the manifest reload on /tvbox/api/apps; bundles/deps then follow the normal
// opt-in paths (UI install, `tvbox deps`).
const fs = require("fs");
const path = require("path");
const apps = require("./install");

const DEFAULT_REGISTRY = "https://raw.githubusercontent.com/Andy1210/tvbox-apps/main/index.json";
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, url: null, entries: null, error: null };

function registryUrl(config) {
  // The override is the box owner's own config.json entry - plain http is
  // allowed there (self-hosted LAN registry); the shipped default is https.
  const s = config.rawStore() || {};
  return typeof s.registry === "string" && /^https?:\/\//.test(s.registry) ? s.registry : DEFAULT_REGISTRY;
}

// The registry is CURATED (every app is merge-reviewed - the review is the
// trust boundary, like Kodi's official repo), so a store app MAY carry a
// `service` plugin (host Node code) - it ships in the app PACKAGE alongside its
// web/ UI. Every app is a `webclient` package now. The one hard line - enforced
// on fetch AND install - is `aptRepo`: a third-party root apt source is risky
// and avoidable (`requires.download` instead). In sync with build-index.mjs.
function trustErrors(m) {
  const errs = [];
  if (m.requires && m.requires.aptRepo) errs.push("requires.aptRepo (use requires.download)");
  if (m.type !== "webclient") errs.push("type must be webclient");
  return errs;
}

async function fetchIndex(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const idx = await res.json();
    if (!idx || idx.registryVersion !== 1 || !Array.isArray(idx.apps)) throw new Error("bad index shape");
    // Optional per-app PACKAGE descriptors: { <id>: { files: [{path, sha256}] } }.
    // An app WITH a package ships code/UI (plugin.js + web/…) installed into
    // ~/.tvbox/apps/<id>/; an app WITHOUT one is manifest-only (remote webclient,
    // or a bundle fetched by its own install recipe). Attached non-enumerably so
    // it threads to install() without ever reaching a written manifest.
    const packages = idx.packages && typeof idx.packages === "object" ? idx.packages : {};
    const out = [];
    for (const m of idx.apps) {
      const valid = apps.validateManifest(m, "registry:" + (m && m.id));
      if (!valid) continue;
      const errs = trustErrors(valid);
      if (errs.length) {
        console.warn("[store] skip", valid.id, "-", errs.join("; "));
        continue;
      }
      const pkg = packages[valid.id];
      if (pkg && Array.isArray(pkg.files) && pkg.files.length) {
        Object.defineProperty(valid, "_pkg", { value: { files: pkg.files }, enumerable: false });
      }
      out.push(valid);
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

async function getEntries(config, refresh) {
  const url = registryUrl(config);
  if (!refresh && cache.url === url && Date.now() - cache.at < CACHE_MS && cache.entries) return cache;
  try {
    cache = { at: Date.now(), url, entries: await fetchIndex(url), error: null };
  } catch (e) {
    console.warn("[store] registry fetch failed:", e.message);
    cache = { at: Date.now(), url, entries: null, error: String(e.message || e).slice(0, 120) };
  }
  return cache;
}

// Is version a > b? major.minor.patch, missing parts = 0, non-numeric ignored.
// Drives the store's "update available" flag: registry version vs installed.
function verGt(a, b) {
  const pa = String(a || "0")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function storeManifestPath(id) {
  return path.join(apps.USER_APPS_DIR, id + ".json");
}
function packageDir(id) {
  return path.join(apps.USER_APPS_DIR, id);
}
// A store install is EITHER a single manifest file (~/.tvbox/apps/<id>.json) or
// a package directory (~/.tvbox/apps/<id>/manifest.json). Either counts.
function installedFromStore(id) {
  return fs.existsSync(storeManifestPath(id)) || fs.existsSync(path.join(packageDir(id), "manifest.json"));
}

// What the launcher's Store panel renders. `installed` covers only the
// store-managed file; `builtin` flags a registry id that ships with the box
// (not installable, would be shadowed anyway).
function listForUi(config) {
  return async (refresh) => {
    const { entries, error, url } = await getEntries(config, refresh);
    apps.loadManifests();
    const builtinIds = new Set(
      apps
        .getManifests()
        .filter((m) => !m._dir && !installedFromStore(m.id))
        .map((m) => m.id),
    );
    const out = (entries || []).map((m) => {
      const rt = m.runtime || {};
      const { missing } = apps.appDeps(m);
      const installed = installedFromStore(m.id);
      // The registry's version vs what's on disk: apps.manifestById reads the
      // INSTALLED manifest (a package app's own manifest.json, or the stored
      // single-json). updateAvailable drives the store's "Update" affordance;
      // an app updates from the registry independently of any tvbox/shell release.
      const version = m.version || "0.0.0";
      const installedVersion = installed ? (apps.manifestById(m.id) || {}).version || "0.0.0" : null;
      return {
        id: m.id,
        name: m.name,
        tagline: m.tagline,
        icon: m.icon,
        accent: m.accent,
        installed,
        builtin: builtinIds.has(m.id),
        version,
        installedVersion,
        updateAvailable: !!(installed && verGt(version, installedVersion)),
        changelog: Array.isArray(m.changelog) ? m.changelog : [], // [{version, notes}] (English), newest-first - for the store detail view
        urlConfig: rt.urlConfig || null,
        baseUrl: rt.urlConfig ? (config.appConfig(rt.urlConfig) || {}).baseUrl || "" : "",
        missing,
      };
    });
    const updates = out.filter((a) => a.updateAvailable).map((a) => a.id);
    return { registry: url, apps: out, error, updates };
  };
}

async function install(config, id) {
  const { entries, url } = await getEntries(config, false);
  const m = (entries || []).find((x) => x.id === id);
  if (!m) return { ok: false, error: "not in registry" };
  const errs = trustErrors(m);
  if (errs.length) return { ok: false, error: errs.join("; ") };
  apps.loadManifests();
  const existing = apps.manifestById(id);
  if (existing && !existing._dir && !installedFromStore(id)) return { ok: false, error: "built-in app" };
  if (m._pkg) {
    // Package app: fetch the whole dir (manifest.json + plugin.js + web/…) that
    // sits next to the index under apps/<id>/, each file sha256-verified. base
    // inherits the registry's host + scheme (same trust as the index fetch).
    const base = new URL("apps/" + id + "/", url).toString();
    try {
      await apps.installPackage(id, base, m._pkg.files, (s) => console.log("[store]", id, s));
    } catch (e) {
      return { ok: false, error: "package install failed: " + (e && e.message ? e.message : String(e)) };
    }
    console.log("[store] installed package:", id);
  } else {
    fs.mkdirSync(apps.USER_APPS_DIR, { recursive: true });
    fs.writeFileSync(storeManifestPath(id), JSON.stringify(m, null, 2) + "\n");
    console.log("[store] installed manifest:", id);
  }
  // The tile appears live (manifests reload per /apps request), but a `service`
  // plugin only loads at boot - the caller restarts (gated) to activate it. Read
  // the flag from the INSTALLED manifest (a package's own manifest.json is
  // authoritative), not the index entry, so the restart decision can't disagree
  // with what loadPlugins will actually run.
  apps.loadManifests();
  const installed = apps.manifestById(id);
  return { ok: true, service: !!(installed && installed.service) };
}

function uninstall(id) {
  if (!/^[a-z0-9_-]+$/.test(String(id || ""))) return { ok: false, error: "bad id" };
  if (!installedFromStore(id)) return { ok: false, error: "not a store app" };
  fs.rmSync(storeManifestPath(id), { force: true }); // single-manifest form
  fs.rmSync(packageDir(id), { recursive: true, force: true }); // package-dir form
  apps.removeApp(id); // drop any downloaded bundle too
  console.log("[store] removed:", id);
  return { ok: true };
}

module.exports = { listForUi, install, uninstall, trustErrors, verGt, DEFAULT_REGISTRY };
