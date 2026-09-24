// Who is calling the shell's HTTP API, and what that caller may reach.
//
// Every `serve: local` app is served from the same origin as the API, so the
// Origin/Sec-Fetch-Site gate cannot tell the launcher from an app: both are
// "same origin". That made every local app as strong as the launcher - it could
// add an app registry, install a package, read another app's pairing code. The
// identity has to come from somewhere a page cannot reach, and that is the
// browser itself: main stamps every request its own pages make (webRequest, per
// session) with a per-boot secret and the id of the window that made it, and the
// server reads the stamp back here.
//
// Three kinds of caller:
// - `launcher` - the main window. Everything, as before.
// - `app` - an app window. The routes the app API documents, its OWN plugin's
//   routes, and nothing else.
// - `local` - a process of the box's own (the CEC and remote bridges, the voice
//   satellite, a plugin's own daemon calling back), proven by the per-boot token
//   the shell writes to ~/.tvbox/local-token (0600) and the process sends back as
//   X-Tvbox-Local. Reads, plugin routes, and the few writes those processes make.
//   A request with no headers at all is NOT this: mpv fetching a URL an app gave
//   it, or a sandboxed program on loopback, sends exactly that.
// Anything else - a stamp with the wrong secret, a browser request that somehow
// carries none, a bare request without the token - is `unknown`, which gets the
// public reads only.
const crypto = require("crypto");
const os = require("os");

const HEADER = "x-tvbox-caller";
const LOCAL_HEADER = "x-tvbox-local";
const SECRET = crypto.randomBytes(18).toString("base64url");
let localToken = null; // set by main once it has written the token file

function setLocalToken(t) {
  localToken = t ? String(t) : null;
}

