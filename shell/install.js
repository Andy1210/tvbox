// tvbox app install - manifest loading + the install-recipe runner, shared by
// the shell (startup) and the `tvbox` CLI (cli.js). A manifest's install recipe
// is Homebrew-like: a source (flatpak / url tarball / git), an extract subpath,
// and patches. The acquired files land in apps-data/<id>.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { isLanUrl, guardedFetch } = require("./netguard"); // shared self-hosted trust rule (plain http only to LAN hosts)
const nativeapp = require("./native"); // runtime.native parser, shared with the launch path so the rules can't drift
const flatpak = require("./flatpak"); // the one place that knows flatpak: refs, versions, commits, installing

// Installed web-client BUNDLES live OUTSIDE the shell install so they survive
// OTA + deploys - an OTA runs the shell from a fresh ~/.tvbox/current/shell (the
// release tarball never carries apps-data), so a bundle under __dirname/ was
// lost on every update and the tile reverted to "Install". Persist it next to
// the user manifests instead (migrateAppsData below moves any old in-shell copy).
const APPS_DATA = path.join(os.homedir(), ".tvbox", "apps-data");

// User-space binaries installed by `tvbox deps` from a manifest's
// `requires.download` (static builds - no root, no apt) live here. Prepend it
// to PATH so onPath() finds them and every child (mpv, librespot, plugins'
// services) inherits it.
const USER_BIN = path.join(os.homedir(), ".tvbox", "bin");
if (!(process.env.PATH || "").split(path.delimiter).includes(USER_BIN)) {
  process.env.PATH = USER_BIN + path.delimiter + (process.env.PATH || "");
}

// Third-party / user-installed apps live OUTSIDE the shell install so they
// survive deploys: ~/.tvbox/apps/<id>.json (manifest only) or
// ~/.tvbox/apps/<id>/manifest.json (a directory that may also carry plugin.js).
const USER_APPS_DIR = path.join(os.homedir(), ".tvbox", "apps");
const MANIFEST_VERSION = 1; // bump only on breaking manifest-format changes

let manifests = [];

