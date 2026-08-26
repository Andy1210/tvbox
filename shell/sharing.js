// Offering the box's folders and an app's folders, and bringing another box's copy
// here. The three modules underneath own the decisions - fileserver.js which
// folders are offered and what gets served, appshares.js what an app declares,
// shares.js a NAS as a source - and this is the wiring plus the one thing none of
// them can own: the lifecycle of the credential two boxes pair on.
//
// Nothing here draws anything, so it is all testable with a fake config: a key is
// minted under a placeholder id and adopted when the answer names the box, and
// every way that can go wrong leaves a credential somebody holds that "forget this
// box" cannot reach.
const path = require("path");
const { spawn } = require("child_process");

let deps = {
  config: null, // ./config
  apps: null, // ./install - onPath + getManifests + appShareRoot
  appshares: null,
  fileserver: null,
  shares: null,
  peers: null,
  identity: null,
  supervisor: null,
  childEnv: () => ({ ...process.env }),
  // The path a no-root binary install runs through (cli.js in a child process).
  installDeps: () => {},
};

// PATH matters for all three (rclone lands in ~/.tvbox/bin, which install.js
// prepends); the Wayland vars do not - these serve files, they draw nothing.
let fileserverDeps = null;
let appsharesDeps = null;
let sharesDeps = null;

function init(d) {
  deps = { ...deps, ...d };
  fileserverDeps = { onPath: deps.apps.onPath, childEnv: deps.childEnv, supervisor: deps.supervisor };
  // The same wiring, with one addition: what there is to offer comes from the
  // installed manifests, and it is a function because an app can be installed while
  // the box is running.
  appsharesDeps = {
    onPath: deps.apps.onPath,
    childEnv: deps.childEnv,
    supervisor: deps.supervisor,
    entries: () => deps.appshares.entries(deps.apps.getManifests(), deps.apps.appShareRoot),
  };
  sharesDeps = { onPath: deps.apps.onPath, childEnv: deps.childEnv, supervisor: deps.supervisor };
}

const fileserverDepsOf = () => fileserverDeps;
const appsharesDepsOf = () => appsharesDeps;
const sharesDepsOf = () => sharesDeps;

let rcloneInstalling = false;
const isInstallingRclone = () => rcloneInstalling;

// ---- the box's own folders, an app's folders, and a NAS ----

function applyFileserver() {
  try {
    return applyFileserverInner();
  } catch (e) {
    // The settings POST calls this synchronously; one feature's bad day must not be
    // the shell's last.
    console.warn("[fileserver] apply failed:", e.message);
    return { ok: false, error: "failed" };
  }
}
function applyFileserverInner() {
  const cfg = deps.config.rawFileserver();
  if (!cfg.enabled) {
    deps.fileserver.stop(fileserverDeps);
    return { ok: true, stopped: true };
  }
  const r = deps.fileserver.start(cfg, fileserverDeps);
  if (!r.ok) {
    deps.fileserver.stop(fileserverDeps); // never leave a half-started share behind
    console.warn("[fileserver] not started:", r.error);
  } else {
    console.log("[fileserver] serving", r.shared.length, "folder(s) on", r.url || ":" + r.port);
  }
  return r;
}

function applyAppshares() {
  try {
    return applyAppsharesInner();
  } catch (e) {
    console.warn("[appshares] apply failed:", e.message);
    return { ok: false, error: "failed" };
  }
}
function applyAppsharesInner() {
  const cfg = deps.config.rawAppshares();
  // Drop ids no installed app declares any more. Without this an app that was
  // uninstalled leaves its share in the list, the server refuses to start with
  // "nothing shared", and the screen offers nothing to switch off - the stale
  // entry is invisible there, because the list is built from the manifests.
  const known = new Set(appsharesDeps.entries().map((e) => e.id));
  const kept = (Array.isArray(cfg.enabled) ? cfg.enabled : []).filter((id) => known.has(id));
  if (kept.length !== (cfg.enabled || []).length) deps.config.setAppshares({ enabled: kept });
  if (!kept.length) {
    deps.appshares.stop(appsharesDeps);
    return { ok: true, stopped: true };
  }
  const r = deps.appshares.start(deps.config.rawAppshares(), appsharesDeps);
  if (!r.ok) {
    deps.appshares.stop(appsharesDeps); // never leave a half-started share behind
    console.warn("[appshares] not started:", r.error);
  } else {
    console.log("[appshares] offering", r.shared.length, "folder(s) on :" + r.port);
  }
  return r;
}

