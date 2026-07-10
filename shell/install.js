// tvbox app install - manifest loading + the install-recipe runner, shared by
// the shell (startup) and the `tvbox` CLI (cli.js). A manifest's install recipe
// is Homebrew-like: a source (flatpak / url tarball / git), an extract subpath,
// and patches. The acquired files land in apps-data/<id>.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { isLanUrl } = require("./netguard"); // shared self-hosted trust rule (plain http only to LAN hosts)

// Installed web-client BUNDLES live OUTSIDE the shell install so they survive
// OTA + deploys - an OTA runs the shell from a fresh ~/.tvbox/current/shell (the
// release tarball never carries apps-data), so a bundle under __dirname/ was
// lost on every update and the tile reverted to "Install". Persist it next to
// the user manifests instead (migrateAppsData below moves any old in-shell copy).
const APPS_DATA = path.join(os.homedir(), ".tvbox", "apps-data");
const FLATPAK_BASES = ["/var/lib/flatpak/app", path.join(os.homedir(), ".local", "share", "flatpak", "app")];

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
  if (m.type !== "webclient") return bad("type must be webclient"); // apps are packages now; no builtin views
  if (m.status !== "ready" && m.status !== "coming_soon") return bad("status must be ready|coming_soon");
  if (!m.name) return bad("missing name");
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
  const CAPS = ["nav", "player", "config", "fetch", "storage", "input", "system"];
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
// Resolve a manifest's `requires.bin` deps -> { depsOk, missing }.
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
  const installable = missing.length > 0 && missing.every((b) => dl.has(b));
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
    // bounded: a stalled fetch must not hang the install (leaving the tile stuck)
    execFileSync("curl", ["-fsSL", "--connect-timeout", "20", "--max-time", "600", spec.url, "-o", archive], {
      stdio: "inherit",
    });
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
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + rel);
      const buf = Buffer.from(await res.arrayBuffer());
      const sum = crypto.createHash("sha256").update(buf).digest("hex");
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

// Install ALL of an app's no-root download deps that aren't already on PATH.
// No root, so it's safe to run from the shell (UI install) - the "remote-only,
// no CLI" path. apt-only deps are left to `tvbox deps` / the image.
function installDownloadDeps(m, log) {
  log = log || (() => {});
  const downloads = (m && m.requires && m.requires.download) || [];
  const installed = [];
  for (const entry of downloads) {
    if (onPath(entry.bin)) continue; // already present (bundled/system wins)
    installDownload(entry, log);
    installed.push(entry.bin);
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

// The flatpak app's "active" dir (extract paths like "files/resources/..." are
// resolved against it). Considered installed once its files/ subdir exists.
function flatpakRoot(ref, arch) {
  const a = arch || "x86_64";
  for (const base of FLATPAK_BASES) {
    const root = path.join(base, ref, a, "stable", "active");
    if (fs.existsSync(path.join(root, "files"))) return root;
  }
  return null;
}

// Acquire the app's source and return a local directory that contains its files
// (the root that `extract` is resolved against).
function acquireSource(source, log) {
  if (!source || !source.type) throw new Error("manifest has no install.source");
  if (source.type === "flatpak") {
    if (!source.ref) throw new Error("flatpak source needs a ref");
    let root = flatpakRoot(source.ref, source.arch);
    if (!root) {
      log("flatpak install --user " + source.ref + " …");
      // Ensure the user-scoped flathub remote so an on-demand UI/CLI install needs
      // no root (deploy.sh keeps to a baseline and doesn't pre-install any app).
      try {
        execFileSync(
          "flatpak",
          ["remote-add", "--user", "--if-not-exists", "flathub", "https://flathub.org/repo/flathub.flatpakrepo"],
          { stdio: "inherit" },
        );
      } catch (e) {
        /* may already exist */
      }
      execFileSync(
        "flatpak",
        ["install", "--user", "-y", "--arch=" + (source.arch || "x86_64"), "flathub", source.ref],
        { stdio: "inherit" },
      );
      root = flatpakRoot(source.ref, source.arch);
    }
    if (!root) throw new Error("flatpak files not found for " + source.ref);
    return root;
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
    execFileSync("curl", ["-fsSL", source.url, "-o", file], { stdio: "inherit" });
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

// Install one web-client app. Idempotent at startup (skips the copy if already
// present, only re-patches); `force` re-extracts cleanly (CLI reinstall).
function installApp(m, opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  if (!m) throw new Error("no manifest");
  if (m.type !== "webclient" || !m.install) {
    log(m.id + ": built-in, nothing to install");
    return false;
  }
  const dst = appDataDir(m.id);
  if (isInstalled(m.id) && !opts.force) {
    applyPatches(m, dst, log);
    return true;
  }
  const srcRoot = acquireSource(m.install.source, log);
  const src = path.join(srcRoot, m.install.extract || "");
  if (!fs.existsSync(src)) throw new Error("extract path not found: " + src);
  fs.mkdirSync(APPS_DATA, { recursive: true });
  if (opts.force) fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  applyPatches(m, dst, log);
  log(m.id + ": installed -> " + dst);
  return true;
}

// Boot pass: only RE-PATCH already-installed web clients. Fresh acquisition
// (flatpak/url/git download) is opt-in and must NOT run here - it would block the
// Electron main process for minutes on a fresh box. New bundles are acquired only
// via `tvbox install <id>` / the on-demand UI install path.
function installAll(log) {
  for (const m of manifests) {
    if (m.type === "webclient" && m.status === "ready" && isInstalled(m.id)) {
      try {
        installApp(m, { log: log || (() => {}) });
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
  getManifests,
  manifestById,
  appDataDir,
  isInstalled,
  installApp,
  installAll,
  removeApp,
  appDeps,
  installDownload,
  installDownloadDeps,
  installPackage,
  onPath,
  validateManifest,
  USER_BIN,
  USER_APPS_DIR,
};