function localTokenOk(raw) {
  if (!localToken || raw === undefined) return false;
  const a = Buffer.from(String(raw));
  const b = Buffer.from(localToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The value main puts on a request from `identity` ("launcher" | "app:<id>" | "unknown"). */
function stampValue(identity) {
  return SECRET + " " + identity;
}

/**
 * Replace any caller header a page set itself with ours. Header names in
 * Electron's `requestHeaders` keep the page's spelling, so every case variant
 * goes.
 */
function stamp(requestHeaders, identity) {
  const out = {};
  for (const [k, v] of Object.entries(requestHeaders || {})) {
    const name = k.toLowerCase();
    if (name !== HEADER && name !== LOCAL_HEADER) out[k] = v;
  }
  out["X-Tvbox-Caller"] = stampValue(identity);
  return out;
}

/** Read the caller off a request, and remove the stamp so no handler ever sees the secret. */
function identify(req) {
  const h = (req && req.headers) || {};
  const raw = h[HEADER];
  const local = h[LOCAL_HEADER];
  delete h[HEADER];
  delete h[LOCAL_HEADER];
  if (raw === undefined) {
    // No stamp. A browser always sends one of these to loopback; a process of the
    // box's own sends the local token instead.
    const browser = h.origin || h["sec-fetch-site"] || h["sec-fetch-mode"] || h["sec-fetch-dest"];
    return !browser && localTokenOk(local) ? { kind: "local" } : { kind: "unknown" };
  }
  const s = String(raw);
  const at = s.indexOf(" ");
  const presented = Buffer.from(at > 0 ? s.slice(0, at) : s);
  const expected = Buffer.from(SECRET);
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return { kind: "unknown" };
  const who = at > 0 ? s.slice(at + 1) : "";
  if (who === "launcher") return { kind: "launcher" };
  if (who.startsWith("app:") && who.length > 4) return { kind: "app", id: who.slice(4) };
  return { kind: "unknown" };
}

// The shell routes an app may call: the table in docs/app-api.md, plus the
// pairing session its own phone screen runs. Keep the two in step.
const APP_GET = new Set([
  "/tvbox/api/config",
  "/tvbox/api/apps",
  "/tvbox/api/widgets",
  "/tvbox/api/system/info",
  "/tvbox/api/system/region",
  "/tvbox/api/display/status",
  "/tvbox/api/audio/sinks",
  "/tvbox/api/pairing/status",
  "/tvbox/api/photoshare",
  "/tvbox/api/photoshare/thumb",
  "/tvbox/api/photoshare/image",
]);
const APP_GET_PREFIX = ["/tvbox/api/browse/"];
const APP_POST = new Set([
  "/tvbox/api/nowplaying",
  "/tvbox/api/notify",
  "/tvbox/api/nav",
  "/tvbox/api/parental/verify",
  "/tvbox/api/apps/quit",
  "/tvbox/api/browse/mount",
  "/tvbox/api/browse/unmount",
  "/tvbox/api/photoshare/clear",
  "/tvbox/api/pairing/start",
  "/tvbox/api/pairing/stop",
  "/tvbox/api/config",
]);
// What an app holding the `config` capability may write through POST /config.
// The rest of the config (MQTT credentials, update settings, the network) is the
// launcher's.
const APP_CONFIG_SECTIONS = new Set(["iptv", "parental", "player"]);
// The writes the box's own processes make.
const LOCAL_POST = new Set(["/tvbox/api/nav", "/tvbox/api/notify", "/tvbox/api/ir/send", "/tvbox/api/remote/reset"]);
// Reads an `unknown` caller may still make: nothing about the box's setup.
const PUBLIC_GET = new Set(["/tvbox/api/config", "/tvbox/api/system/region"]);

/**
 * Decide one request. Answers null to let it through, or a short reason.
 *
 * @param c.caller      what identify() said
 * @param c.method      the HTTP method
 * @param c.path        the decoded path
 * @param c.pluginOwner the app id whose plugin serves this path, null for a
 *                      route the bare host registered, undefined for none
 * @param c.caps        the calling app's capabilities
 * @param c.body        the parsed body, for the routes whose answer depends on it
 * @param c.pairingOwner (kind) -> the app id that registered a pairing kind,
 *                      null for a built-in one
 * @param c.foreground  the app id in front, null for the launcher
 */
function decide(c) {
  const p = c.path || "";
  if (!p.startsWith("/tvbox/api/")) return null; // pages, bundles, icons
  const caller = c.caller || { kind: "unknown" };
  if (caller.kind === "launcher") return null;
  const isGet = c.method === "GET" || c.method === "HEAD";
  const plugin = c.pluginOwner !== undefined;

  if (caller.kind === "local") {
    if (plugin) return null;
    if (isGet) return p.startsWith("/tvbox/api/backup/") ? "launcher only" : null;
    return LOCAL_POST.has(p) ? null : "not for a local process";
  }

  if (caller.kind === "app") {
    if (plugin) return c.pluginOwner === caller.id ? null : "another app's route";
    if (isGet) return APP_GET.has(p) || APP_GET_PREFIX.some((x) => p.startsWith(x)) ? null : "launcher only";
    if (!APP_POST.has(p)) return "launcher only";
    if (p === "/tvbox/api/config") {
      if (!(c.caps || []).includes("config")) return "no config capability";
      const sections = Object.keys((c.body && typeof c.body === "object" && c.body) || {});
      const bad = sections.find((s) => !APP_CONFIG_SECTIONS.has(s));
      if (bad) return "config section not for apps: " + bad;
      // An app may set the lock's groups freely, but changing or clearing the PIN,
      // or whether it is asked for, needs the current PIN (none is needed to set
      // the first one).
      const parental = c.body && c.body.parental;
      if (parental && typeof parental === "object" && ("pin" in parental || "requirePin" in parental)) {
        const ok = typeof c.parentalPinOk === "function" && c.parentalPinOk(parental.currentPin);
        if (!ok) return "parental pin required";
      }
      return null;
    }
    // Only the app in front may move the screen, and an app may close only itself.
    if (p === "/tvbox/api/nav") {
      const self = c.body && c.body.dest === "app" && c.body.app === caller.id;
      return c.foreground === caller.id || self ? null : "not the foreground app";
    }
    if (p === "/tvbox/api/apps/quit") return c.body && c.body.id === caller.id ? null : "only its own window";
    if (p === "/tvbox/api/pairing/start") {
      const kind = c.body && typeof c.body.kind === "string" ? c.body.kind : null;
      const owner = c.pairingOwner ? c.pairingOwner(kind) : undefined;
      // An app may open its own phone page, and the two shared ones any app's
      // screen can use. Never another app's, whose page talks to that app's
      // plugin with the code this answer carries.
      if (owner === caller.id || (owner === null && SHARED_PAIRING.has(kind))) return null;
      return "pairing kind not this app's";
    }
    return null;
  }

  // unknown: a window no app owns (a sign-in popup, a window a plugin opened for
  // an OAuth redirect back to its own callback route).
  if (isGet && (plugin || PUBLIC_GET.has(p))) return null;
  return "unidentified caller";
}
const SHARED_PAIRING = new Set(["photoshare", "text"]);

/**
 * Host header check, against DNS rebinding: a page on a name that resolves to
 * 127.0.0.1 is same-origin with ITSELF, so its reads carry no Origin and
 * `Sec-Fetch-Site: same-origin`. The Host header still names it.
 *
 * @param allowed hostnames (no port) this server answers to
 * @param port    the port it listens on
 */
function hostAllowed(req, allowed, port) {
  const raw = String((req && req.headers && req.headers.host) || "").toLowerCase();
  if (!raw) return true; // HTTP/1.0 client with no Host, which no browser is
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw) || /^([^:]+)(?::(\d+))?$/.exec(raw);
  if (!m) return false;
  if (String(port) !== (m[2] || "80")) return false;
  // An IPv6 zone id ("[fe80::1%25wlan0]") names the client's interface, not a
  // different host; the list holds addresses without it.
  const name = m[1].replace(/%.*$/, "");
  return allowed.includes(name);
}

// Suffixes a home router hands out for its LAN names. The ones the network
// announced (resolv.conf `search`/`domain`, filled from DHCP) are added per
// request; this fixed list covers the common defaults. A suffix outside both is
// refused, because "<hostname>.<anything>" would let a public name that
// resolves to the box pass the rebinding check.
const LAN_SUFFIXES = ["local", "lan", "home", "home.arpa", "internal", "localdomain", "intranet"];

function announcedSuffixes(readFile) {
  try {
    const text = (readFile || ((f) => require("fs").readFileSync(f, "utf8")))("/etc/resolv.conf");
    const out = [];
    for (const line of text.split("\n")) {
      const m = /^\s*(search|domain)\s+(.+)$/.exec(line);
      if (!m) continue;
      for (const d of m[2].trim().split(/\s+/)) {
        const clean = d.toLowerCase().replace(/\.$/, "");
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(clean)) out.push(clean);
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

/**
 * The names a LAN-facing server of this box answers to: every address it has
 * right now, its hostname (and the mDNS spelling), and loopback. Read per
 * request, because an address changes with the network.
 */
function boxNames() {
  const names = new Set(["localhost", "127.0.0.1", "::1"]);
  const host = String(os.hostname() || "").toLowerCase();
  if (host) {
    names.add(host);
    for (const suffix of [...LAN_SUFFIXES, ...announcedSuffixes()]) names.add(host + "." + suffix);
  }
  for (const list of Object.values(os.networkInterfaces() || {}))
    for (const a of list || []) if (a && a.address) names.add(String(a.address).toLowerCase().split("%")[0]);
  return [...names];
}

/**
 * May the script at `p` be registered as a service worker? Its default scope is
 * its own directory, and the server never widens that with Service-Worker-Allowed,
 * so a script inside /<id>/ of a local app can only ever control that app's pages.
 * Anything else (the root-mounted web client at /, the launcher's /tvbox/, the API)
 * is refused.
 */
function serviceWorkerAllowed(p, isLocalApp) {
  const parts = String(p || "").split("/");
  const seg = (parts[1] || "").toLowerCase();
  if (parts.length < 3 || !seg || seg === "tvbox" || !/^[a-z0-9_-]+$/.test(seg)) return false;
  return !!isLocalApp(seg);
}

// mpv fetches a URL with no browser headers at all, so a stream aimed at the box
// itself would reach the shell's own servers as a request from the box, not from
// the app that queued it. Nothing the box plays is served from its own address.
function pointsAtThisBox(u) {
  let host;
  try {
    host = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch (e) {
    return true; // unparseable: refuse rather than hand it to mpv
  }
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::") return true;
  if (/^127\./.test(host) || host === "::1" || /^::ffff:(127\.|7f)/.test(host)) return true;
  return boxNames().includes(host);
}

function lanHostAllowed(req, port) {
  return hostAllowed(req, boxNames(), port);
}

module.exports = {
  HEADER,
  LOCAL_HEADER,
  setLocalToken,
  stamp,
  stampValue,
  identify,
  decide,
  hostAllowed,
  lanHostAllowed,
  serviceWorkerAllowed,
  pointsAtThisBox,
  boxNames,
  announcedSuffixes,
  APP_GET,
  APP_POST,
  LOCAL_POST,
  APP_CONFIG_SECTIONS,
};
