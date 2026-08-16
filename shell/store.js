// tvbox app store - one or more registries of app manifests, merged into a
// single catalogue. The official index.json is BUILT AND PUBLISHED by the
// tvbox-apps repo's CI (it compiles every app from source on merge and deploys
// the result; nothing there is a committed snapshot). "Installing" a store app
// just writes its manifest to ~/.tvbox/apps/<id>.json - the tile appears live
// via the manifest reload on /tvbox/api/apps; bundles/deps then follow the
// normal opt-in paths (UI install, `tvbox deps`).
//
// An added registry is trusted like the official one, because the box has no way
// to make it safer: a manifest-only remote webclient already gets an origin on
// the box and the `fetch` broker, so a second, weaker install path would promise
// a safety it cannot deliver. The trust decision is therefore made ONCE, by the
// owner, when the source is added (the launcher warns there), the same contract
// an apt source or a Kodi repository has. What the box still owes that owner is
// bookkeeping, and that is what the pins below are for.
const fs = require("fs");
const path = require("path");
const apps = require("./install");
const flatpak = require("./flatpak");
const { isAllowedFetchUrl, guardedFetch } = require("./netguard"); // https anywhere, or LAN http; re-guards redirects

// The official registry's own https URL. Package files are fetched RELATIVE to
// the index they came from (`new URL("apps/<id>/", sourceUrl)` in install()), so
// a registry moves by changing its URL alone - which is how this one moved off
// GitHub raw and onto the repo's Pages site, where CI publishes what it built
// rather than what someone remembered to commit.
const DEFAULT_REGISTRY = "https://andy1210.github.io/tvbox-apps/index.json";
// Extra registries beyond the primary one. Bounded because every source is a
// fetch on every store open, and a TV panel that waits on eleven of them reads
// as a broken store rather than a slow one.
const MAX_EXTRA_SOURCES = 10;
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { at, entries, error }

// The configured registries in precedence order. The primary is the official
// index unless `config.store.registry` replaces it (a self-hoster pointing the
// box at their own), and `config.store.sources` are merged after it.
// Both are held to the same rule as the OTA feed: https anywhere, or plain http
// ONLY to a LAN registry, never a public http host that anyone in the path could
// answer for.
function sources(config) {
  const s = (config.rawStore && config.rawStore()) || {};
  const primary = typeof s.registry === "string" && isAllowedFetchUrl(s.registry) ? s.registry : DEFAULT_REGISTRY;
  // `official` is what the launcher warns on, so it means "the index this
  // release ships", not "the primary one" - a self-hosted replacement of the
  // primary is somebody's own registry and is labelled as such.
  // Unattended updates are per source, and the two defaults differ on purpose.
  // The nightly run installs whatever a registry publishes, without anyone
  // present, so it is the one place where "I trusted this source once" turns
  // into "this source may replace code on the box tonight". The primary keeps
  // the box's existing behaviour; an ADDED source has to be turned on by hand,
  // which is what lets an owner run the official catalogue unattended and still
  // review what a homebrew registry ships.
  const out = [
    { url: primary, official: primary === DEFAULT_REGISTRY, name: null, autoUpdate: s.autoUpdate !== false },
  ];
  const seen = new Set([primary]);
  for (const e of Array.isArray(s.sources) ? s.sources : []) {
    const url = typeof e === "string" ? e : e && typeof e.url === "string" ? e.url : "";
    if (!url || seen.has(url) || !isAllowedFetchUrl(url)) continue;
    seen.add(url);
    const name = e && typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 60) : null;
    out.push({ url, official: false, name, autoUpdate: (e && e.autoUpdate) === true });
    if (out.length > MAX_EXTRA_SOURCES) break;
  }
  return out;
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

