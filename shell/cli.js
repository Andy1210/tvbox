#!/usr/bin/env node
// tvbox app CLI - run the manifest install recipes from the command line.
//   tvbox list                 list apps + install status
//   tvbox deps <id>            provision an app's binary deps (apt + repo) + bundle
//   tvbox install <id> [-f]    run an app's bundle install recipe (-f reinstalls)
//   tvbox remove <id>          remove an installed app's data
//   tvbox update [--check]     OTA self-update (--check only reports)
//   tvbox backup <file>        encrypted settings backup (asks TVBOX_BACKUP_PASSWORD / --password)
//   tvbox restore <file>       restore a backup (then restart the shell)
// New web-client files are picked up live; a NEW app manifest needs a shell
// restart to appear as a HOME tile.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const apps = require("./install");

function nameOf(m) {
  return typeof m.name === "string" ? m.name : (m.name && (m.name.en || m.name.hu)) || m.id;
}

// Debian package-name policy - also blocks anything apt would parse as an
// option (defence against a manifest smuggling `-o APT::…` into root apt).
function validAptName(s) {
  return /^[a-z0-9][a-z0-9.+-]*$/.test(s);
}

// Validate a manifest's optional third-party APT repo and return the concrete,
// tvbox-OWNED paths to write. Pure (no I/O) so these security-critical rules
// are unit-testable. Throws on anything unsafe. The keyring + .list names are
// DERIVED from the app id - never manifest-chosen - so a bad manifest can't
// clobber a system (or another app's) keyring via `gpg --dearmor --yes`. The
// `deb` line must be exactly `deb [signed-by=<that keyring>] https://…` (no
// `trusted=yes`, no plain-http/unsigned repo, no foreign keyring).
function aptRepoPlan(m, r) {
  const id = String((m && m.id) || "");
  // lowercase-only, matching installPackage() + manifest validation (mixed case
  // would derive a keyring/list path that other subsystems wouldn't agree on)
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error("aptRepo: invalid app id");
  r = r || {};
  if (!/^https:\/\//.test(r.keyUrl || "")) throw new Error("aptRepo.keyUrl must be https");
  const keyring = "/usr/share/keyrings/tvbox-" + id + ".gpg";
  const listPath = "/etc/apt/sources.list.d/tvbox-" + id + ".list";
  const debLine = /^deb \[([^\]]*)\] (https:\/\/\S+) \S.*$/.exec(r.line || "");
  if (!debLine) throw new Error("aptRepo.line must be: deb [signed-by=<keyring>] https://<url> <suite> [components]");
  if (debLine[1].trim() !== "signed-by=" + keyring)
    throw new Error("aptRepo.line options must be exactly [signed-by=" + keyring + "]");
  return { id, keyUrl: r.keyUrl, keyring, listPath, line: r.line };
}

// Add a third-party APT repo (key + .list) for an app, as root, via sudo. No
// shell. The safety rules live in aptRepoPlan; this only does the I/O.
function installAptRepo(m, r, log) {
  const plan = aptRepoPlan(m, r);
  const keyTmp = path.join(os.tmpdir(), "tvbox-repo-" + plan.id + ".asc");
  const listTmp = path.join(os.tmpdir(), "tvbox-repo-" + plan.id + ".list");
  try {
    log("adding apt repo (" + plan.line + ")");
    // --proto-redir =https: keyUrl is https, but curl -L would otherwise follow
    // a redirect down to http - keep the whole fetch (incl. redirects) https.
    execFileSync("curl", ["-fsSL", "--proto-redir", "=https", plan.keyUrl, "-o", keyTmp], { stdio: "inherit" });
    execFileSync("sudo", ["gpg", "--yes", "--dearmor", "-o", plan.keyring, keyTmp], { stdio: "inherit" });
    fs.writeFileSync(listTmp, plan.line + "\n");
    execFileSync("sudo", ["cp", listTmp, plan.listPath], { stdio: "inherit" });
  } finally {
    try {
      fs.unlinkSync(keyTmp);
    } catch (e) {
      /* may not exist */
    }
    try {
      fs.unlinkSync(listTmp);
    } catch (e) {
      /* may not exist */
    }
  }
}

// The no-root `requires.download` install logic lives in install.js now (shared
// with the shell's UI dep-install path) - see apps.installDownloadDeps below.

function list() {
  const ms = apps.getManifests();
  if (!ms.length) {
    console.log("(no app manifests)");
    return;
  }
  for (const m of ms) {
    const state = m.type === "webclient" ? (apps.isInstalled(m.id) ? "installed" : "not installed") : "built-in";
    console.log(
      `${m.id.padEnd(12)} ${String(m.type).padEnd(10)} ${String(m.status).padEnd(12)} ${state.padEnd(14)} ${nameOf(m)}`,
    );
  }
}