// One-time move of installed bundles from the OLD in-shell location(s) to the
// persistent APPS_DATA, so a box that already installed apps (e.g. Plex) doesn't
// have to reinstall after this update. Runs only when APPS_DATA doesn't exist
// yet - so it happens exactly once and never resurrects a later uninstall.
// UNION across candidates (newest-first wins per app id), so apps installed
// under different OTA versions are all carried; and ATOMIC (build in a temp
// sibling, then rename) so an interrupted copy never becomes a half-migrated
// live dir - the next boot just retries.
let migratedAppsData = false;
function migrateAppsData() {
  if (migratedAppsData) return;
  migratedAppsData = true;
  const tmp = APPS_DATA + ".migrating-" + process.pid;
  try {
    if (fs.existsSync(APPS_DATA)) return; // migration already done (respects uninstalls)
    const home = os.homedir();
    const candidates = [path.join(__dirname, "apps-data"), path.join(home, ".tvbox", "shell", "apps-data")];
    try {
      for (const v of fs.readdirSync(path.join(home, ".tvbox", "versions"))) {
        candidates.push(path.join(home, ".tvbox", "versions", v, "shell", "apps-data"));
      }
    } catch (e) {
      /* no versions dir (dev deploy) */
    }
    // newest-first so the freshest copy of each app id wins in the union
    const dirs = candidates
      .filter((d) => path.resolve(d) !== path.resolve(APPS_DATA))
      .map((d) => {
        try {
          return { d, m: fs.statSync(d).mtimeMs };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.m - a.m)
      .map((x) => x.d);
    const seen = new Set();
    for (const dir of dirs) {
      let ids;
      try {
        ids = fs.readdirSync(dir);
      } catch (e) {
        continue;
      }
      for (const id of ids) {
        if (seen.has(id)) continue;
        const sub = path.join(dir, id);
        try {
          if (!fs.statSync(sub).isDirectory() || !fs.readdirSync(sub).length) continue;
        } catch (e) {
          continue;
        }
        seen.add(id);
        fs.mkdirSync(tmp, { recursive: true });
        fs.cpSync(sub, path.join(tmp, id), { recursive: true });
      }
    }
    if (seen.size) {
      fs.mkdirSync(path.dirname(APPS_DATA), { recursive: true });
      fs.renameSync(tmp, APPS_DATA); // atomic: same filesystem sibling
      console.log("[apps] migrated", seen.size, "installed bundle(s) ->", APPS_DATA);
    }
  } catch (e) {
    console.warn("[apps] apps-data migration skipped:", e.message);
  } finally {
    // never leave a partial temp behind
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }
}

// Files in ~/.tvbox/ that belong to the SHELL and can never be an app's own state,
// whatever id a manifest claims. The id prefix alone is not a boundary: an app id is
// only constrained to [a-z0-9_-], so a manifest calling itself `config` would match
// `config.json` - the file holding the IPTV/Spotify/MQTT credentials and the
// parental PIN hash - and a manifest-only app is untrusted. Kept in sync with
// backup.js's EXTRA_FILES by install.test.js.
const RESERVED_STATE_FILES = new Set([
  "config.json",
  "spotify-accounts.json",
  "spotify-refresh-token",
  "restore-localstorage.json",
  "restore-appfiles.json",
  "reconcile.json",
  "install.log",
  // run-shell.sh opens a Chromium DevTools endpoint when this exists. An app id of
  // "debug" satisfies the `<id>-` prefix rule on its own, so without this an app's
  // `backup.state` could name it and a restore would write it - handing the next
  // boot a debug endpoint. Same pair of gates as every other shell-owned path.
  "debug-port",
]);

// A ~/.tvbox/ sidecar an app may claim as its own in `backup.state`: one flat file
// name, no path separators, prefixed with `<id>-`, and not one of the shell's own.
// The HYPHEN matters - `<id>.json` and `<id>.<anything>` were the forms that let an
// app named `config` or `spotify` name a shell file - and the reserved set closes
// what is left.
function stateFileOk(id, name) {
  if (!/^[a-z0-9_-]+$/.test(String(id || ""))) return false;
  if (typeof name !== "string" || name.length > 80) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) return false;
  if (RESERVED_STATE_FILES.has(name)) return false;
  return name.startsWith(id + "-");
}

// Reject (skip with a warning) anything that would confuse the shell or the
// launcher instead of half-rendering it. Formal schema: docs/app-manifest.md +
// docs/app-manifest.schema.json (CI validates the shipped manifests against it).
function validateManifest(m, src) {
  const bad = (msg) => {
    console.warn("[apps] skip", src + ":", msg);
    return null;
  };
  if (!m || typeof m !== "object") return bad("not an object");
  const v = m.manifestVersion == null ? 1 : m.manifestVersion;
  if (v !== MANIFEST_VERSION)
    return bad("unsupported manifestVersion " + v + " (shell speaks " + MANIFEST_VERSION + ")");
  if (typeof m.id !== "string" || !/^[a-z0-9_-]+$/.test(m.id)) return bad("id must match [a-z0-9_-]+");
  // webclient = the shell serves/loads a web UI (a package's own web/ bundle, the
  // legacy root bundle, or a remote site). native = the app IS its own fullscreen
  // Wayland client (RetroArch); the shell spawns it and hides its own windows.
  if (m.type !== "webclient" && m.type !== "native") return bad("type must be webclient|native");
  if (m.status !== "ready" && m.status !== "coming_soon") return bad("status must be ready|coming_soon");
  if (!m.name) return bad("missing name");
  // A native app's command line reaches argv, so validate it with the very parser
  // the launch path uses rather than a second copy of the rules.
  //
  // `runtime.native` is validated wherever it appears, not only on a `type: native`
  // app: a webclient app may declare one too (RetroArch - our own UI browses the
  // games, the emulator itself is the native program it launches per game), and an
  // unvalidated command line would then reach argv through the very path that exists
  // to keep it out.
  if (m.type === "native" || (m.runtime && m.runtime.native !== undefined)) {
    const nat = (m.runtime && m.runtime.native) || null;
    if (!nativeapp.parseSpec(nat)) return bad("runtime.native must be a valid flatpak ref or bin");
    // The dep check reads requires.flatpak while the launch reads
    // runtime.native.flatpak. A manifest that names the ref in only one of them
    // would report depsOk with nothing installed, and the launch would just fail.
    //
    // Array.isArray, not `|| []`: this runs BEFORE requires.flatpak is validated as an
    // array below, and a manifest carrying an object there would throw a TypeError out
    // of the validator instead of being skipped through bad() - a validator is the one
    // place that must survive any shape a dropped-in manifest has.
    const declared = m.requires && m.requires.flatpak;
    if (nat.flatpak && (!Array.isArray(declared) || !declared.includes(nat.flatpak)))
      return bad("runtime.native.flatpak (" + nat.flatpak + ") must also be listed in requires.flatpak");
  }
  // flatpak deps: `flatpak install --user` needs no root, so unlike apt these are
  // installable straight from the UI. The refs reach argv too.
  const fps = m.requires && m.requires.flatpak;
  if (fps !== undefined) {
    if (!Array.isArray(fps) || fps.length > 8) return bad("requires.flatpak must be an array of at most 8 refs");
    for (const r of fps) if (!nativeapp.flatpakRefOk(r)) return bad("bad requires.flatpak ref " + JSON.stringify(r));
  }
  const serve = m.runtime && m.runtime.serve;
  // "local" = a package app that ships its own web/ UI bundle (served at /<id>/,
  // run in the privileged main window with the full preload.js SDK). "static" is
  // the legacy single root-mounted bundle (mount:root, e.g. Plex). "remote" loads
  // a live site in an isolated window.
  if (serve && !["static", "remote", "local"].includes(serve)) return bad("runtime.serve must be static|remote|local");
  // Capabilities + origins are a security boundary - validate them at RUNTIME,
  // not only via the CI JSON Schema (a dropped-in registry manifest never sees
  // CI). An empty/blank/wildcard origin must never slip through (it would let
  // the `fetch` broker's host allowlist match anything); capability values must
  // be known.
  // Language + cookies: the schema constrains these in CI, but a manifest dropped into
  // ~/.tvbox/apps/ is validated ONLY here, and both feed real machinery (an HTTP header,
  // a URL, the cookie jar).
  const rtl = m.runtime && m.runtime.language;
  if (rtl !== undefined && !(typeof rtl === "string" && /^(system|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/.test(rtl)))
    return bad('runtime.language must be a BCP-47 tag or "system"');
  const cookies = m.runtime && m.runtime.cookies;
  if (cookies !== undefined) {
    if (!Array.isArray(cookies) || cookies.length > 8) return bad("runtime.cookies must be an array of at most 8");
    for (const c of cookies) {
      if (!c || typeof c !== "object") return bad("runtime.cookies entries must be objects");
      if (!/^https?:\/\/\S+$/.test(String(c.url || ""))) return bad("runtime.cookies[].url must be http(s)");
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(String(c.name || ""))) return bad("bad runtime.cookies[].name");
      for (const k of ["value", "domain", "path"])
        if (c[k] !== undefined && typeof c[k] !== "string") return bad("runtime.cookies[]." + k + " must be a string");
    }
  }
  const ti = m.runtime && m.runtime.textInput;
  if (ti !== undefined && ti !== "auto" && ti !== "off") return bad('runtime.textInput must be "auto" or "off"');
  // Renderer bridge adapter, always a file the package ships next to its
  // manifest. Pinned here as well as at resolution time, so nothing that reaches
  // require() can carry a path.
  const br = m.runtime && m.runtime.bridge;
  if (br !== undefined && (typeof br !== "string" || !/^\.\/[a-z0-9_-]+\.js$/.test(br)))
    return bad("runtime.bridge must be ./<file>.js shipped by the package");
  // Phone-pairing kinds the app offers (its plugin registers the matching
  // provider). This is how an app that has no screen of its own on the box, e.g. a
  // native app, still gets a "do this from your phone" affordance: the launcher
  // renders a row per entry and knows nothing about what the app does with it.
  const pairs = m.pairing;
  if (pairs !== undefined) {
    if (!Array.isArray(pairs) || pairs.length > 4) return bad("pairing must be an array of at most 4");
    for (const p of pairs) {
      if (!p || typeof p !== "object") return bad("pairing entries must be objects");
      if (!/^[a-z0-9_-]{1,32}$/.test(String(p.kind || ""))) return bad("bad pairing[].kind " + JSON.stringify(p.kind));
      if (!p.label || (typeof p.label !== "string" && typeof p.label !== "object"))
        return bad("pairing[].label must be a string or a locale map");
    }
  }
  // Files of its own the app wants carried across a re-flash or onto a second box
  // (RetroArch's playlists and save files; the `storage` capability covers only
  // small key/value settings). Validated here as well as in CI because a manifest
  // dropped into ~/.tvbox/apps/ never sees CI, and these paths reach the
  // filesystem on BOTH sides of a backup.
  const bk = m.backup;
  if (bk !== undefined) {
    if (!bk || typeof bk !== "object" || Array.isArray(bk)) return bad("backup must be an object");
    if (bk.flatpak !== undefined && !nativeapp.flatpakRefOk(bk.flatpak))
      return bad("backup.flatpak must be a flatpak ref the app declares");
    if (!Array.isArray(bk.paths) || !bk.paths.length || bk.paths.length > 16)
      return bad("backup.paths must be 1-16 relative paths");
    for (const rel of bk.paths) {
      if (typeof rel !== "string" || !rel || rel.length > 200) return bad("bad backup.paths entry");
      // No absolute path, no traversal, no leading dot-segment: these are joined
      // onto the app's own root and written back verbatim on restore.
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === ".." || s === "" || s === "."))
        return bad("backup.paths must be relative in-app paths: " + JSON.stringify(rel));
      // `state` is the prefix the backup payload uses to mark a ~/.tvbox/ sidecar
      // (backup.js STATE_PREFIX). A declared directory of that name would produce
      // entries the restore reads as sidecars and then drops, so the files would be
      // carried and silently never written back. Refuse the name instead.
      if (rel === "state" || rel.startsWith("state/"))
        return bad('backup.paths may not start with "state" (reserved for backup.state)');
    }
    // Sidecar state a `service` plugin keeps directly in ~/.tvbox/ (host-process
    // Node code writes there; only small key/value settings go through the
    // `storage` capability). The name must be PREFIXED with the app id - that is
    // what makes this a boundary and not a convention: no app can name
    // config.json, or another app's file.
    if (bk.state !== undefined) {
      if (!Array.isArray(bk.state) || bk.state.length > 8) return bad("backup.state must be an array of at most 8");
      for (const name of bk.state) {
        if (typeof name !== "string" || !stateFileOk(m.id, name))
          return bad("backup.state entries must be ~/.tvbox/<id>-<name> files: " + JSON.stringify(name));
      }
    }
  }
  const CAPS = ["nav", "player", "config", "fetch", "storage", "display", "input", "system"];
  const caps = m.runtime && m.runtime.capabilities;
  if (caps != null) {
    if (!Array.isArray(caps)) return bad("runtime.capabilities must be an array");
    for (const c of caps) if (!CAPS.includes(c)) return bad("unknown capability " + JSON.stringify(c));
  }
  const origins = m.runtime && m.runtime.origins;
  if (origins != null) {
    if (!Array.isArray(origins)) return bad("runtime.origins must be an array");
    for (const o of origins) {
      // a bare hostname only: no scheme, port, path, wildcard, whitespace, or blanks
      if (typeof o !== "string" || !/^[a-z0-9.-]+$/i.test(o) || o.startsWith(".") || o.endsWith("."))
        return bad("runtime.origins entries must be bare hostnames: " + JSON.stringify(o));
    }
  }
  if (m.accent && !/^#[0-9a-fA-F]{3,8}$/.test(m.accent)) {
    // accent is interpolated into launcher CSS - never let a manifest smuggle
    // url(...)/expressions through it; drop instead of rejecting the app
    console.warn("[apps]", m.id + ": ignoring non-hex accent");
    delete m.accent;
  }
  return m;
}