async function fetchSource(src, refresh) {
  const c = cache.get(src.url);
  if (!refresh && c && Date.now() - c.at < CACHE_MS && c.entries) return c;
  let next;
  try {
    next = { at: Date.now(), entries: await fetchIndex(src.url, !!refresh), error: null };
  } catch (e) {
    console.warn("[store] registry fetch failed:", src.url, "-", e.message);
    next = { at: Date.now(), entries: null, error: String(e.message || e).slice(0, 120) };
  }
  cache.set(src.url, next);
  return next;
}

// Every configured source, fetched in parallel and reported one by one: a
// registry that is slow, gone or serving nonsense must cost the catalogue its
// own apps and nothing else. The panel showing a partial list with a named
// failure beats an empty screen that blames the whole store.
async function loadAll(config, refresh) {
  const srcs = sources(config);
  const states = await Promise.all(srcs.map((s) => fetchSource(s, refresh)));
  return srcs.map((s, i) => ({ ...s, entries: states[i].entries, error: states[i].error }));
}

// ---- which source an installed app came from ----
// Recorded next to the app's data rather than in its manifest: a package app's
// manifest.json is the registry's file, byte for byte, and is replaced whole on
// every update. Same directory and shape as install.js's bundle-source record.
const PIN_DIR = path.join(apps.APPS_DATA, ".registry");
function pinPath(id) {
  return path.join(PIN_DIR, id + ".json");
}
function readPin(id) {
  try {
    const p = JSON.parse(fs.readFileSync(pinPath(id), "utf8"));
    return p && typeof p.url === "string" ? p.url : null;
  } catch (e) {
    return null; // an app installed before this bookkeeping, or removed since
  }
}
// Every pin there is, in one directory read. The alternative - asking per
// catalogue row - is a failed open for each of the apps that were never
// installed, on a list the launcher polls every 1.5s while an install runs.
function readPins() {
  const out = new Map();
  let names;
  try {
    names = fs.readdirSync(PIN_DIR);
  } catch (e) {
    return out; // no app on this box has been installed from a registry yet
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const url = readPin(n.slice(0, -5));
    if (url) out.set(n.slice(0, -5), url);
  }
  return out;
}
function writePin(id, url) {
  try {
    fs.mkdirSync(PIN_DIR, { recursive: true });
    fs.writeFileSync(pinPath(id), JSON.stringify({ v: 1, url, at: Date.now() }));
    return true;
  } catch (e) {
    console.warn("[store]", id, "could not record which registry it came from:", e.message);
    return false;
  }
}

