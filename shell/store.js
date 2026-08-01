// tvbox app store - a curated registry: one index.json of vetted app manifests,
// BUILT AND PUBLISHED by the tvbox-apps repo's CI (it compiles every app from
// source on merge and deploys the result; nothing there is a committed
// snapshot). "Installing" a store app just
// writes its manifest to ~/.tvbox/apps/<id>.json - the tile appears live via
// the manifest reload on /tvbox/api/apps; bundles/deps then follow the normal
// opt-in paths (UI install, `tvbox deps`).
const fs = require("fs");
const path = require("path");
const apps = require("./install");
const flatpak = require("./flatpak");
const { isAllowedFetchUrl, guardedFetch } = require("./netguard"); // https anywhere, or LAN http; re-guards redirects

// The registry's own https URL. Package files are fetched RELATIVE to it
// (`new URL("apps/<id>/", url)` in install()), so the whole registry moves by
// changing this one string - which is how it moved off GitHub raw and onto the
// repo's Pages site, where CI publishes what it built rather than what someone
// remembered to commit.
const DEFAULT_REGISTRY = "https://andy1210.github.io/tvbox-apps/index.json";
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, url: null, entries: null, error: null };

function registryUrl(config) {
  // The override is the box owner's own config.json entry: https anywhere, or
  // plain http ONLY to a self-hosted LAN registry (never a public http host).
  // The shipped default is https.
  const s = config.rawStore() || {};
  return typeof s.registry === "string" && isAllowedFetchUrl(s.registry) ? s.registry : DEFAULT_REGISTRY;
}

// The registry is CURATED (every app is merge-reviewed - the review is the
// trust boundary, like Kodi's official repo), so a store app MAY carry a
// `service` plugin (host Node code) - it ships in the app PACKAGE alongside its
// web/ UI. `native` apps are allowed for the same reason: launching a flathub app
// the manifest names is no more powerful than the host-process Node code a
// `service` package already brings, and refusing them here would mean a native
// app could only ever be installed by hand. The one hard line - enforced on fetch
// AND install - is `aptRepo`: a third-party root apt source is risky and
// avoidable (`requires.download` instead). In sync with build-index.mjs.
const STORE_TYPES = ["webclient", "native"];
function trustErrors(m) {
  const errs = [];
  if (m.requires && m.requires.aptRepo) errs.push("requires.aptRepo (use requires.download)");
  if (!STORE_TYPES.includes(m.type)) errs.push("type must be " + STORE_TYPES.join("|"));
  return errs;
}

// `bust` gives the URL a query the CDN edge has never seen. `cache: "no-store"`
// below only speaks to this process's own cache; a registry on a CDN (GitHub
// Pages caches for ten minutes) will otherwise happily answer a "refresh" with
// the copy it already has, which is not what a caller asking to refresh wants.
// Unique per call: two refreshes inside one millisecond would otherwise share a
// URL, and the second would be served the copy the first just put in the edge.
function cacheBuster() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function fetchIndex(url, bust) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const u = new URL(url);
    if (bust) u.searchParams.set("_", cacheBuster());
    const res = await guardedFetch(u.toString(), { signal: ctl.signal, cache: "no-store" });
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
    cache = { at: Date.now(), url, entries: await fetchIndex(url, !!refresh), error: null };
  } catch (e) {
    console.warn("[store] registry fetch failed:", e.message);
    cache = { at: Date.now(), url, entries: null, error: String(e.message || e).slice(0, 120) };
  }
  return cache;
}

