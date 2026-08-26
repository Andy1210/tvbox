// The shell-side plugin registry: which app's plugin is loaded, what it
// registered, and how it is taken away again.
//
// A plugin is loaded ONLY when its app is present and its declared binary deps
// resolve; it gets a scoped `host` API (built by main.js) and never touches shell
// internals. This module owns the three registries an unload has to reach - the
// plugin objects, their HTTP routes and their config listeners - because each one
// was a way for a stopped plugin to come back or to keep answering.
const path = require("path");

let deps = {
  apps: null, // ./install - manifests + appDeps
  host: {}, // the scoped surface a plugin is handed
  setWidget: () => {}, // (appId, w) - the per-app HOME card slot
  switchValue: () => false, // (m, key) - appinfo.switchValue, scoped per app below
};

function init(d) {
  deps = { ...deps, ...d };
}

// app id -> { start, stop } from its plugin factory. Keyed rather than a list,
// because a plugin has to be findable by id: uninstalling an app has to be able to
// STOP its plugin (a daemon or a LAN listener would otherwise outlive the app that
// owns it, with its switch gone from Settings), and an update has to replace one.
const loadedPlugins = new Map();
// [{ id, prefix, table }] - HTTP routes a plugin registered. Tagged with the app id
// so they can go WITH it: a table left behind after an unload keeps answering out of
// closures over an instance that has been stopped, and a route table is matched
// first-wins, so a replacement plugin's routes would sit behind the dead one's.
const pluginRoutes = [];
// [{ id, cb }] - plugins that react to a config write (e.g. Live TV drops its cache).
// Tagged with the app id for the same reason as the routes: a listener that outlives
// its plugin is a way back in. Measured before it was tagged - an uninstalled app's
// receiver came back on the LAN the next time anything wrote config, with the shell no
// longer knowing the plugin existed and its switch gone from Settings.
const configListeners = [];

/**
 * Which of a plugin's route keys the same-origin gate covers, from the third
 * argument to registerRoutes.
 *
 * Every entry has to NAME a GET handler in the same table, and a plugin that gets
 * that wrong fails to load rather than registering. The quiet alternative is the
 * bug this whole mechanism exists to prevent: `guard: ["GET /waitTime"]` beside a
 * table defining `"GET /waittime"` matches nothing, the route still answers, and
 * the costly read is open to any page the box loads - with nothing anywhere
 * saying so. A plugin that does not load is logged, and its tile still works.
 */
function guardList(opts, table) {
  const g = opts && opts.guard;
  if (g === undefined || g === null) return [];
  if (!Array.isArray(g)) throw new Error("registerRoutes: guard must be an array of route keys");
  for (const key of g) {
    if (typeof key !== "string" || typeof (table || {})[key] !== "function") {
      throw new Error("registerRoutes: guard names no route in this table: " + JSON.stringify(key));
    }
    // Everything else is gated already, so a non-GET here is a misunderstanding
    // worth correcting rather than a no-op to carry.
    if (!key.startsWith("GET ")) {
      throw new Error("registerRoutes: only a GET needs guarding, not " + JSON.stringify(key));
    }
  }
  return g;
}

// Notify plugins that config sections changed (host.onConfigChange). A package
// plugin can't reach the shell config write directly, so this is how e.g. the
// Live TV plugin invalidates its channel/EPG cache when the IPTV source changes.
function emitConfigChange(sections) {
  if (!sections || !sections.length) return;
  for (const { id, cb } of configListeners) {
    try {
      cb(sections);
    } catch (e) {
      console.warn("[config] listener", id || "(shell)", ":", e.message);
    }
  }
}

// Registrations from the BARE host (no app). They belong to nothing and are never
// removed - which is why the per-app bindings below exist.
function onConfigChange(cb) {
  if (typeof cb === "function") configListeners.push({ id: null, cb });
}
function registerRoutes(prefix, table, opts) {
  pluginRoutes.push({ id: null, prefix, table, guard: guardList(opts, table) });
}

function routes() {
  return pluginRoutes;
}
function isLoaded(id) {
  return loadedPlugins.has(id);
}

