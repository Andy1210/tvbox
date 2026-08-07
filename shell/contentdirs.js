// Which folders on the box hold USER content, as opposed to the box's own
// machinery. One rule, two consumers: the file server offers these over the LAN
// (fileserver.js) and the local media browser walks them on the TV (browse.js).
//
// Nothing here is a list of paths. `~/.tvbox` is filtered by NAME, so a folder a
// future app introduces shows up on its own, and the box user's home is taken as
// it comes - a stranger's box has different folders in it and must need no code
// change here.
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const TVBOX = path.join(HOME, ".tvbox");

// ~/.tvbox is both the box's working directory and where some user content lives.
// This is the machinery half - filtered out so the rest can be offered without a
// list of what to offer (which would go stale the moment an app adds a folder).
const MACHINERY = new Set([
  "appdata", // per-app key/value stores (the `storage` capability)
  "apps", // installed app packages
  "apps-data", // extracted web bundles
  "bin", // no-root binaries (rclone, librespot)
  "cache",
  "current", // OTA symlink
  "fileserver", // where the share root used to live (boxes that ran an early build)
  "librespot-cache",
  "pyenv",
  "__pycache__",
  "shares", // network-share mount points; offered as sources in their own right
  "shell", // the dev tree
  "shell-userdata", // Chromium profile: app logins live here
  "update",
  "versions", // OTA releases
]);

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    return [];
  }
}

// The user's own folders, in a stable order: what lives under ~/.tvbox first, then
// the home directory itself. The id is what a caller stores, so it must not change
// when the list around it does.
function userDirs() {
  const out = [];
  for (const d of subdirs(TVBOX)) {
    if (MACHINERY.has(d) || d.startsWith(".")) continue;
    out.push({ id: "tvbox:" + d, path: path.join(TVBOX, d), name: d });
  }
  for (const d of subdirs(HOME)) {
    if (d.startsWith(".")) continue;
    out.push({ id: "home:" + d, path: path.join(HOME, d), name: d });
  }
  return out;
}

module.exports = { HOME, TVBOX, MACHINERY, isDir, subdirs, userDirs };
