// The per-boot token the box's own processes prove themselves with when they call
// the shell's API (see apigate.js). Written once at start to ~/.tvbox/local-token,
// readable only by this user; a process that wants to count as the box's reads it
// and sends it as X-Tvbox-Local. A sandbox without access to ~/.tvbox cannot.
"use strict";
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fsutil = require("./fsutil");

const FILE = path.join(os.homedir(), ".tvbox", "local-token");

function create(file) {
  const token = crypto.randomBytes(24).toString("base64url");
  fsutil.writeFileAtomic(file || FILE, token + "\n", { mode: 0o600 });
  return token;
}

module.exports = { create, FILE };