/**
 * Run one of a plugin's own methods without letting its failure reach us.
 *
 * Two ways it can, and a try/catch alone stops neither. A plugin may be ASYNC -
 * a rejected promise walks straight past a synchronous catch and lands as an
 * unhandled rejection in the main process - so a thenable return is caught too.
 * And `e` need not be an Error: `throw null` arrives here as well, and reading
 * `.message` off it would throw again, out of the catch and into whatever asked.
 * Returns whether it got through SYNCHRONOUSLY, which is all a caller can be told
 * at this point: an async plugin has only been started, not finished.
 */
function call(id, what, run) {
  const failed = (e) => console.warn("[plugin]", what, id, "failed:", String((e && e.message) || e));
  try {
    const r = run();
    if (r && typeof r.then === "function") r.then(undefined, failed);
    return true;
  } catch (e) {
    failed(e);
    return false;
  }
}

// Load ONE app's service plugin (require + run its factory so it registers its
// routes via host.registerRoutes). Returns the plugin object, or null if it has
// no valid service, ships no package plugin.js, its deps are missing, or it is
// already loaded. Does NOT start the daemon - the caller decides when (boot:
// startAll; runtime hot-load: right away).
function loadOne(m) {
  const name = m.service;
  if (!name) return null;
  if (loadedPlugins.has(m.id)) return null;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    console.warn("[plugin] bad service name for", m.id, "->", name);
    return null;
  }
  // A service plugin ships INSIDE the app package (~/.tvbox/apps/<id>/plugin.js);
  // the shell has no first-party plugins anymore. A manifest with a service but
  // no package dir is malformed - skip it.
  if (!m._dir) {
    console.warn("[plugin] skip", m.id, "- declares service", name, "but ships no package plugin.js");
    return null;
  }
  const d = deps.apps.appDeps(m);
  if (!d.depsOk) {
    console.warn("[plugin] skip", m.id, "- missing:", d.missing.join(","));
    return null;
  }
  try {
    const plugin =
      require(path.join(m._dir, "plugin.js"))({
        ...deps.host,
        // per-app widget slot - a plugin can only ever write its OWN card
        widget: { set: (w) => deps.setWidget(m.id, w), clear: () => deps.setWidget(m.id, null) },
        // ...and its OWN manifest switches, by key. Scoped for the same reason: a
        // plugin reading another app's settings is not a thing this API allows.
        switchOn: (key) => deps.switchValue(m, key),
        // Tagged with this app, so unloading it really removes them. An untagged
        // listener survives its plugin and is a way back in: it fires on the next
        // config write and starts a daemon nothing is left to stop.
        onConfigChange: (cb) => {
          if (typeof cb === "function") configListeners.push({ id: m.id, cb });
        },
        registerRoutes: (prefix, table, opts) => {
          pluginRoutes.push({ id: m.id, prefix, table, guard: guardList(opts, table) });
        },
      }) || {};
    loadedPlugins.set(m.id, plugin);
    console.log("[plugin] loaded", m.id, "(" + name + ")");
    return plugin;
  } catch (e) {
    console.warn("[plugin]", m.id, "failed to load:", e.message);
    return null;
  }
}

// Require each manifest-declared plugin whose deps resolve. Runs synchronously
// (before serve()) so routes are registered before the launcher's first request;
// daemons start later in startAll() (after audio).
function loadAll() {
  for (const m of deps.apps.getManifests()) loadOne(m);
}

// Hot-load a plugin whose app just became installable (deps + package present)
// WITHOUT a shell restart: run its factory so its routes register on the live
// server, then start its daemon now. Returns true if the plugin is running (or
// already was). This is why a `service` app no longer needs a full restart to
// activate after install.
function hotLoad(id) {
  const m = deps.apps.manifestById(id);
  if (!m || !m.service) return false;
  // An UPDATE arrives through the same door as a first install, and the version on
  // disk is already the new one - so a plugin that is still loaded is the OLD code,
  // holding whatever it holds (a daemon, a LAN listener). Replacing it here is what
  // makes a fix in a package take effect without a reboot.
  if (loadedPlugins.has(id)) {
    unload(id);
    console.log("[plugin] replacing", id, "with the version now on disk");
  }
  const plugin = loadOne(m);
  if (!plugin) return false;
  // Say which of the three actually happened. One line for all of them read
  // "hot-started" even when there was no start to run, or when it threw and
  // `call` had just logged the failure above it - which is the wrong thing to
  // find in the log of a box whose app went in and did nothing.
  if (typeof plugin.start !== "function") console.log("[plugin] hot-loaded", id, "(no start)");
  else if (call(id, "start", () => plugin.start())) console.log("[plugin] hot-started", id);
  return true;
}