function readManifestFile(file, dir) {
  try {
    const m = validateManifest(JSON.parse(fs.readFileSync(file, "utf8")), path.basename(file));
    // remember where a user app lives (plugin.js resolution) without the field
    // ever reaching JSON.stringify / the API
    if (m && dir) Object.defineProperty(m, "_dir", { value: dir, enumerable: false });
    return m;
  } catch (e) {
    console.warn("[apps] bad manifest", file, e.message);
    return null;
  }
}

function loadManifests() {
  manifests = [];
  const seen = new Set();
  const add = (m) => {
    if (!m) return;
    if (seen.has(m.id)) {
      console.warn("[apps] duplicate id ignored:", m.id);
      return;
    }
    seen.add(m.id);
    manifests.push(m);
  };
  migrateAppsData(); // carry a pre-existing install over to the persistent dir (once)
  // Every app is a package/manifest under ~/.tvbox/apps/ (installed from the
  // registry). There's no first-party in-shell manifest slot anymore.
  try {
    for (const f of fs.readdirSync(USER_APPS_DIR)) {
      if (f.startsWith(".")) continue; // dotfiles + in-flight package temp dirs (.<id>.tmp-*)
      const p = path.join(USER_APPS_DIR, f);
      if (f.endsWith(".json")) add(readManifestFile(p, null));
      else if (fs.existsSync(path.join(p, "manifest.json"))) add(readManifestFile(path.join(p, "manifest.json"), p));
    }
  } catch (e) {
    /* optional dir - most boxes have no user apps */
  }
  manifests.sort((a, b) => a.id.localeCompare(b.id));
  return manifests;
}
function getManifests() {
  return manifests;
}
function manifestById(id) {
  return manifests.find((m) => m.id === id);
}
function appDataDir(id) {
  return path.join(APPS_DATA, id);
}
function isInstalled(id) {
  return fs.existsSync(appDataDir(id));
}

