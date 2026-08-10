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

// Is this an address the sweep could have produced? Pairing only ever follows a
// sweep, so a host outside the box's own /24 - or the box itself - did not come
// from one, and honouring it would turn the route into a way to make this box
// fetch an arbitrary address.
function onLocalSubnet(host, interfaces) {
  const sub = localSubnet(interfaces);
  if (!sub || typeof host !== "string") return false;
  if (host === sub.self) return false;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return false;
  }
  return parts.slice(0, 3).join(".") === sub.prefix;
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

const MAX_BODY = 65536;

function get(url, timeout) {
  return new Promise((resolve) => {
    let done = false;
    let deadline = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (deadline) clearTimeout(deadline);
      resolve(v);
    };
    const req = http.get(url, { timeout: timeout || HTTP_TIMEOUT_MS }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        // A peer answers in bytes, not megabytes. The cap has to END the response
        // rather than just stop appending: a host that keeps a slow body open is
        // never idle, so the socket timeout never fires and it would hold a sweep
        // worker for as long as it liked.
        body += d;
        if (body.length > MAX_BODY) {
          req.destroy();
          finish({ status: res.statusCode, body: body.slice(0, MAX_BODY) });
        }
      });
      res.on("end", () => finish({ status: res.statusCode, body }));
      res.on("error", () => finish(null));
    });
    // The socket timeout measures inactivity, so a trickle keeps it alive forever.
    // This is the whole-request one, and it is what bounds the sweep.
    deadline = setTimeout(
      () => {
        req.destroy();
        finish(null);
      },
      (timeout || HTTP_TIMEOUT_MS) * 2,
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => finish(null));
  });
}

function post(url, body, timeout) {
  const payload = Buffer.from(JSON.stringify(body || {}));
  const u = new URL(url);
  return new Promise((resolve) => {
    let done = false;
    let deadline = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (deadline) clearTimeout(deadline);
      resolve(v);
    };
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        timeout: timeout || HTTP_TIMEOUT_MS,
        headers: { "Content-Type": "application/json", "Content-Length": payload.length },
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          out += d;
          if (out.length > MAX_BODY) {
            req.destroy();
            finish({ status: res.statusCode, body: out.slice(0, MAX_BODY) });
          }
        });
        res.on("end", () => finish({ status: res.statusCode, body: out }));
        res.on("error", () => finish(null));
      },
    );
    deadline = setTimeout(
      () => {
        req.destroy();
        finish(null);
      },
      (timeout || HTTP_TIMEOUT_MS) * 2,
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => finish(null));
    req.end(payload);
  });
}

// The address a request actually came from, which is what a box is remembered by -
// never the one it claims. Node reports an IPv4 peer on a dual-stack socket in the
// mapped form.
function callerAddress(req) {
  const a = (req && req.socket && req.socket.remoteAddress) || "";
  return a.startsWith("::ffff:") ? a.slice(7) : a;
}