// Mount what is configured (and unmount what is not) - on boot, and after every
// change to the list.
function applyShares() {
  const r = deps.shares.apply(deps.config.rawShares(), sharesDeps);
  if (!r.ok) console.warn("[shares] not mounted:", r.error);
  else if (r.mounted.length) console.log("[shares] mounting", r.mounted.join(", "));
  return r;
}

// ---- the credential two boxes pair on ----

// The box on the other side of the exchange, remembered - replaced rather than
// appended, because a key is reissued each time and a stale entry would be tried
// first. Two things it refuses: an address that is not on this box's own subnet
// (the outbound half refuses the same, and for the same reason), and an id that
// already names a DIFFERENT box - a peer id is a hostname, so it is guessable, and
// a caller must not be able to repoint the room next door at itself.
function rememberPeer(peer) {
  if (!deps.peers.onLocalSubnet(peer.host)) {
    console.warn("[appshares] refused a peer from off the local subnet:", peer.host);
    return false;
  }
  const known = deps.config.rawAppshares().peers || [];
  const clash = known.find((x) => x.id === peer.id && x.host !== peer.host);
  if (clash) {
    console.warn("[appshares] refused a peer claiming", peer.id, "- that name is", clash.host);
    return false;
  }
  const kept = known.filter((x) => x.id !== peer.id);
  deps.config.setAppshares({ peers: [...kept, peer] });
  console.log("[appshares] paired with", peer.name);
  return true;
}

// The key this box hands another one, minted per box and recorded by its hash so
// that forgetting the box is what revokes it. Answers null while nothing is being
// offered: a box that shares nothing has no key to give, and pairing with it is
// simply one-way.
function issueShareKey(box) {
  const cfg = deps.config.rawAppshares();
  // What is actually served, not what the list says: an id whose app has been
  // uninstalled keeps the list non-empty while the server refuses to start on
  // "nothing shared", and a peer would pair happily and be refused on its first
  // pull. Same filter applyAppshares uses.
  const known = new Set(appsharesDeps.entries().map((e) => e.id));
  if (!(cfg.enabled || []).some((id) => known.has(id))) return null;
  const cred = deps.appshares.newCredential();
  // The hostname is what makes a box itself here, the same source the MQTT device
  // id is derived from - so a peer list names the rooms, not addresses.
  // Until the answer names the box, the key is filed under its own user name -
  // unique already, and adoptShareKey renames the row the moment the box says who
  // it is.
  const id = String((box && box.id) || "") || cred.user;
  const kept = (cfg.issued || []).filter((x) => x.id !== id);
  deps.config.setAppshares({
    issued: [
      ...kept,
      {
        id,
        name: String((box && box.name) || id).slice(0, 64),
        user: cred.user,
        hash: deps.appshares.hashSecret(cred.secret),
      },
    ],
  });
  // The file rclone reads is written at start; the new line has to reach a server
  // that is already running.
  applyAppshares();
  return {
    id: deps.identity.defaultDeviceId(),
    name: deps.identity.hostname(),
    port: deps.appshares.portOf(cfg.port),
    user: cred.user,
    token: cred.secret,
  };
}