// The directory an app's `backup.paths` are resolved against: its flatpak's
// per-user data dir when the manifest names one (RetroArch keeps its playlists
// and saves there), otherwise the app's own extracted-bundle dir. Returns null
// when the manifest declares nothing or names a flatpak it doesn't depend on -
// a backup must never be able to read or write outside the app it belongs to.
function appBackupRoot(m) {
  const bk = m && m.backup;
  if (!bk || !Array.isArray(bk.paths) || !bk.paths.length) return null;
  if (!bk.flatpak) return appDataDir(m.id);
  const declared = flatpak.refsFor(m).map((f) => f.ref);
  if (!declared.includes(bk.flatpak)) {
    console.warn("[apps]", m.id + ": backup.flatpak", bk.flatpak, "is not one of its own refs - ignoring");
    return null;
  }
  return flatpak.dataDir(bk.flatpak);
}

// Is an executable on PATH (or an absolute path)? Used to check a manifest's
// declared binary deps so an app whose binary is missing can degrade gracefully.
function onPath(bin) {
  if (!bin) return false;
  if (bin.includes("/")) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    } catch (e) {
      return false;
    }
  }
  return (process.env.PATH || "").split(path.delimiter).some((d) => {
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK);
      return true;
    } catch (e) {
      return false;
    }
  });
}
// Resolve a manifest's `requires.bin` + `requires.flatpak` deps -> { depsOk,
// missing, installable }.
function appDeps(m) {
  const bins = (m && m.requires && m.requires.bin) || [];
  const missing = bins.filter((b) => !onPath(b));
  // `installable`: every missing binary is covered by a no-root `requires.download`
  // entry for THIS arch - so the box can install it from the UI (no CLI/sudo).
  // false means at least one dep is apt-only (needs `tvbox deps` or a bundled bin).
  // Require a well-formed spec (https url + sha256) so a UI "install" offer never
  // leads to a guaranteed-failing download (a registry manifest never sees CI).
  const downloads = (m && m.requires && m.requires.download) || [];
  const dl = new Set(
    downloads
      .filter((d) => {
        const s = d && d.arch && d.arch[process.arch];
        return s && /^https:\/\//.test(s.url || "") && /^[0-9a-f]{64}$/i.test(s.sha256 || "");
      })
      .map((d) => d.bin),
  );
  // Missing flatpak apps land in the same `missing` list (so the tile greys out
  // and says "needs RetroArch"), but they are ALWAYS UI-installable: a --user
  // install touches no root, which is exactly the bar `installable` describes.
  const refs = (m && m.requires && m.requires.flatpak) || [];
  const fpMissing = refs.filter((r) => !flatpak.isInstalled(r)).map(flatpak.shortName);
  missing.push(...fpMissing);
  const uiInstallable = new Set([...dl, ...fpMissing]);
  const installable = missing.length > 0 && missing.every((b) => uiInstallable.has(b));
  return { depsOk: missing.length === 0, missing, installable };
}