function main() {
  apps.loadManifests();
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const log = (s) => console.log("  " + s);

  if (!cmd || cmd === "list" || cmd === "status") {
    list();
    return;
  }

  if (cmd === "deps") {
    const id = argv[1];
    // --download-only: install just the no-root `requires.download` binaries and
    // stop (never touch apt/sudo). This is the mode the shell's UI dep-install
    // spawns, so an on-screen install stays root-free / remote-only.
    const downloadOnly = argv.includes("--download-only");
    const m = apps.manifestById(id);
    if (!m) {
      console.error("unknown app: " + id);
      process.exit(1);
    }
    const req = m.requires || {};
    const apt = req.apt || [];
    const downloads = req.download || [];
    if (!apt.length && !downloads.length) {
      console.log(`${m.id}: no binary deps to install`);
      return;
    }
    console.log(`provisioning ${m.id} …`);
    try {
      // User-space static binaries first (no root). Shared with the shell's
      // UI path via apps.installDownloadDeps (skips bins already on PATH).
      apps.installDownloadDeps(m, log);
      // Whatever the downloads covered doesn't need apt anymore; if everything
      // resolves, we're done without ever touching root.
      const still = apps.appDeps(m);
      if (still.depsOk) {
        console.log(`done (no root needed) - restart the shell (or reboot) to pick up ${m.id}.`);
        if (m.install) console.log(`then install its bundle from the HOME screen, or run:  tvbox install ${m.id}`);
        return;
      }
      if (downloadOnly) throw new Error("missing after download (needs apt / tvbox deps): " + still.missing.join(", "));
      if (!apt.length) throw new Error("missing after download: " + still.missing.join(", "));
      const badPkg = apt.filter((p) => !validAptName(String(p)));
      if (badPkg.length) throw new Error("invalid apt package name(s): " + badPkg.join(", "));
      // Optional third-party APT repo (e.g. raspotify for librespot). Validation
      // + orchestration live in installAptRepo/aptRepoPlan (unit-tested).
      if (req.aptRepo) installAptRepo(m, req.aptRepo, log);
      log("apt-get install " + apt.join(" "));
      execFileSync("sudo", ["apt-get", "update", "-qq"], { stdio: "inherit" });
      execFileSync("sudo", ["apt-get", "install", "-y", ...apt], { stdio: "inherit" });
      // The shell manages some daemons itself (e.g. librespot), so disable the
      // distro's system service to avoid a second Connect device.
      for (const svc of req.disableService || []) {
        log("systemctl disable --now " + svc);
        try {
          execFileSync("sudo", ["systemctl", "disable", "--now", svc], { stdio: "inherit" });
        } catch (e) {
          /* not present */
        }
      }
      // `deps` provisions ONLY the binary deps (root). A bundle app (e.g. Plex's
      // flatpak) is user-space and installs separately - from the HOME screen or
      // `tvbox install <id>` - so this never blocks on / requires root for a download.
      console.log(`done - restart the shell (or reboot) to pick up ${m.id}.`);
      if (m.install) console.log(`then install its bundle from the HOME screen, or run:  tvbox install ${m.id}`);
    } catch (e) {
      console.error("deps failed: " + e.message);
      process.exit(1);
    }
    return;
  }

  if (cmd === "install") {
    const id = argv.slice(1).find((a) => !a.startsWith("-"));
    const force = argv.includes("--force") || argv.includes("-f");
    const m = apps.manifestById(id);
    if (!m) {
      console.error("unknown app: " + id);
      process.exit(1);
    }
    console.log(`installing ${m.id}${force ? " (force)" : ""} …`);
    try {
      apps.installApp(m, { force, log });
      console.log("done.");
    } catch (e) {
      console.error("install failed: " + e.message);
      process.exit(1);
    }
    return;
  }

  if (cmd === "remove") {
    const id = argv[1];
    if (!id) {
      console.error("usage: tvbox remove <id>");
      process.exit(1);
    }
    console.log(apps.removeApp(id) ? `removed ${id}` : `${id} was not installed`);
    return;
  }

  // ---- OTA self-update from the command line (same engine the shell uses;
  // the shell restart is manual here: pkill -f 'electron[/]dist')
  if (cmd === "update") {
    const updater = require("./updater");
    updater.check().then(async (s) => {
      if (s.error) {
        console.error(s.error);
        process.exit(1);
      }
      console.log(
        `current ${s.current}${s.release ? " (release " + s.release + ")" : " (dev tree)"}, latest ${s.latest ? s.latest.version : "?"}`,
      );
      if (!s.available) {
        console.log("up to date.");
        return;
      }
      if (argv.includes("--check")) {
        console.log("update available - run `tvbox update` to install.");
        return;
      }
      console.log("installing …");
      const r = await updater.apply();
      if (r.state === "error") {
        console.error(r.error);
        process.exit(1);
      }
      console.log("installed + flipped. Restart the shell to boot it:  pkill -f 'electron[/]dist'");
    });
    return;
  }

  // ---- settings backup/restore (headless twin of the phone pairing page;
  // no launcher localStorage here - locale/app-order need the UI path)
  if (cmd === "backup" || cmd === "restore") {
    const file = argv.slice(1).find((a) => !a.startsWith("-"));
    const pwIdx = argv.indexOf("--password");
    const password = pwIdx >= 0 ? argv[pwIdx + 1] : process.env.TVBOX_BACKUP_PASSWORD;
    if (!file || !password) {
      console.error(`usage: tvbox ${cmd} <file> --password <pw>   (or TVBOX_BACKUP_PASSWORD)`);
      process.exit(1);
    }
    const backup = require("./backup");
    try {
      if (cmd === "backup") {
        fs.writeFileSync(file, JSON.stringify(backup.encrypt(backup.collect(null), password)), { mode: 0o600 });
        console.log("backup written:", file);
      } else {
        backup.apply(backup.decrypt(JSON.parse(fs.readFileSync(file, "utf8")), password));
        console.log("restored. Restart the shell to load it:  pkill -f 'electron[/]dist'");
      }
    } catch (e) {
      console.error(cmd + " failed: " + e.message);
      process.exit(1);
    }
    return;
  }

  console.log(
    "usage: tvbox <list | deps <id> | install <id> [-f] | remove <id> | update [--check] | backup <file> | restore <file>>",
  );
  process.exit(1);
}

if (require.main === module) main(); // run only as the CLI, not when required by a test

module.exports = { aptRepoPlan, installAptRepo };