// One catalogue out of several registries. An id that more than one source
// offers resolves in a fixed order, and the order is the contract:
//
//   1. the source the app was INSTALLED from, while that source is still
//      configured. This is what keeps an id from changing hands: a second
//      registry publishing a higher version under an installed app's id would
//      otherwise be picked up by the nightly auto-update, which re-installs
//      through this very list without anyone pressing anything.
//   2. otherwise the configured order, primary first.
//
// The losing candidates are not hidden: `alsoIn` names their sources, so the
// detail view can say that another registry carries the same app.
function mergeSources(loaded) {
  const candidates = new Map(); // id -> [{ entry, source }]
  for (const s of loaded) {
    for (const m of s.entries || []) {
      const list = candidates.get(m.id) || [];
      list.push({ entry: m, source: s });
      candidates.set(m.id, list);
    }
  }
  const chosen = new Map();
  const pins = readPins();
  for (const [id, list] of candidates) {
    const pin = pins.get(id);
    const c = (pin && list.find((x) => x.source.url === pin)) || list[0];
    chosen.set(id, {
      ...c,
      // Enough to draw a button, not just to name a source in prose: a person
      // switching an app to their own registry needs to press something, and a
      // url alone is neither a label nor a target.
      alsoIn: (() => {
        // One entry per SOURCE, not per listing: a registry that lists the same
        // id twice would otherwise draw two buttons carrying the same url - and
        // two React children with one key, of which only one can be reached
        // with a remote.
        const seen = new Set();
        const out = [];
        for (const x of list) {
          if (x === c || seen.has(x.source.url)) continue;
          seen.add(x.source.url);
          out.push({ url: x.source.url, name: x.source.name || null, official: !!x.source.official });
        }
        // The registry it is PINNED to belongs here even when it did not answer
        // this time: a local registry is off more often than it is on, and
        // without this the way back disappears exactly when somebody needs it -
        // while the screen still offers a one-press Update that would re-pin the
        // app to whichever source did answer.
        if (pin && pin !== c.source.url && !seen.has(pin)) {
          const src = (loaded || []).find((s2) => s2.url === pin);
          if (src) out.push({ url: pin, name: src.name || null, official: !!src.official, silent: true });
        }
        return out;
      })(),
      // The app was installed from a registry that is no longer configured, and
      // what is on offer here comes from a different one. Removing a source does
      // not remove its apps, so this is an ordinary state - but it must not be an
      // unattended handover: whoever presses Update accepts the new origin, and
      // the install re-pins to it.
      pinnedElsewhere: !!pin && pin !== c.source.url,
    });
  }
  // Emit in source order, and within a source in the order its index lists them:
  // the official catalogue keeps the order it publishes, and an added registry's
  // apps follow it instead of being interleaved by name.
  const out = [];
  for (const s of loaded) {
    for (const m of s.entries || []) {
      const c = chosen.get(m.id);
      if (c && c.source.url === s.url && c.entry === m) out.push(c);
    }
  }
  return out;
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
    const loaded = await loadAll(config, refresh);
    const entries = mergeSources(loaded);
    // `error` is the whole catalogue failing, not one registry of several: the
    // launcher swaps the list for a retry screen on it, and it must not do that
    // while there are apps to show. A single source's failure travels in
    // `sources` instead, next to the name of the source it belongs to.
    const failed = loaded.find((s) => s.error);
    const error = failed && !loaded.some((s) => s.entries) ? failed.error : null;
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
    const out = entries.map(({ entry: m, source, alsoIn, pinnedElsewhere }) => {
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
        // Where this entry came from, and which other registries carry the same
        // id. Both are shown: an app from an added source is the owner's own
        // trust decision, and it has to stay visible after the moment they made it.
        source: { url: source.url, official: source.official, name: source.name, autoUpdate: source.autoUpdate },
        alsoIn,
        pinnedElsewhere: !!pinnedElsewhere,
      };
    });
    // Two lists, because they answer different questions. `updates` is what the
    // UI offers a person to press, and every pending update belongs in it
    // whatever it came from. `autoUpdates` is what the box may install while
    // nobody is watching, which is the source's own setting.
    const updates = out.filter((a) => a.updateAvailable).map((a) => a.id);
    const autoUpdates = out
      .filter((a) => a.updateAvailable && a.source.autoUpdate && !a.pinnedElsewhere)
      .map((a) => a.id);
    return {
      registry: loaded[0].url,
      apps: out,
      error,
      updates,
      autoUpdates,
      maxSources: MAX_EXTRA_SOURCES, // the UI's Add row asks the box rather than repeating the cap
      sources: loaded.map((s) => ({
        url: s.url,
        official: s.official,
        name: s.name,
        autoUpdate: s.autoUpdate,
        error: s.error,
        count: (s.entries || []).length,
      })),
    };
  };
}

/**
 * Install one app, from a registry the caller may name.
 *
 * `sourceUrl` is how an app is moved BETWEEN registries: the same id offered by
 * two of them is the ordinary case while somebody is working on an app that is
 * also published, and without a way to say which one, the pin decides for ever
 * and the local copy can never be tried on a box that already has the published
 * one.
 *
 * It is matched against the CONFIGURED sources and never fetched as given: a
 * url that arrives here is a request to trust a registry, and that decision
 * belongs to adding a source, not to pressing Install on one app.
 *
 * There is no version check anywhere in here, which is what makes the same
 * version installable again from somewhere else - that is the whole point of
 * the switch, and it is why the button says where it comes from rather than
 * what it is called.
 */