/**
 * Stop ONE app's plugin and forget it: the app is going away (uninstall) or being
 * replaced (update). Its `stop` is what releases a daemon, a supervised child or a
 * listening socket - none of which the shell can see, let alone close for it.
 *
 * Three things go with it, and each one was a way for the plugin to come back or to
 * keep answering after it was gone:
 *
 *   • its config listeners - an untagged one fires on the next config write and
 *     starts the daemon again, with nothing left that could stop it (measured);
 *   • its HTTP routes - a route table is matched first-wins, so a dead instance's
 *     closures would keep serving and would shadow a replacement's;
 *   • the require cache for its WHOLE package dir, not just plugin.js - a package
 *     installs to the same path every time, so an update's new plugin.js would
 *     otherwise `require("./lib/…")` and get the previous version's module.
 */
function unload(id) {
  const plugin = loadedPlugins.get(id);
  if (!plugin) return false;
  // Its own `stop` FIRST, while the shell still holds the handle: dropping the entry
  // before the call means a `stop` that throws leaves the plugin's socket open with
  // nothing left that can reach it.
  // A failure here leaves whatever the plugin held until a restart.
  if (typeof plugin.stop === "function") call(id, "stop", () => plugin.stop());
  loadedPlugins.delete(id);
  for (let i = configListeners.length - 1; i >= 0; i--) if (configListeners[i].id === id) configListeners.splice(i, 1);
  for (let i = pluginRoutes.length - 1; i >= 0; i--) if (pluginRoutes[i].id === id) pluginRoutes.splice(i, 1);
  const m = deps.apps.manifestById(id);
  const dir = m && m._dir ? path.resolve(m._dir) + path.sep : null;
  if (dir) {
    for (const key of Object.keys(require.cache)) if (key.startsWith(dir)) delete require.cache[key];
  }
  console.log("[plugin] unloaded", id);
  return true;
}

function startAll() {
  for (const [id, p] of loadedPlugins) {
    if (typeof p.start === "function") call(id, "start", () => p.start());
  }
}

function stopAll() {
  for (const [id, p] of loadedPlugins) {
    // Logged rather than swallowed: this runs on the way out, and a plugin that
    // could not put its daemon down is the reason the next start finds the port
    // taken.
    if (typeof p.stop === "function") call(id, "stop", () => p.stop());
  }
}

/**
 * Tell an app's plugin that its app was CLOSED, so it can stop sound the shell
 * cannot see. The window teardown only ends the shared mpv, and a plugin's daemon
 * is not that: Spotify plays through librespot, which outlived the ✕ in the Running
 * row and kept the album going with no page left to reach it.
 *
 * Called from the deliberate quit rather than the teardown hook, because that hook
 * fires for every way a window dies - the LRU cap, the memory guard, a crashed
 * renderer - and the guard that spares a sounding app from eviction asks the mpv
 * player who owns it, so a plugin's audio is invisible to it.
 */
function appClosed(id) {
  const plugin = loadedPlugins.get(id);
  // `typeof`, not truthiness: a plugin is somebody's JavaScript object, and
  // calling a truthy non-function throws out of here into the route that asked
  // for the quit.
  if (!plugin || typeof plugin.appClosed !== "function") return;
  call(id, "appClosed", () => plugin.appClosed());
}

module.exports = {
  init,
  guardList,
  emitConfigChange,
  onConfigChange,
  registerRoutes,
  routes,
  isLoaded,
  call,
  loadOne,
  loadAll,
  hotLoad,
  unload,
  startAll,
  stopAll,
  appClosed,
};
