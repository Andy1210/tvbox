// The other tvbox in the house: how this one finds it, how it gets a credential
// for its shares, and how it pulls a folder across. The half that OFFERS is
// appshares.js; this is the half that fetches.
//
// Finding it without asking anyone to type an address. A box only opens the
// pairing port while it is actually waiting to pair (pairing/index.js starts the
// server on demand and stops it after five minutes), so a sweep for that port
// finds exactly the box someone just walked up to - not every box on the LAN,
// and nothing at all when nobody is offering. That is also why the sweep is
// cheap: one TCP connect per address on the box's own /24.
//
// The credential is not the user's. The peer hands over a token minted for its
// shares alone (appshares), gated by the four digits on its screen, so nothing
// here ever sees the file server's password - and the peer can revoke this one
// without touching anything else.
//
// Pull only, never push. Two boxes playing the same game would otherwise
// overwrite each other's save the moment both quit, and the loser would never
// know. Someone sits down at a box and asks for the newest copy; that is the
// whole model, and it is why this module has no upload.
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const PAIRING_PORT = 8099; // pairing/index.js
const SCAN_TIMEOUT_MS = 400; // a LAN host answers a connect in single-digit ms
const SCAN_CONCURRENCY = 64;
const HTTP_TIMEOUT_MS = 3000;
// The peer page carries this so a sweep can tell a box waiting to pair from
// anything else that happens to hold the port open.
const MARKER = "tvbox-peer-pairing";

// The box's own IPv4 /24. A home LAN is flat and this is what a sweep can cover
// in under a second; anything else is somebody's routed network, where a box is
// reachable by address and this discovery is not the answer anyway.
function localSubnet(interfaces) {
  const ifaces = interfaces || os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // /24 only: a wider mask is more addresses than a sweep should touch.
      if (a.netmask && a.netmask !== "255.255.255.0") continue;
      const parts = a.address.split(".");
      return { prefix: parts.slice(0, 3).join("."), self: a.address };
    }
  }
  return null;
}

function portOpen(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeout || SCAN_TIMEOUT_MS);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

function get(url, timeout) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeout || HTTP_TIMEOUT_MS }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        // A peer answers in bytes, not megabytes; anything longer is not ours.
        if (body.length < 65536) body += d;
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// Boxes on the LAN that are waiting to pair right now.
async function scan(deps) {
  const d = deps || {};
  const sub = (d.localSubnet || localSubnet)();
  if (!sub) return [];
  const open = d.portOpen || portOpen;
  const fetchUrl = d.get || get;
  const hosts = [];
  for (let i = 1; i <= 254; i++) {
    const host = sub.prefix + "." + i;
    if (host !== sub.self) hosts.push(host);
  }
  const found = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= hosts.length) return;
      const host = hosts[i];
      if (!(await open(host, PAIRING_PORT))) continue;
      // The port being open is not proof: ask for the page and look for the marker.
      const r = await fetchUrl("http://" + host + ":" + PAIRING_PORT + "/");
      if (r && r.status === 200 && r.body.includes(MARKER)) found.push({ host });
    }
  }
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
  return found;
}

// Ask a box that is waiting to pair for a credential to its shares. The four
// digits are the gate; a wrong one is refused by the peer, which also counts it
// towards its own lockout.
async function pairWith(host, code, deps) {
  const fetchUrl = (deps && deps.get) || get;
  const url = "http://" + host + ":" + PAIRING_PORT + "/peer/credentials?c=" + encodeURIComponent(String(code || ""));
  const r = await fetchUrl(url);
  if (!r) return { ok: false, error: "unreachable" };
  if (r.status === 403) return { ok: false, error: "bad_code" };
  if (r.status !== 200) return { ok: false, error: "refused" };
  let out;
  try {
    out = JSON.parse(r.body);
  } catch (e) {
    return { ok: false, error: "not_a_box" };
  }
  if (!out || !out.token || !out.port || !out.name) return { ok: false, error: "not_a_box" };
  return {
    ok: true,
    peer: {
      id: String(out.id || out.name),
      name: String(out.name),
      host,
      port: Number(out.port),
      token: String(out.token),
    },
  };
}

// Pull one share from a peer into the SAME app's folder on this box. The
// destination is resolved here from the local manifest, never sent by a caller:
// a share id names an app, and an app can only ever receive into its own root.
//
// Replaced files are moved aside rather than overwritten. A pull is somebody
// saying "the other room's copy is the one I want", and being wrong about that
// should not be the end of a save.
function pullArgv(peer, shareId, dest, backupDir) {
  return [
    "rclone",
    "copy",
    ":webdav:" + shareId,
    dest,
    "--webdav-url",
    "http://" + peer.host + ":" + peer.port + "/",
    "--webdav-vendor",
    "other",
    "--webdav-user",
    "tvbox",
    // The token goes in the environment (RCLONE_WEBDAV_PASS is set by the caller),
    // never here: any process on the box can read a command line.
    "--backup-dir",
    backupDir,
    "--transfers",
    "2",
    "--timeout",
    "30s",
  ];
}

const REPLACED = path.join(os.homedir(), ".cache", "tvbox", "appshares-replaced");

module.exports = {
  PAIRING_PORT,
  MARKER,
  REPLACED,
  localSubnet,
  scan,
  pairWith,
  pullArgv,
};
