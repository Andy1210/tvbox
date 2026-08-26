// What the shell knows about an installed app, from its manifest plus the live
// state around it: whether it belongs on HOME, what a manifest-declared switch is
// set to, which capabilities it was granted, and where its bridge adapter lives.
//
// Its own module because these are decisions rather than wiring - `capsFor` is the
// security boundary (hard rule 2) and fails closed, `switchValue` has to survive a
// key that names something every object has, and `bridgePath` pins a value that
// reaches require(). Nothing here draws anything or touches Electron.
//
// The modules it reads are INJECTED (the same shape diag.js uses), so a test can
// answer for a manifest set, a config and an install state of its own.
const path = require("path");
const fs = require("fs");

let deps = {
  apps: null, // ./install - manifests + appDeps + isInstalled
  config: null, // ./config - appConfig / appSwitches
  maintenance: null, // ./maintenance - isInstalling / progressFor
  // The live state a manifest cannot answer for.
  isPluginLoaded: () => false, // a switch acts through its plugin; with none, a press changes nothing
  hasWindow: () => false, // a background app has a live window
  nativeAppId: () => null, // a native app has no window of ours; its process is what "running" means
  foregroundId: () => null,
};

function init(d) {
  deps = { ...deps, ...d };
}

/**
 * Launchable = belongs on HOME: ready status, binary deps present, configured, a
 * bundle app has its bundle, and not mid-install. HOME shows ONLY these, so a
 * still-installing or not-yet-provisioned app stays in the store (with progress)
 * instead of appearing greyed on HOME.
 *
 * One function, because two callers answer the same question and must not drift:
 * the tile list the launcher draws, and the source list the Home Assistant
 * media_player offers. A source that HOME would refuse to open must not be
 * offered there either.
 */
function appLaunchable(m) {
  const { depsOk } = deps.apps.appDeps(m);
  const installable = !!(m.install && m.install.source);
  return (
    m.status === "ready" &&
    depsOk &&
    isConfigured(m) &&
    !deps.maintenance.isInstalling(m.id) &&
    (!installable || deps.apps.isInstalled(m.id))
  );
}

// A remote web-app whose URL comes from config (runtime.urlConfig) is only
// launchable once that URL is set (e.g. Home Assistant). Everything else is
// always "configured" so the launcher gates only what actually needs it.
function isConfigured(m) {
  const rt = m.runtime || {};
  if (rt.serve !== "remote" || !rt.urlConfig) return true;
  return !!(deps.config.appConfig(rt.urlConfig) || {}).baseUrl;
}

// The value of one manifest-declared switch (`switches`): what the box has stored,
// else the manifest's own default. An undeclared key is off, and so is a declared
// one whose manifest does not ask for `default: true` - a switch that appears with
// a release must never turn something on by appearing.
function switchValue(m, key) {
  const decl = (Array.isArray(m.switches) ? m.switches : []).find((s) => s && s.key === key);
  if (!decl) return false;
  const stored = deps.config.appSwitches(m.id);
  // Own property only: `in` walks the prototype chain, so a key that happens to
  // name something every object has would read as stored - and truthy - whatever
  // the box has actually saved.
  return Object.prototype.hasOwnProperty.call(stored, key) ? !!stored[key] : decl.default === true;
}

// Is this app running? Per app KIND, the same distinction HOME's tiles make: a
// native app has no window of ours, so its own process is what "running" means.
// An id no manifest claims falls to the window test, which is what a plugin
// asking about an app whose manifest went away still needs to hear.
function appRunning(id) {
  const m = deps.apps.manifestById(id);
  return m && m.type === "native" ? deps.nativeAppId() === id : !!deps.hasWindow(id);
}