// What a box says about itself, checked before any of it is believed. Shared by
// both ends of the exchange: the same answer travels in both directions now, so
// one copy of these rules is one thing to get right.
function peerFrom(out, host) {
  const port = Number(out && out.port);
  const token = out && typeof out.token === "string" ? out.token : "";
  const name = out && typeof out.name === "string" ? out.name.trim().slice(0, 64) : "";
  const id = out && typeof out.id === "string" && out.id ? out.id : name;
  // The user name the other box minted for us. Its own shape is checked where it
  // is stored; here it only has to be a plausible HTTP basic-auth user.
  const user = out && typeof out.user === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(out.user) ? out.user : "";
  if (!host || !name || !token || token.length > 256 || !user) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { id: id.slice(0, 64), name, host, port, user, token };
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

// Pair with a box that is waiting. One code, both directions: this box sends its
// OWN credentials in the same request, so the box on the other side ends up knowing
// this one too. Doing it once per direction would mean walking to the other TV,
// showing a second code and typing it here - for a relationship that is symmetric
// anyway.
//
// The four digits are the gate; a wrong one is refused by the peer, and counts
// towards its own lockout.
async function pairWith(host, code, deps, own) {
  const send = (deps && deps.post) || post;
  const url = "http://" + host + ":" + PAIRING_PORT + "/peer/credentials";
  const r = await send(url, { ...(own || {}), code: String(code || "") });
  if (!r) return { ok: false, error: "unreachable" };
  if (r.status === 403) return { ok: false, error: "bad_code" };
  if (r.status !== 200) return { ok: false, error: "refused" };
  let out;
  try {
    out = JSON.parse(r.body);
  } catch (e) {
    return { ok: false, error: "not_a_box" };
  }
  // A box that answered but would not deal with us says so; without this the
  // screen blames the address for a decision the other end made.
  if (out && typeof out.error === "string" && out.error) return { ok: false, error: out.error };
  const peer = peerFrom(out, host);
  if (!peer) return { ok: false, error: "not_a_box" };
  // Whether the other box could take ours as well. It cannot if it is offering
  // nothing - it has no credential of its own to hand over - and that is worth
  // saying rather than quietly leaving the pairing one-way.
  return { ok: true, peer, mutual: !!(out && out.mutual) };
}

// Pull one share from a peer into the SAME app's folder on this box. The
// destination is resolved here from the local manifest, never sent by a caller:
// a share id names an app, and an app can only ever receive into its own root.
//
// Replaced files are moved aside rather than overwritten. A pull is somebody
// saying "the other room's copy is the one I want", and being wrong about that
// should not be the end of a save.
function pullArgv(peer, shareId, dest, backupDir, exclude, group) {
  const filters = [];
  // The app's own list of what is not worth carrying (a shader cache, a log). These
  // only ever narrow the copy, so a bad pattern costs files that were not wanted -
  // it cannot reach anything the share does not already hold.
  for (const pat of Array.isArray(exclude) ? exclude : []) filters.push("--exclude", String(pat));
  // One emulator's folder rather than the whole share, when asked for. The name is
  // checked before it gets here (main.js), and it can hold no separator - so this
  // adds one level and cannot leave the share.
  const from = ":webdav:" + shareId + (group ? "/" + group : "");
  return [
    "rclone",
    "copy",
    from,
    dest,
    "--webdav-url",
    "http://" + peer.host + ":" + peer.port + "/",
    "--webdav-vendor",
    "other",
    "--webdav-user",
    String(peer.user || ""), // the name that box minted for this one, at pairing
    // The token goes in the environment (RCLONE_WEBDAV_PASS is set by the caller),
    // never here: any process on the box can read a command line.
    "--backup-dir",
    backupDir,
    ...filters,
    "--transfers",
    "2",
    "--timeout",
    "30s",
  ];
}

// What a share holds, on either side of the wire. The same command shape for the
// peer (a webdav remote) and for this box (a path), so the two answers are
// comparable - and with the pull's own filters, because the interesting question is
// "would copying this bring anything newer", not "did any byte change".
//
// rclone reports a WebDAV mtime to the second, so two files written in the same
// second are equal here. That is the resolution the protocol has.
function lsArgv(target, exclude, peer) {
  const filters = [];
  for (const pat of Array.isArray(exclude) ? exclude : []) filters.push("--exclude", String(pat));
  const remote = peer
    ? [
        "--webdav-url",
        "http://" + peer.host + ":" + peer.port + "/",
        "--webdav-vendor",
        "other",
        "--webdav-user",
        String(peer.user || ""),
      ]
    : [];
  return ["rclone", "lsjson", target, "--recursive", "--files-only", ...remote, ...filters, "--timeout", "20s"];
}

// Two listings, one verdict. Everything the screen needs to say whether a pull is
// worth pressing:
//
//   newest    - when each side was last written, so a person can recognise "that is
//               the session I remember"
//   newerThere - files the pull would BRING (missing here, or newer there)
//   olderThere - files it would REPLACE WITH AN OLDER COPY. rclone copies whatever
//               differs, in the direction asked for; it does not prefer the newer
//               file. This is the count that turns a pull into a regret, so it is
//               counted separately rather than folded into "differences".
//   sameTimeDiffers - written in the same second on both sides but not the same
//               size. rclone's default check is size AND modification time, so
//               these WOULD be copied; counting only timestamps would report
//               "nothing to do" for a pull that replaces files.
const MTIME_SLACK_MS = 2000; // WebDAV's second-resolution, plus a second of slack

// Which emulator a file belongs to: the folder it sits in, directly under the
// share. RetroArch keeps saves and states in a directory per core, and an emulator
// that keeps its own (Dolphin) still gets exactly one of them - so this needs no
// list of emulators and no knowledge of what a core is. A file lying directly in
// the share belongs to no group and is counted in the totals only.
function groupOf(p) {
  const i = String(p || "").indexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

function compareListings(here, there) {
  const at = (row) => Date.parse((row && row.ModTime) || "") || 0;
  // A size that is not a number is not a difference. rclone always reports one; a
  // listing that somehow does not would otherwise make every file look changed.
  const sized = (row) => (row && Number.isFinite(Number(row.Size)) ? Number(row.Size) : null);
  const byPath = (rows) => {
    const m = new Map();
    for (const r of Array.isArray(rows) ? rows : []) if (r && r.Path) m.set(r.Path, r);
    return m;
  };
  const a = byPath(here);
  const b = byPath(there);
  const newestOf = (m) => {
    let n = 0;
    for (const r of m.values()) n = Math.max(n, at(r));
    return n || null;
  };
  // Per emulator as well as in total. The totals are what a box-level line says;
  // the groups are what makes "who has the newer save" answerable at all when two
  // rooms played different consoles.
  const groups = new Map();
  const group = (name) => {
    let g = groups.get(name);
    if (!g) {
      g = {
        name,
        here: { newest: null, files: 0 },
        there: { newest: null, files: 0 },
        newerThere: 0,
        olderThere: 0,
        sameTimeDiffers: 0,
      };
      groups.set(name, g);
    }
    return g;
  };
  const stamp = (side, row) => {
    side.files++;
    const t = at(row);
    if (t && (side.newest === null || t > side.newest)) side.newest = t;
  };
  for (const [p, r] of a) stamp(group(groupOf(p)).here, r);
  for (const [p, r] of b) stamp(group(groupOf(p)).there, r);

  let newerThere = 0;
  let olderThere = 0;
  let sameTimeDiffers = 0;
  for (const [p, r] of b) {
    const g = group(groupOf(p));
    const mine = a.get(p);
    if (!mine) {
      newerThere++;
      g.newerThere++;
      continue;
    }
    const d = at(r) - at(mine);
    if (d > MTIME_SLACK_MS) {
      newerThere++;
      g.newerThere++;
    } else if (d < -MTIME_SLACK_MS) {
      olderThere++;
      g.olderThere++;
    } else if (sized(r) !== null && sized(mine) !== null && sized(r) !== sized(mine)) {
      sameTimeDiffers++;
      g.sameTimeDiffers++;
    }
  }
  return {
    here: { newest: newestOf(a), files: a.size },
    there: { newest: newestOf(b), files: b.size },
    newerThere,
    olderThere,
    sameTimeDiffers,
    // Named groups only: the unnamed one is the share's own loose files, which
    // nothing can ask for on their own.
    groups: [...groups.values()].filter((g) => g.name),
  };
}

// A folder name a renderer asked for. It names ONE directory inside a share, so a
// separator is the whole danger and the rest is a length bound: emulator folders
// carry spaces and brackets ("Beetle PSX HW", "Nintendo - GameCube"), and refusing
// those would refuse the very thing this is for. Where it lands is checked again
// against the app's own root before anything is written.
function groupNameOk(name) {
  const n = String(name || "");
  if (!n || n.length > 128) return false;
  if (n.includes("/") || n.includes("\\") || n.includes("\0")) return false;
  return n !== "." && n !== ".." && n.trim() === n;
}

const REPLACED = path.join(os.homedir(), ".cache", "tvbox", "appshares-replaced");

module.exports = {
  PAIRING_PORT,
  MARKER,
  REPLACED,
  localSubnet,
  onLocalSubnet,
  callerAddress,
  peerFrom,
  scan,
  pairWith,
  pullArgv,
  groupOf,
  groupNameOk,
  lsArgv,
  compareListings,
  MTIME_SLACK_MS,
};