// Install a manifest's no-root `requires.download` binaries (static builds ->
// ~/.tvbox/bin, sha256-verified). This is the UI-safe subset of `tvbox deps`
// (apt/aptRepo stay CLI-only, root). Returns { ok, installed, missing }.
function installDownload(entry, log) {
  log = log || (() => {});
  const bin = String((entry && entry.bin) || "");
  if (!/^[a-z0-9_-]+$/i.test(bin)) throw new Error("download entry needs a valid bin name");
  const spec = (entry.arch || {})[process.arch];
  if (!spec) throw new Error(bin + ": no download for arch " + process.arch);
  if (!/^https:\/\//.test(spec.url || "")) throw new Error(bin + ": download.url must be https");
  if (!/^[0-9a-f]{64}$/i.test(spec.sha256 || "")) throw new Error(bin + ": download needs a sha256");
  // extract subpath stays inside the temp dir (no `..`/absolute traversal)
  if (spec.extract && (path.isAbsolute(spec.extract) || spec.extract.split(/[\\/]/).includes("..")))
    throw new Error(bin + ": download.extract must be a relative in-archive path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-bin-"));
  try {
    const archive = path.join(tmp, "dl");
    log("download " + spec.url + " …");
    // bounded: a stalled fetch must not hang the install (leaving the tile stuck).
    // --proto-redir =https: spec.url is https, but -L would otherwise follow a
    // redirect down to http - keep redirects https too (github's release
    // redirects are https->https, so this doesn't break real downloads).
    execFileSync(
      "curl",
      ["-fsSL", "--proto-redir", "=https", "--connect-timeout", "20", "--max-time", "600", spec.url, "-o", archive],
      { stdio: "inherit" },
    );
    const sum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (sum !== spec.sha256.toLowerCase()) throw new Error(bin + ": sha256 mismatch (got " + sum + ")");
    let src = archive;
    if (/\.tar\.gz$|\.tgz$/i.test(spec.url)) {
      execFileSync("tar", ["-xzf", archive, "-C", tmp], { stdio: "inherit" });
      src = path.join(tmp, spec.extract || bin);
    } else if (/\.zip$/i.test(spec.url)) {
      execFileSync("unzip", ["-q", archive, "-d", tmp], { stdio: "inherit" });
      src = path.join(tmp, spec.extract || bin);
    }
    if (!fs.existsSync(src)) throw new Error(bin + ": extract path not found: " + (spec.extract || bin));
    fs.mkdirSync(USER_BIN, { recursive: true });
    const dst = path.join(USER_BIN, bin);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    log(bin + " -> " + dst);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Install a PACKAGE app - a dir-app that ships its OWN code/UI (manifest.json +
// optional plugin.js + web/** + pairing/**) - into ~/.tvbox/apps/<id>/. This is
// how a registry app carries everything (the Kodi model): the shell only
// provides the SDK, the app package brings its implementation. Each entry in
// `files` ([{path, sha256}]) is fetched from baseUrl+path, sha256-verified, and
// written under the package dir; paths are guarded against traversal. Files land
// in a sibling temp dir and swap in atomically (same filesystem), so a failed or
// partial download never leaves a half-installed app. `baseUrl` is derived from
// the registry URL by the caller, so it inherits the registry's trust + scheme.
const MAX_PKG_FILES = 4000; // a web bundle is dozens of files; this is a runaway-index backstop
const PKG_FILE_TIMEOUT_MS = 60000; // per-file cap so an unresponsive registry can't hang the install
// One package file, with every guard the install path depends on: origin-pinned
// (a `rel` that is itself a URL must not fetch off-registry), redirects
// re-validated by guardedFetch, and bounded so an unresponsive registry cannot
// hang the install and wedge the tile.
async function fetchPackageFile(url, baseOrigin, rel) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PKG_FILE_TIMEOUT_MS);
  try {
    const res = await guardedFetch(url.toString(), {
      cache: "no-store",
      signal: ctl.signal,
      allow: (u) => new URL(u).origin === baseOrigin,
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + rel);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function installPackage(id, baseUrl, files, log) {
  log = log || (() => {});
  if (!/^[a-z0-9_-]+$/.test(String(id || ""))) throw new Error("bad app id");
  if (!Array.isArray(files) || files.length === 0) throw new Error("empty package file list");
  if (files.length > MAX_PKG_FILES) throw new Error("package has too many files (" + files.length + ")");
  if (!/^https?:\/\//.test(String(baseUrl || ""))) throw new Error("package base must be http(s)");
  const baseOrigin = new URL(baseUrl).origin; // pin every fetch to the registry's own origin
  fs.mkdirSync(USER_APPS_DIR, { recursive: true });
  const dst = path.join(USER_APPS_DIR, id);
  // temp dir is a SIBLING (same filesystem as dst) so the final rename is atomic;
  // the leading "." keeps loadManifests from picking it up mid-install.
  const tmp = fs.mkdtempSync(path.join(USER_APPS_DIR, "." + id + ".tmp-"));
  const bak = fs.existsSync(dst) ? dst + ".bak-" + process.pid : null; // upgrade-in-place backup
  try {
    for (const f of files) {
      const rel = String((f && f.path) || "");
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
        throw new Error("bad package file path: " + JSON.stringify(rel));
      if (!/^[0-9a-f]{64}$/i.test((f && f.sha256) || "")) throw new Error("package file needs a sha256: " + rel);
      // Resolve against the base, then PIN to the base's origin: a `rel` that is
      // itself an absolute or protocol-relative URL (http://evil/…) would make
      // new URL() drop baseUrl and fetch off-registry (SSRF). Reject that.
      const url = new URL(rel, baseUrl);
      if (url.origin !== baseOrigin) throw new Error("package file leaves the registry origin: " + rel);
      log("fetch " + rel + " …");
      // guardedFetch re-validates any redirect hop AND (via `allow`) confines it
      // to baseOrigin, so a 3xx can't bounce this origin-pinned fetch off the
      // registry; sha256 below is the content-integrity backstop on top. Bounded
      // by a timeout like every other fetcher (fetchIndex/fetchJson/download) so
      // an unresponsive registry can't hang the install and wedge the tile.
      // A registry served from a CDN can hand back a copy from before its last
      // publish, and `cache: "no-store"` only speaks to the LOCAL cache - the edge
      // has its own. So a hash that does not match is not proof of a bad file yet:
      // try once more with a URL the edge has never seen, and only then give up.
      // The check itself stays exactly as strict; this only removes a failure mode
      // that looks like tampering and is really a stale cache.
      let buf = await fetchPackageFile(url, baseOrigin, rel);
      let sum = crypto.createHash("sha256").update(buf).digest("hex");
      if (sum !== f.sha256.toLowerCase()) {
        log("sha256 mismatch for " + rel + " - refetching past the cache");
        const fresh = new URL(url.toString());
        fresh.searchParams.set("_", Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
        buf = await fetchPackageFile(fresh, baseOrigin, rel);
        sum = crypto.createHash("sha256").update(buf).digest("hex");
      }
      if (sum !== f.sha256.toLowerCase()) throw new Error("sha256 mismatch for " + rel + " (got " + sum + ")");
      const out = path.join(tmp, rel);
      if (out !== tmp && !out.startsWith(tmp + path.sep)) throw new Error("package path escape: " + rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      // Shell scripts a package ships (e.g. a librespot --onevent hook) arrive as
      // plain bytes over HTTP with no mode, so writeFileSync leaves them 0644,
      // not executable. A package's *.sh is meant to run; mark it executable.
      if (rel.endsWith(".sh")) fs.chmodSync(out, 0o755);
    }
    // The package's own manifest.json is authoritative once installed, so it must
    // exist AND its id must match the id we installed under (a mismatched id would
    // register the app as something else and could shadow another app).
    let pm;
    try {
      pm = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8"));
    } catch (e) {
      throw new Error("package manifest.json missing or invalid JSON", { cause: e });
    }
    if (pm.id !== id) throw new Error("package manifest id '" + pm.id + "' != install id '" + id + "'");
    // Swap in: move any existing install aside first so a crash mid-rename can be
    // recovered rather than losing the app; drop the backup once the swap lands.
    if (bak) fs.renameSync(dst, bak);
    try {
      fs.renameSync(tmp, dst);
    } catch (e) {
      if (bak) fs.renameSync(bak, dst); // restore the previous install
      throw e;
    }
    log("installed package " + id + " -> " + dst);
    return dst;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (bak) fs.rmSync(bak, { recursive: true, force: true });
  }
}

// Install ALL of an app's no-root deps that aren't already present: static
// `requires.download` binaries AND `requires.flatpak` apps. No root, so it's safe
// to run from the shell (UI install) - the "remote-only, no CLI" path. apt-only
// deps are left to `tvbox deps` / the image.
function installUiDeps(m, log) {
  log = log || (() => {});
  const downloads = (m && m.requires && m.requires.download) || [];
  const installed = [];
  for (const entry of downloads) {
    if (onPath(entry.bin)) continue; // already present (bundled/system wins)
    installDownload(entry, log);
    installed.push(entry.bin);
  }
  for (const ref of (m && m.requires && m.requires.flatpak) || []) {
    if (flatpak.isInstalled(ref)) continue;
    flatpak.installUser(ref, flatpak.arch(), log);
    installed.push(ref);
  }
  const after = appDeps(m);
  return { ok: after.depsOk, installed: installed, missing: after.missing };
}

// An install source may be fetched over https from anywhere, or plain http
// only from the owner's own LAN/loopback infrastructure - the same
// self-hosted trust rule as the updater feed (netguard.isLanUrl).
function sourceUrlOk(u) {
  return /^https:\/\//i.test(u || "") || isLanUrl(u);
}

// Acquire the app's source and return a local directory that contains its files
// (the root that `extract` is resolved against).
function acquireSource(source, log) {
  if (!source || !source.type) throw new Error("manifest has no install.source");
  if (source.type === "flatpak") {
    if (!source.ref) throw new Error("flatpak source needs a ref");
    const a = source.arch || "x86_64";
    let dir = flatpak.root(source.ref, a);
    if (!dir) {
      flatpak.installUser(source.ref, a, log);
      dir = flatpak.root(source.ref, a);
    }
    if (!dir) throw new Error("flatpak files not found for " + source.ref);
    return dir;
  }
  if (source.type === "url") {
    if (!source.url) throw new Error("url source needs a url");
    // Every other acquisition path (requires.download, package files, the OTA
    // tarball) is https + sha256-pinned; hold url sources to the same bar:
    // https anywhere, plain http only to the owner's own LAN host, and an
    // optional (recommended) sha256 pin verified before extraction.
    if (!sourceUrlOk(source.url)) throw new Error("url source must be https (or LAN http)");
    if (source.sha256 != null && !/^[0-9a-f]{64}$/i.test(source.sha256))
      throw new Error("url source sha256 must be 64 hex chars");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-"));
    const isZip = /\.zip$/i.test(source.url);
    const file = path.join(tmp, isZip ? "src.zip" : "src.tar.gz");
    log("download " + source.url + " …");
    // --proto-redir =https: block a redirect from downgrading to http (the
    // sha256 pin here is optional, so a downgraded/redirected fetch could hand
    // us arbitrary bundle bytes). Only redirects are constrained - a direct
    // https or LAN-http source still downloads fine.
    execFileSync("curl", ["-fsSL", "--proto-redir", "=https", source.url, "-o", file], { stdio: "inherit" });
    if (source.sha256) {
      const sum = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (sum !== source.sha256.toLowerCase()) throw new Error("url source sha256 mismatch (got " + sum + ")");
    }
    const out = path.join(tmp, "out");
    fs.mkdirSync(out);
    if (isZip) execFileSync("unzip", ["-q", file, "-d", out], { stdio: "inherit" });
    else execFileSync("tar", ["-xzf", file, "-C", out], { stdio: "inherit" });
    return out;
  }
  if (source.type === "git") {
    if (!source.url) throw new Error("git source needs a url");
    if (!sourceUrlOk(source.url)) throw new Error("git source must be https (or LAN http)");
    if (source.commit != null && !/^[0-9a-f]{40}$/i.test(source.commit))
      throw new Error("git source commit must be a full 40-hex sha");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-"));
    log("git clone " + source.url + " …");
    if (source.commit) {
      // Pinned: full clone + detached checkout of exactly that commit. The
      // checkout fails when the sha isn't in the repo, so its success IS the
      // verification (a sha names its content, like the sha256 on url sources).
      execFileSync("git", ["clone", source.url, tmp], { stdio: "inherit" });
      execFileSync("git", ["-C", tmp, "checkout", "--detach", source.commit.toLowerCase()], { stdio: "inherit" });
    } else {
      execFileSync("git", ["clone", "--depth", "1", source.url, tmp], { stdio: "inherit" });
    }
    return tmp;
  }
  throw new Error("unknown source type: " + source.type);
}

function applyPatches(m, dir, log) {
  const patches = (m.install && m.install.patch) || [];
  const entry = (m.runtime && m.runtime.entry) || "index.html";
  const idx = path.join(dir, entry);
  if (!patches.length || !fs.existsSync(idx)) return;
  let html = fs.readFileSync(idx, "utf8");
  let changed = false;
  for (const p of patches) {
    if (p.op === "strip-script" && p.match) {
      const esc = p.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("<script[^>]*" + esc + "[^>]*></script>", "g");
      const out = html.replace(re, "");
      if (out !== html) {
        html = out;
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(idx, html);
    log(m.id + ": patched " + entry);
  }
}

// What a bundle was extracted FROM, recorded next to the extracted files (not
// inside them - apps-data/<id> is served to the app as its web root).
//
// An extracted bundle is a COPY, so nothing in it changes when its source moves,
// and only a flatpak source moves on its own: the nightly `flatpak update` timer
// pulls a new Plex and the copy silently stays at the old one, which is how a web
// client goes stale until someone reinstalls it by hand. url/git sources are pinned
// by the manifest and can only change through a registry update, which re-extracts.
const SOURCES_DIR = path.join(APPS_DATA, ".sources");
function sourceStatePath(id) {
  return path.join(SOURCES_DIR, id + ".json");
}
function readSourceState(id) {
  try {
    return JSON.parse(fs.readFileSync(sourceStatePath(id), "utf8"));
  } catch (e) {
    return null;
  }
}
function writeSourceState(id, ident) {
  if (!ident) return;
  try {
    fs.mkdirSync(SOURCES_DIR, { recursive: true });
    fs.writeFileSync(sourceStatePath(id), JSON.stringify(ident));
  } catch (e) {
    console.warn("[install]", id, "could not record its source:", e.message);
  }
}
// The identity of a source as it stands right now. The commit, not the version:
// a flatpak can be rebuilt with new files under the same version string.
function sourceIdent(source) {
  if (!source) return null;
  if (source.type === "flatpak") {
    const a = source.arch || "x86_64";
    if (!flatpak.root(source.ref, a)) return null; // absent: nothing to compare against
    return { type: "flatpak", ref: source.ref, arch: a, commit: flatpak.commitSync(source.ref, a) };
  }
  if (source.type === "url") return { type: "url", url: source.url, sha256: source.sha256 || null };
  if (source.type === "git") return { type: "git", url: source.url, commit: source.commit || null };
  return null;
}
// Is an installed bundle behind the flatpak it came from? Answering true is a
// request to re-extract, so it stays conservative: an unreadable or absent
// flatpak says nothing rather than triggering a download.
// A web-client app whose bundle is not there AT ALL - the manifest exists but the
// content it points at does not. That is what a settings restore leaves behind: the
// backup carries `~/.tvbox/apps/<id>.json` but never the extracted bundle, and for
// Plex the flatpak it was extracted from is gone too.
//
// bundleStale() deliberately answers false here - its `isInstalled` guard means
// "there is no bundle to compare against the flatpak" - so without this the app is
// STRANDED: HOME hides it (ready:false), the store calls it installed because the
// manifest file exists and therefore offers only Remove, and the refresh tick skips
// it forever. The only way out was remove-then-install, by hand, on a TV.
function bundleMissing(m) {
  const source = m && m.type === "webclient" && m.install && m.install.source;
  return !!source && !isInstalled(m.id);
}

function bundleStale(m) {
  const source = m && m.type === "webclient" && m.install && m.install.source;
  if (!source || source.type !== "flatpak" || !isInstalled(m.id)) return false;
  const now = sourceIdent(source);
  if (!now || !now.commit) return false;
  const was = readSourceState(m.id);
  // Nothing recorded means the bundle predates this bookkeeping: level it with the
  // flatpak once, then it is tracked like any other.
  if (!was || was.type !== "flatpak" || !was.commit) return true;
  return was.commit !== now.commit;
}

// Install one web-client app. Idempotent at startup (skips the copy if already
// present, only re-patches); `force` re-extracts cleanly (CLI reinstall). A bundle
// whose flatpak has moved is re-extracted too, unless `keepStale` says not to -
// the boot pass sets that, because acquiring anything there would block the
// Electron main process.
function installApp(m, opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  if (!m) throw new Error("no manifest");
  if (m.type !== "webclient" || !m.install) {
    log(m.id + ": built-in, nothing to install");
    return false;
  }
  const dst = appDataDir(m.id);
  const stale = !opts.keepStale && !opts.force && bundleStale(m);
  if (isInstalled(m.id) && !opts.force && !stale) {
    applyPatches(m, dst, log);
    return true;
  }
  if (stale) log(m.id + ": its flatpak moved, re-extracting the bundle");
  const srcRoot = acquireSource(m.install.source, log);
  const src = path.join(srcRoot, m.install.extract || "");
  if (!fs.existsSync(src)) throw new Error("extract path not found: " + src);
  fs.mkdirSync(APPS_DATA, { recursive: true });
  // A refresh replaces rather than merges: a file the new version dropped would
  // otherwise linger from the old one.
  if (opts.force || stale) fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  applyPatches(m, dst, log);
  writeSourceState(m.id, sourceIdent(m.install.source));
  log(m.id + ": installed -> " + dst);
  return true;
}

// Boot pass: only RE-PATCH already-installed web clients. Fresh acquisition
// (flatpak/url/git download) is opt-in and must NOT run here - it would block the
// Electron main process for minutes on a fresh box. New bundles are acquired only
// via `tvbox install <id>` / the on-demand UI install path, and a stale bundle is
// refreshed out of process once the box is up (main.js's bundleRefreshTick).
function installAll(log) {
  for (const m of manifests) {
    if (m.type === "webclient" && m.status === "ready" && isInstalled(m.id)) {
      try {
        installApp(m, { log: log || (() => {}), keepStale: true });
      } catch (e) {
        console.warn("[install]", m.id, "failed:", e.message);
      }
    }
  }
}

function removeApp(id) {
  const dst = appDataDir(id);
  const existed = fs.existsSync(dst);
  fs.rmSync(dst, { recursive: true, force: true });
  return existed;
}

module.exports = {
  loadManifests,
  bundleStale,
  bundleMissing,
  getManifests,
  manifestById,
  appDataDir,
  appBackupRoot,
  stateFileOk,
  RESERVED_STATE_FILES,
  isInstalled,
  installApp,
  installAll,
  removeApp,
  appDeps,
  installDownload,
  installUiDeps,
  installPackage,
  onPath,
  validateManifest,
  USER_BIN,
  USER_APPS_DIR,
};