function appTiles() {
  // the subset the launcher needs to draw a tile (+ dependency status so it can
  // grey out an app whose required binary isn't installed)
  return deps.apps.getManifests().map((m) => {
    const { depsOk, missing, installable: depsInstallable } = deps.apps.appDeps(m);
    // installable = has a bundle install recipe (flatpak/url/git) that can be
    // provisioned from the UI without root (e.g. Plex). installed = its bundle is
    // present. A webclient with installable && !installed needs a one-tap install.
    const installable = !!(m.install && m.install.source);
    return {
      id: m.id,
      name: m.name,
      tagline: m.tagline,
      type: m.type,
      status: m.status,
      accent: m.accent,
      icon: m.icon,
      // background apps: a live (possibly hidden) window exists; HOME shows a
      // running badge + quit affordance, resume is instant via navTo.
      running: appRunning(m.id),
      foreground: m.id === deps.foregroundId(),
      // Phone-pairing affordances the app declares (Settings shows a row each).
      // Only kind + label: the launcher starts the session and draws the QR, the
      // app's own plugin owns everything that happens on the phone.
      pairing: Array.isArray(m.pairing) ? m.pairing.map((p) => ({ kind: p.kind, label: p.label })) : undefined,
      // On/off switches the app declares, with the value in force. Same reason as
      // `pairing`: an app whose screen is not ours (a native app, or a remote site
      // like YouTube's own TV page) has nowhere else to put a setting, and the
      // launcher renders these knowing nothing about what they do.
      //
      // `available` is whether its PLUGIN is loaded, because the plugin is the thing
      // that acts on a switch: with a missing dependency, no plugin.js, or a factory
      // that threw, a press would write config and change nothing. Still LISTED
      // though - hiding it leaves somebody following release notes with no trace of a
      // setting that is supposed to exist; the launcher shows it as unavailable.
      switches: Array.isArray(m.switches)
        ? m.switches.map((s) => ({
            key: s.key,
            label: s.label,
            hint: s.hint,
            on: switchValue(m, s.key),
            available: deps.isPluginLoaded(m.id),
          }))
        : undefined,
      depsOk,
      missing,
      depsInstallable, // every missing binary is a no-root download dep -> UI-installable (no CLI)
      installable,
      installed: deps.apps.isInstalled(m.id),
      installing: deps.maintenance.isInstalling(m.id),
      configured: isConfigured(m),
      ready: appLaunchable(m), // see appLaunchable: the one definition HOME and HA share
      progress: deps.maintenance.progressFor(m.id) || null,
    };
  });
}

// The apps a media_player can be switched TO: exactly what HOME would open
// (appLaunchable), so the source list never offers a tile the box would refuse -
// an app mid-install, missing a dep, or a remote app with no URL set yet.
// Bounded, because this goes into a retained payload and then into a Home
// Assistant state attribute.
const MAX_MEDIA_SOURCES = 64;
function mediaSources() {
  return deps.apps
    .getManifests()
    .filter(appLaunchable)
    .map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.name && (m.name.en || m.name.hu) }))
    .filter((s) => s.name)
    .slice(0, MAX_MEDIA_SOURCES);
}

// The launcher (id null) is the trusted first-party UI that hosts builtin apps,
// so it gets player + config too. An app gets exactly what its manifest declares
// and defaults to nav-only - a manifest that forgets `capabilities` must NOT
// silently inherit player/config (that boundary would fail open).
function capsFor(id) {
  if (!id) return ["nav", "player", "config"];
  const m = deps.apps.manifestById(id);
  return (m && m.runtime && m.runtime.capabilities) || ["nav"];
}

function rootWebApp() {
  return deps.apps
    .getManifests()
    .find((m) => m.type === "webclient" && m.runtime && m.runtime.mount === "root" && m.status === "ready");
}

// The app DOM element that must become transparent to reveal mpv (declared per
// app in the manifest, e.g. Plex's "#media-container"). The shell has no
// app-specific selector baked in.
function transparentSelectorFor(id) {
  const m = id && deps.apps.manifestById(id);
  return (m && m.runtime && m.runtime.transparentSelector) || null;
}

// Where the app's declared bridge adapter really lives, or null. A bridge always
// ships INSIDE its app package ("./file.js" next to the manifest): the thing it
// adapts is one client's host API, so it belongs to that client and updates from
// the registry with it. The shell has no bridge of its own. Resolved here rather
// than in the preload because this is the side that knows where a package is
// installed, and the value reaches require(): it is pinned to the package dir,
// no subdirectories and no traversal, and a manifest-only app (no dir of its
// own) simply cannot have one.
function bridgePath(m) {
  const name = (m && m.runtime && m.runtime.bridge) || null;
  if (!name || !m._dir || !/^\.\/[a-z0-9_-]+\.js$/.test(name)) return null;
  const file = path.join(m._dir, name.slice(2));
  return path.dirname(file) === path.resolve(m._dir) && fs.existsSync(file) ? file : null;
}

module.exports = {
  init,
  appLaunchable,
  isConfigured,
  switchValue,
  appRunning,
  appTiles,
  mediaSources,
  capsFor,
  rootWebApp,
  transparentSelectorFor,
  bridgePath,
  MAX_MEDIA_SOURCES,
};