async function install(config, id, sourceUrl) {
  // REFRESH, not the cached copy. The file list and its sha256s come from the
  // index while the files come from the registry live, so an index even a few
  // minutes old can describe a package that has since been republished - and the
  // install then fails on a hash mismatch that looks like a corrupt download.
  // Measured on a box: a registry published between the store listing and the
  // install did exactly that. An install is deliberate and rare; one fetch to
  // make the two agree is the cheapest correctness there is.
  const loaded = await loadAll(config, true);
  const wanted = typeof sourceUrl === "string" && sourceUrl ? sourceUrl : null;
  if (wanted && !loaded.some((s) => s.url === wanted)) return { ok: false, error: "not a configured registry" };
  const hit = wanted
    ? (() => {
        const src = loaded.find((s) => s.url === wanted);
        const entry = (src && (src.entries || []).find((m) => m.id === id)) || null;
        return entry ? { entry, source: src } : null;
      })()
    : mergeSources(loaded).find((c) => c.entry.id === id);
  // Say WHY when a refresh failed. Forcing a refresh means the registries have to
  // answer - the files needed the network anyway - and reporting an unreachable
  // one as "not in registry" sends whoever debugs a failed auto-update looking
  // for a missing app. With several sources configured the distinction is the
  // same one: the app is only missing if every source answered and none had it.
  if (!hit) {
    // With a registry NAMED, only that one's reachability is the answer: another
    // source being down says nothing about the press somebody just made, and
    // reporting it as unreachable sends them to look at a registry they did not
    // choose.
    if (wanted) {
      const src = loaded.find((s) => s.url === wanted);
      if (src && src.error) return { ok: false, error: "registry unreachable: " + (src.error || "unknown") };
      // It answered and does not have it, which is a different sentence from
      // "nobody has it" and the one somebody switching sources needs: the app is
      // still installed, from where it was.
      return { ok: false, error: "that registry does not offer it" };
    }
    const failed = loaded.find((s) => s.error);
    if (failed) return { ok: false, error: "registry unreachable: " + (failed.error || "unknown") };
    return { ok: false, error: "not in registry" };
  }
  const m = hit.entry;
  const url = hit.source.url;
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
  // Written after the files, so a failed install leaves no claim on the id, and
  // on every install rather than the first: an app REinstalled from a different
  // source has moved, and the pin is meant to record where it stands now.
  const pinned = writePin(id, url);
  // The tile appears live (manifests reload per /apps request), but a `service`
  // plugin only loads at boot - the caller restarts (gated) to activate it. Read
  // the flag from the INSTALLED manifest (a package's own manifest.json is
  // authoritative), not the index entry, so the restart decision can't disagree
  // with what loadPlugins will actually run.
  apps.loadManifests();
  const installed = apps.manifestById(id);
  // A switch IS the pin: the files are the same ones the other registry would
  // have given, and what was asked for is where the app stands. Reporting
  // success on a pin that did not land leaves the app looking switched while
  // the nightly run takes it back that night.
  if (sourceUrl && !pinned) return { ok: false, error: "could not record which registry it came from" };
  return { ok: true, service: !!(installed && installed.service) };
}

function uninstall(id) {
  if (!/^[a-z0-9_-]+$/.test(String(id || ""))) return { ok: false, error: "bad id" };
  if (!installedFromStore(id)) return { ok: false, error: "not a store app" };
  fs.rmSync(storeManifestPath(id), { force: true }); // single-manifest form
  fs.rmSync(packageDir(id), { recursive: true, force: true }); // package-dir form
  apps.removeApp(id); // drop any downloaded bundle too
  fs.rmSync(pinPath(id), { force: true }); // ...and the claim on which registry it came from
  console.log("[store] removed:", id);
  return { ok: true };
}

module.exports = {
  listForUi,
  install,
  uninstall,
  trustErrors,
  verGt,
  sources,
  DEFAULT_REGISTRY,
  MAX_EXTRA_SOURCES,
};
