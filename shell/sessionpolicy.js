// What every browser session on the box is held to.
//
// Two things, applied to the default session (the launcher and local apps) and
// to every partition a remote app gets:
//
// - Permissions are refused unless listed. Electron's default is to GRANT: a
//   remote site, or any third-party script on an origin an app declared, would
//   otherwise get the microphone and camera (the monitor source of the box's
//   own audio included), clipboard reads, MIDI sysex. Nothing on a TV asks a
//   person before that happens, so the list is what a TV app needs to show a
//   picture, and nothing else. Device choosers (WebHID, WebSerial, WebUSB,
//   Web Bluetooth) are refused outright: those reach the remotes and pads.
// - Every request a page sends to the shell's own API is stamped with who sent
//   it (apigate.js), which is how the API tells the launcher from an app.
const apigate = require("./apigate");

const ALLOWED = new Set([
  "fullscreen",
  "pointerLock",
  "keyboardLock",
  "clipboard-sanitized-write",
  "mediaKeySystem",
  "storage-access",
  "top-level-storage-access",
]);

function permissionAllowed(permission) {
  return ALLOWED.has(String(permission || ""));
}

/**
 * @param ses       an Electron session
 * @param opts.port the shell API port
 * @param opts.identityOf (webContentsId) -> "launcher" | "app:<id>" | "unknown"
 * @param opts.log  where a refusal is reported
 */
function harden(ses, opts) {
  if (!ses || ses.__tvboxHardened) return;
  ses.__tvboxHardened = true;
  const log = opts.log || (() => {});
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    const ok = permissionAllowed(permission);
    if (!ok) log("refused permission", permission);
    cb(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));
  if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false);
  ses.on("select-hid-device", (e, _details, cb) => {
    e.preventDefault();
    cb("");
  });
  ses.on("select-serial-port", (e, _ports, _wc, cb) => {
    e.preventDefault();
    cb("");
  });
  ses.on("select-usb-device", (e, _details, cb) => {
    e.preventDefault();
    cb();
  });
  const urls = ["http://localhost:" + opts.port + "/*", "http://127.0.0.1:" + opts.port + "/*"];
  ses.webRequest.onBeforeSendHeaders({ urls }, (details, cb) => {
    let who = "unknown";
    try {
      who = opts.identityOf(details.webContentsId);
    } catch (e) {}
    cb({ requestHeaders: apigate.stamp(details.requestHeaders, who) });
  });
}

/**
 * Whether a top-level navigation of a window of ours may go to `url`: the same
 * origin as the shell's own server, and inside `prefix` when one is given (a
 * local app's own directory). The launcher and local-app windows run with Node
 * reachable from the preload and without context isolation, so a foreign page
 * loaded into one would inherit the window's app identity and its brokers.
 */
function localNavAllowed(url, base, prefix) {
  let u;
  let b;
  try {
    u = new URL(url);
    b = new URL(base);
  } catch (e) {
    return false;
  }
  if (u.origin !== b.origin) return false;
  return !prefix || u.pathname === prefix.replace(/\/$/, "") || u.pathname.startsWith(prefix);
}

module.exports = { harden, permissionAllowed, localNavAllowed, ALLOWED };