// A key is minted before the other box has said who it is (its credentials travel
// in the same request), so the row starts under a placeholder id and is adopted
// once the answer names the box. Adoption is what makes "forget this box" reach it.
function adoptShareKey(key, peer) {
  if (!key || !peer) return;
  const cur = deps.config.rawAppshares();
  const rows = (cur.issued || []).filter((x) => x.id !== peer.id);
  const mine = (cur.issued || []).find((x) => x.user === key.user);
  if (!mine) return;
  deps.config.setAppshares({
    issued: [...rows.filter((x) => x.user !== key.user), { ...mine, id: peer.id, name: peer.name }],
  });
  applyAppshares();
}

// A key nobody is named on. A pairing mints one under a placeholder id and adopts
// it when the answer names the box, so a shell that exits between the two leaves a
// working key that "forget this box" cannot reach - no peer row mentions it. Run at
// startup, never during a pairing: the placeholder is legitimately unmatched while
// the exchange is in flight.
function pruneOrphanShareKeys() {
  const cur = deps.config.rawAppshares();
  const named = new Set((cur.peers || []).map((x) => x.id));
  const kept = (cur.issued || []).filter((x) => named.has(x.id));
  if (kept.length === (cur.issued || []).length) return;
  console.log("[appshares] dropping", (cur.issued || []).length - kept.length, "key(s) no box is named on");
  deps.config.setAppshares({ issued: kept });
}

// A key handed to something that turned out not to be a box, or to a pairing that
// failed. It may already be in someone's hands, so it is removed rather than left
// to expire - which for a credential with no expiry means never.
function revokeShareKey(key) {
  if (!key || !key.user) return;
  const cur = deps.config.rawAppshares();
  deps.config.setAppshares({ issued: (cur.issued || []).filter((x) => x.user !== key.user) });
  applyAppshares();
}

// ---- comparing and pulling another box's copy ----

// What a pull would actually do, before anyone presses it. Both sides listed with
// the pull's own filters (an emulator rewrites its config on every exit - unfiltered,
// the other box is always "newer" and the answer is worthless), and the credential
// reaches rclone the same way it does for a copy.
//
// Answers per share, never a file list: the app needs to say "the other room is a
// day ahead", not to be handed the contents of a folder it did not ask for.
function compareAppshare(peerId, shareId) {
  const cfg = deps.config.rawAppshares();
  const peer = (cfg.peers || []).find((x) => x.id === peerId);
  if (!peer) return Promise.resolve({ ok: false, error: "unknown_peer" });
  const entry = appsharesDeps.entries().find((x) => x.id === shareId);
  if (!entry) return Promise.resolve({ ok: false, error: "unknown_share" });
  if (!deps.apps.onPath("rclone")) return Promise.resolve({ ok: false, error: "rclone_missing" });
  let secret;
  try {
    secret = deps.shares.obscure(peer.token);
  } catch (e) {
    return Promise.resolve({ ok: false, error: "compare_failed" });
  }
  const env = {
    ...process.env,
    RCLONE_WEBDAV_USER: String(peer.user || ""),
    RCLONE_WEBDAV_PASS: secret,
  };
  const listing = (argv, useEnv) =>
    new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), {
        env: useEnv ? env : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      // A listing is small (names, sizes, times) but a share is someone else's
      // folder: a cap keeps a hostile or broken peer from feeding us a stream.
      child.stdout.on("data", (d) => {
        if (out.length < 4_000_000) out += d;
      });
      child.stderr.on("data", (d) => {
        if (err.length < 2000) err += d;
      });
      const kill = setTimeout(() => child.kill("SIGKILL"), 25000);
      child.on("error", () => (clearTimeout(kill), resolve(null)));
      child.on("exit", (code) => {
        clearTimeout(kill);
        if (code !== 0) {
          console.warn("[appshares] listing failed:", code, err.slice(0, 200));
          return resolve(null);
        }
        try {
          resolve(JSON.parse(out || "[]"));
        } catch (e) {
          resolve(null);
        }
      });
    });
  // The local side is listed with rclone too, so both answers come from the same
  // filter engine - a pattern that means one thing here and another there would
  // make the comparison lie in exactly the cases it exists for.
  return Promise.all([
    entry.present ? listing(deps.peers.lsArgv(entry.path, entry.exclude, null), false) : Promise.resolve([]),
    listing(deps.peers.lsArgv(":webdav:" + shareId, entry.exclude, peer), true),
  ]).then(([here, there]) => {
    if (!there) return { ok: false, error: "unreachable" };
    // A local listing that FAILED is not an empty folder. Read as one it would
    // report everything on the other box as worth bringing, which is the most
    // dangerous answer this call can give - it is the one that invites the press.
    if (!here) return { ok: false, error: "compare_failed" };
    return { ok: true, ...deps.peers.compareListings(here, there) };
  });
}