// Is version a > b? Semver-ish precedence: numeric major.minor.patch first,
// then prerelease handling - a version WITHOUT a prerelease outranks the same
// core WITH one (1.2.0 > 1.2.0-beta.1), and two prereleases compare identifier
// by identifier (numeric compared as numbers and ranked below non-numeric per
// semver; a shorter prerelease is lower). Build metadata (+...) is ignored.
// Drives the store's "update available" flag: registry version vs installed.
// Compare two numeric identifier strings without precision loss (parseInt rounds
// past Number.MAX_SAFE_INTEGER, so 9007199254740993 and 9007199254740992 would
// tie). Non-numeric input sorts as 0. Longer (leading zeros stripped) wins; equal
// length compares lexically. Returns <0 / 0 / >0.
function cmpNum(a, b) {
  const norm = (s) => (/^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : "0");
  const x = norm(a);
  const y = norm(b);
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}
function parseVer(v) {
  const s = String(v || "0")
    .trim()
    .split("+")[0]; // drop build metadata
  const dash = s.indexOf("-");
  const core = dash === -1 ? s : s.slice(0, dash);
  const pre = dash === -1 ? null : s.slice(dash + 1).split(".");
  return { core: core.split("."), pre };
}
function verGt(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  for (let i = 0; i < 3; i++) {
    const c = cmpNum(pa.core[i] || "0", pb.core[i] || "0");
    if (c) return c > 0;
  }
  if (!pa.pre && !pb.pre) return false;
  if (!pa.pre) return true; // release > prerelease
  if (!pb.pre) return false; // prerelease < release
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return false; // shorter prerelease is lower
    if (y === undefined) return true;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return cmpNum(x, y) > 0;
    if (xn !== yn) return !xn; // numeric identifiers rank below non-numeric
    return x > y;
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
    // One `flatpak list` for the whole panel: a flatpak-backed app carries a
    // second version that the registry knows nothing about, and its update path
    // is `flatpak update` rather than a manifest bump.
    const fps = await flatpak.list();
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
        description: m.description || null, // longer store-detail copy (string or {hu,en})
        screenshots: Array.isArray(m.screenshots) ? m.screenshots.filter((s) => /^https:\/\//.test(s)) : [], // https-only
        icon: m.icon,
        accent: m.accent,
        installed,
        builtin: builtinIds.has(m.id),
        version,
        installedVersion,
        updateAvailable: !!(installed && verGt(version, installedVersion)),
        changelog: Array.isArray(m.changelog) ? m.changelog : [], // [{version, notes}] (English), newest-first - for the store detail view
        // the flatpaks this app is: what it RUNS (RetroArch) or what its bundle was
        // extracted FROM (Plex). version is null when the ref isn't installed.
        flatpaks: flatpak.refsFor(m).map((f) => ({
          ref: f.ref,
          name: flatpak.shortName(f.ref),
          version: (fps.get(f.ref) || {}).version || null,
        })),
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
  // REFRESH, not the cached copy. The file list and its sha256s come from the
  // index while the files come from the registry live, so an index even a few
  // minutes old can describe a package that has since been republished - and the
  // install then fails on a hash mismatch that looks like a corrupt download.
  // Measured on a box: a registry published between the store listing and the
  // install did exactly that. An install is deliberate and rare; one fetch to
  // make the two agree is the cheapest correctness there is.
  const { entries, url, error } = await getEntries(config, true);
  // Say WHY when the refresh itself failed. Forcing a refresh means an install
  // needs the registry to answer - it needed the network for the files anyway -
  // and reporting an unreachable registry as "not in registry" sends whoever
  // debugs a failed auto-update looking for a missing app.
  if (!entries) return { ok: false, error: "registry unreachable: " + (error || "unknown") };
  const m = entries.find((x) => x.id === id);
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
    // An app can GROW from a single manifest into a package (Plex did, to carry
    // its own bridge). Both forms live under ~/.tvbox/apps/ and loadManifests
    // walks that dir, so leaving the old <id>.json behind would make two
    // manifests claim one id and let readdir order decide which one wins.
    // recursive as well as force: rmSync throws on a directory without it, and
    // "<id>.json is somehow a directory" must not be what breaks an install.
    fs.rmSync(storeManifestPath(id), { recursive: true, force: true });
    console.log("[store] installed package:", id);
  } else {
    fs.mkdirSync(apps.USER_APPS_DIR, { recursive: true });
    fs.writeFileSync(storeManifestPath(id), JSON.stringify(m, null, 2) + "\n");
    fs.rmSync(packageDir(id), { recursive: true, force: true }); // ...and the other way round
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