// One pull at a time per app. Two rclones copying into the same folder race each
// other's --backup-dir, and a renderer that calls this in a loop would fill the
// disk with copies of what it replaced.
const pullsInFlight = new Set();
const pullBusy = (id) => pullsInFlight.has(id);

// Pull one share from a paired box into the same app's folder here. Both ends are
// resolved from what THIS box knows - the peer from its stored id, the destination
// from the local manifest - so a caller names a share, never a path.
function pullAppshare(peerId, shareId, group) {
  const cfg = deps.config.rawAppshares();
  const peer = (cfg.peers || []).find((x) => x.id === peerId);
  if (!peer) return { ok: false, error: "unknown_peer" };
  const entry = appsharesDeps.entries().find((x) => x.id === shareId);
  if (!entry) return { ok: false, error: "unknown_share" };
  // One emulator's folder instead of the whole share. The name came from a
  // renderer, so it may hold no separator and no dot-name; where it lands is
  // checked again below, against the app's own root, like every other destination.
  if (group && !deps.peers.groupNameOk(group)) return { ok: false, error: "unknown_group" };
  // `present` is what says the folder exists AND still resolves inside the app's
  // own root. Checked here rather than only in the UI: this destination is handed
  // to rclone, and a direct call must not reach past a symlink the screen greys
  // out. A folder the app has simply not created yet is made - a box that has
  // never started the app is the one most likely to want a save brought to it.
  if (!entry.present && !deps.appshares.ensureDir(entry.root, entry.path)) {
    return { ok: false, error: "unknown_share" };
  }
  // The destination is built here, never sent: a share's path plus at most one
  // folder name, and it has to resolve inside the app's root once symlinks are
  // followed - the same check the share itself passed.
  const dest = group ? path.join(entry.path, group) : entry.path;
  if (group && !deps.appshares.ensureDir(entry.root, dest)) return { ok: false, error: "unknown_group" };
  if (!deps.apps.onPath("rclone")) return { ok: false, error: "rclone_missing" };
  // A replaced file goes here rather than into the void, and the stamp is what
  // makes two pulls of the same game distinguishable afterwards.
  const backupDir = path.join(deps.peers.REPLACED, new Date().toISOString().replace(/[:.]/g, "-"));
  const argv = deps.peers.pullArgv(peer, shareId, dest, backupDir, entry.exclude, group || "");
  // rclone wants every credential in its own reversible encoding, whether it comes
  // from a config file or the environment - a plain token answers 401. shares.js
  // owns that encoding for the same reason it owns the mount arguments.
  let secret;
  try {
    secret = deps.shares.obscure(peer.token);
  } catch (e) {
    console.warn("[appshares] could not encode the peer's token:", e.message);
    return { ok: false, error: "pull_failed" };
  }
  const child = spawn(argv[0], argv.slice(1), {
    env: { ...process.env, RCLONE_WEBDAV_USER: String(peer.user || ""), RCLONE_WEBDAV_PASS: secret },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => {
    if (err.length < 4000) err += d;
  });
  return new Promise((resolve) => {
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.on("exit", (code) => {
      if (code === 0) console.log("[appshares] pulled", shareId, "from", peer.name);
      else console.warn("[appshares] pull failed:", code, err.slice(0, 400));
      resolve({ ok: code === 0, error: code === 0 ? null : "pull_failed", detail: err.slice(0, 400) });
    });
  });
}

/**
 * The `shares` capability, scoped to the calling app.
 *
 * It can see the boxes this one has paired with and its OWN shares, and it can
 * pull its OWN share; another app's is not in the list and is refused if named.
 * The destination is never sent - pullAppshare resolves it from the local
 * manifest, because a path from a renderer is a path somebody else chose.
 *
 * THE CAPABILITY CHECK IS THE CALLER'S: main.js refuses an app that does not hold
 * `shares` before it gets here. That is the whole boundary - what this function
 * does is scope an app that already passed it - so a second call site needs the
 * same check, and `pullAppshare`/`compareAppshare` beside it have none at all.
 *
 * The scoping is by OWNERSHIP, not by the owner's toggle: `compare` and `pull` ask
 * whether the share is this app's, never whether Settings has it switched on, so an
 * app can still pull into a share the owner turned off. `list` reports `on` and
 * nothing enforces it.
 */
async function appSharesCall(id, action, payload) {
  const cfg = deps.config.rawAppshares();
  const enabled = new Set(Array.isArray(cfg.enabled) ? cfg.enabled : []);
  const mine = appsharesDeps.entries().filter((x) => x.appId === id);
  if (action === "list") {
    return {
      ok: true,
      // Never the token: an app has no use for one, and the peer list is the only
      // thing here that could carry a credential out of the shell.
      peers: (cfg.peers || []).map((p) => ({ id: p.id, name: p.name })),
      shares: mine.map((x) => ({ id: x.id, name: x.name, present: x.present, on: enabled.has(x.id) })),
    };
  }
  if (action === "compare") {
    const p = payload || {};
    const shareId = String(p.shareId || "");
    if (!mine.some((x) => x.id === shareId)) return { ok: false, error: "unknown_share" };
    return compareAppshare(String(p.peerId || ""), shareId);
  }
  if (action === "pull") {
    const p = payload || {};
    const shareId = String(p.shareId || "");
    if (!mine.some((x) => x.id === shareId)) return { ok: false, error: "unknown_share" };
    if (pullsInFlight.has(id)) return { ok: false, error: "busy" };
    pullsInFlight.add(id);
    try {
      const r = await pullAppshare(String(p.peerId || ""), shareId, p.group ? String(p.group) : "");
      // `detail` is rclone's own stderr, which names the peer's address and the
      // local destination. The list above is careful to hand an app neither.
      return { ok: !!(r && r.ok), error: (r && r.error) || null };
    } finally {
      pullsInFlight.delete(id);
    }
  }
  return { ok: false, error: "unknown shares action" };
}

// rclone is a ~20MB download, so it runs out of process like every other no-root
// binary install - the UI polls the status for `rclone`.
function installRclone() {
  if (rcloneInstalling || deps.apps.onPath("rclone")) return false;
  rcloneInstalling = true;
  const done = () => {
    rcloneInstalling = false;
    if (!deps.apps.onPath("rclone")) return;
    // Both features run on this one binary, so whichever asked for it, everything
    // waiting on it can start now.
    if (deps.config.rawFileserver().enabled) applyFileserver();
    if ((deps.config.rawAppshares().enabled || []).length) applyAppshares();
    if (deps.config.rawShares().length) applyShares();
  };
  deps.installDeps(done);
  return true;
}

module.exports = {
  init,
  fileserverDeps: fileserverDepsOf,
  appsharesDeps: appsharesDepsOf,
  sharesDeps: sharesDepsOf,
  applyFileserver,
  applyAppshares,
  applyShares,
  rememberPeer,
  issueShareKey,
  adoptShareKey,
  pruneOrphanShareKeys,
  revokeShareKey,
  compareAppshare,
  pullAppshare,
  pullBusy,
  appSharesCall,
  installRclone,
  isInstallingRclone,
};
