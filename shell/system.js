// The box as a machine: its network, its clock, its keyboard, its name, and the
// numbers Settings shows on the About screen.
//
// All of it is nmcli, hostnamectl, timedatectl, localectl and a few files in
// /proc - user-space calls that work because provision.sh installed the polkit
// grants, never sudo. Everything is async on purpose: these spawn processes, and
// blocking the Electron main thread stops the UI drawing.
const child = require("child_process");
const fs = require("fs");
const os = require("os");

const netguard = require("./netguard");
const pkg = require("./package.json");

// Everything that leaves this process goes through these two, so a test can feed
// the real command output back in - which is what most of the code here is: the
// parsing of formats that are easy to get subtly wrong (nmcli escapes ':' inside a
// value, and an SSID may contain one).
let execFile = child.execFile;

// What a rename means beyond the hostname: the MQTT device id is derived from it
// when unset, so the caller reconnects the bridge. Injected rather than imported,
// since that lives in the shell's own wiring.
let onHostnameChanged = () => {};
function init(deps) {
  if (!deps) return;
  if (deps.onHostnameChanged) onHostnameChanged = deps.onHostnameChanged;
  if (deps.execFile) execFile = deps.execFile;
}

// ---- WiFi (device setting: HOME → Settings shows status + a network picker) ----
// nmcli runs as the shell's (active-session) user; connect falls back to
// passwordless sudo if polkit blocks it. execFile (no shell) - SSID/password are
// literal argv, no injection.
function wifiStatus(cb) {
  execFile("nmcli", ["-t", "-f", "GENERAL.STATE,GENERAL.CONNECTION", "device", "show", "wlan0"], (e, out) => {
    if (e) return cb({ connected: false, ssid: "" });
    let state = "",
      conn = "";
    for (const l of (out || "").split("\n")) {
      if (l.startsWith("GENERAL.STATE:")) state = l.slice(14);
      else if (l.startsWith("GENERAL.CONNECTION:")) conn = l.slice(19).trim();
    }
    cb({ connected: /(^|\D)100(\D|$)/.test(state), ssid: conn && conn !== "--" ? conn : "" });
  });
}
// Ethernet presence + IP (the robust alternative to WiFi on a fixed box). Finds
// the first connected ethernet device (name is eth0/end0-dependent) via nmcli.
function ethernetStatus(cb) {
  execFile("nmcli", ["-t", "-f", "DEVICE,TYPE,STATE", "device"], { timeout: 8000 }, (e, out) => {
    if (e) return cb({ connected: false, ip: "" });
    let dev = "";
    for (const l of (out || "").split("\n")) {
      const p = l.split(":");
      if (p[1] === "ethernet" && p[2] === "connected") {
        dev = p[0];
        break;
      }
    }
    if (!dev) return cb({ connected: false, ip: "" });
    execFile("nmcli", ["-t", "-f", "IP4.ADDRESS", "device", "show", dev], { timeout: 8000 }, (_e2, out2) => {
      const m = /IP4\.ADDRESS\[1\]:([^/\n]+)/.exec(out2 || "");
      cb({ connected: true, ip: m ? m[1].trim() : "", device: dev });
    });
  });
}
// System region for the first-boot wizard + Settings: current timezone + the
// full zone list, and the current X11 keymap + the layout list. The launcher
// groups timezones by region (Europe/Budapest -> Europe > Budapest). ASYNC
// (never block the Electron main thread) and the big STATIC lists are cached
// after the first read, so re-opening the picker doesn't re-spawn 4 processes
// each time (that was blocking the UI). Only current tz/keymap is re-read.
const lines = (s) =>
  String(s || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
let regionListCache = null; // { timezones, keymaps } - static lists, cached after a successful fetch
function systemRegion(cb) {
  const readCurrent = (lists) =>
    execFile("timedatectl", ["show", "-p", "Timezone", "--value"], { timeout: 5000 }, (e, tzOut) => {
      const timezone = e ? "" : String(tzOut).trim();
      execFile("localectl", ["status"], { timeout: 5000 }, (e2, st) => {
        const m = /X11 Layout:\s*(\S+)/.exec(String(st || ""));
        cb({ timezone, keymap: m ? m[1] : "", timezones: lists.timezones, keymaps: lists.keymaps });
      });
    });
  if (regionListCache) return readCurrent(regionListCache);
  execFile("timedatectl", ["list-timezones"], { timeout: 8000 }, (e, tzs) => {
    execFile("localectl", ["list-x11-keymap-layouts"], { timeout: 8000 }, (e2, kms) => {
      const lists = { timezones: lines(tzs), keymaps: lines(kms) };
      // Cache only a SUCCESSFUL, non-empty fetch. A transient failure (the wizard
      // opens before systemd-localed/timedated is up, or the 8s timeout trips
      // under first-boot load) must not poison the cache with empty lists - a
      // truthy empty cache would blank the region picker for the life of the
      // shell. On failure we serve this one call and re-fetch next time.
      if (!e && !e2 && lists.timezones.length && lists.keymaps.length) regionListCache = lists;
      readCurrent(lists);
    });
  });
}
// timedatectl set-timezone works from the box user's active session (polkit
// allows timedate1.set-timezone). localectl set-x11-keymap needs the locale1
// polkit grant provision installs (auth is required by default).
function setTimezone(tz, cb) {
  if (!/^[A-Za-z0-9_+/][A-Za-z0-9_+/-]{0,63}$/.test(tz)) return cb({ ok: false, error: "bad timezone" });
  execFile("timedatectl", ["set-timezone", tz], { timeout: 8000 }, (e) =>
    cb(e ? { ok: false, error: String(e.message || e).slice(0, 120) } : { ok: true }),
  );
}
function setKeymap(layout, cb) {
  if (!/^[a-z0-9][a-z0-9,_-]{0,31}$/.test(layout)) return cb({ ok: false, error: "bad layout" });
  execFile("localectl", ["set-x11-keymap", layout], { timeout: 8000 }, (e) =>
    cb(e ? { ok: false, error: String(e.message || e).slice(0, 120) } : { ok: true }),
  );
}
// hostnamectl set-hostname needs the hostname1 polkit grant provision installs
// (set-hostname / set-static-hostname require admin auth by default). Sets the
// static + transient name; /etc/hosts is left to tvbox-firstboot (root) - a
// stale 127.0.1.1 line only costs a cosmetic sudo warning. Name = one RFC-1123
// label (letters/digits/hyphen, 1-63, no leading/trailing hyphen).
function setHostname(name, cb) {
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(name)) return cb({ ok: false, error: "bad hostname" });
  execFile("hostnamectl", ["set-hostname", name], { timeout: 8000 }, (e) => {
    if (e) return cb({ ok: false, error: String(e.message || e).slice(0, 120) });
    // The MQTT device id is DERIVED from the hostname when unset (identity.js), so a
    // rename changes which topics the box belongs on. Tell the caller, so it can
    // reconnect now rather than at the next start - otherwise Settings reports one
    // id while the bridge publishes under another.
    onHostnameChanged();
    cb({ ok: true });
  });
}
function wifiList(cb) {
  execFile(
    "nmcli",
    ["-t", "-f", "ACTIVE,SIGNAL,SECURITY,SSID", "device", "wifi", "list", "--rescan", "auto"],
    { timeout: 20000 },
    (e, out) => {
      if (e) return cb([]);
      const seen = new Set(),
        nets = [];
      for (const raw of (out || "").split("\n")) {
        if (!raw) continue;
        // nmcli -t escapes ':' inside values as '\:'. SSID is last (may contain ':').
        const line = raw.replace(/\\:/g, "\0");
        const m = /^(yes|no):(\d*):([^:]*):(.*)$/.exec(line);
        if (!m) continue;
        const ssid = m[4].replace(/\0/g, ":");
        if (!ssid || seen.has(ssid)) continue;
        seen.add(ssid);
        nets.push({ ssid, signal: Number(m[2]) || 0, secured: !!(m[3] && m[3] !== "--"), active: m[1] === "yes" });
      }
      nets.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.signal - a.signal);
      const top = nets.slice(0, 30);
      // Mark networks with a saved profile so the UI can offer "forget". Name
      // match covers profiles our own connect created; the active network always
      // has a profile regardless of its name.
      wifiSavedConnections((names) => {
        const saved = new Set(names);
        for (const n of top) n.known = n.active || saved.has(n.ssid);
        cb(top);
      });
    },
  );
}
function wifiConnect(ssid, password, hidden, cb) {
  if (!ssid) return cb({ ok: false, error: "no ssid" });
  // `--wait` is a GLOBAL option and only parses before the subcommand; nmcli
  // answers "invalid extra argument" for one at the end. It is here so nmcli
  // bounds itself rather than being killed: its own default is 90s, longer than
  // anyone waits at a TV, and a process we kill reports nothing.
  const args = ["--wait", String(NM_WAIT_S), "device", "wifi", "connect", ssid];
  if (password) args.push("password", password);
  // Hidden networks aren't in the scan list, so nmcli must be told to probe for
  // the SSID instead of matching a scan result.
  if (hidden) args.push("hidden", "yes");
  const run = () =>
    execFile("nmcli", args, { timeout: (NM_WAIT_S + 5) * 1000 }, (e, _o, err) => {
      if (!e) return cb({ ok: true });
      execFile("sudo", ["-n", "nmcli", ...args], { timeout: (NM_WAIT_S + 5) * 1000 }, (e2, _o2, err2) => {
        if (!e2) return cb({ ok: true });
        const error = String(err2 || err || e.message || "")
          .trim()
          .slice(0, 160);
        console.warn("[wifi] connect to", ssid, "failed:", error);
        cb({ ok: false, error });
      });
    });
  // `nmcli device wifi connect` FINDS A MATCHING PROFILE or creates one, and a
  // profile that exists brings its own stored secret: the password just typed is
  // then never tried, and a network whose password changed fails at once with
  // "Secrets were required, but not provided". Typing one is the answer to that,
  // so the stale profile goes first. Only when a password was given, and never
  // for a profile that is not this network's.
  if (!password) return run();
  wifiSavedConnections((names) => {
    if (!names.includes(ssid)) return run();
    execFile("nmcli", ["connection", "delete", "id", ssid], { timeout: 8000 }, (e) => {
      if (e) execFile("sudo", ["-n", "nmcli", "connection", "delete", "id", ssid], { timeout: 8000 }, run);
      else run();
    });
  });
}
// Saved (known) WiFi connection profile names. `nmcli device wifi connect` names
// the profile after the SSID, so name==ssid is the common case; renamed or
// NM-suffixed ("MyNet 1") profiles are handled by the SSID lookup in wifiForget.
// How long nmcli may spend on a connect. Long enough for a DHCP lease on a slow
// AP, short enough that a wrong password is an answer and not a hang.
const NM_WAIT_S = 30;

function wifiSavedConnections(cb) {
  execFile("nmcli", ["-t", "-f", "NAME,TYPE", "connection", "show"], { timeout: 8000 }, (e, out) => {
    if (e) return cb([]);
    const names = [];
    for (const raw of (out || "").split("\n")) {
      if (!raw) continue;
      // nmcli -t escapes BOTH '\' and ':' inside values ('\\' and '\:');
      // tokenize both so a name containing a backslash still parses (a lone
      // '\:'-only pass would eat the field separator after a trailing '\').
      const line = raw.replace(/\\\\/g, "\u0001").replace(/\\:/g, "\u0000");
      const m = /^(.*):([^:]*)$/.exec(line);
      if (!m) continue;
      if (m[2] !== "802-11-wireless" && m[2] !== "wifi") continue;
      names.push(m[1].replace(/\u0000/g, ":").replace(/\u0001/g, "\\"));
    }
    cb(names);
  });
}
// Forget a saved network: delete every NM profile stored for the SSID - the
// profile named exactly like the SSID (what our own connect creates) plus any
// profile whose 802-11-wireless.ssid matches (renamed/suffixed duplicates).
// Same user-then-passwordless-sudo ladder as wifiConnect.
function nmcliDeleteConnection(name, cb) {
  const args = ["connection", "delete", "id", name];
  execFile("nmcli", args, { timeout: 15000 }, (e) => {
    if (!e) return cb(true);
    execFile("sudo", ["-n", "nmcli", ...args], { timeout: 15000 }, (e2) => cb(!e2));
  });
}
function wifiForget(ssid, cb) {
  if (!ssid) return cb({ ok: false, error: "no ssid" });
  wifiSavedConnections((names) => {
    const direct = names.filter((n) => n === ssid);
    const rest = names.filter((n) => n !== ssid);
    const delAll = (targets) => {
      if (!targets.length) return cb({ ok: false, error: "no saved network: " + ssid.slice(0, 64) });
      let okAny = false,
        i = 0;
      const step = () => {
        if (i >= targets.length) return cb(okAny ? { ok: true } : { ok: false, error: "delete failed" });
        nmcliDeleteConnection(targets[i++], (ok) => {
          okAny = okAny || ok;
          step();
        });
      };
      step();
    };
    // Check the differently-named profiles' stored SSID one by one (sequential:
    // a box has a handful of profiles at most).
    const matchRest = (i, acc) => {
      if (i >= rest.length) return delAll(direct.concat(acc));
      execFile("nmcli", ["-g", "802-11-wireless.ssid", "connection", "show", rest[i]], { timeout: 8000 }, (e, out) => {
        const v = String(out || "")
          .trim()
          .replace(/\\:/g, ":");
        matchRest(i + 1, !e && v === ssid ? acc.concat(rest[i]) : acc);
      });
    };
    matchRest(0, []);
  });
}

// ---- system info (read-only diagnostics for HOME → Settings → About) ----
function cpuTempC() {
  try {
    const n = parseInt(fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8"), 10);
    return isFinite(n) ? Math.round(n / 100) / 10 : null;
  } catch (e) {
    return null;
  } // millidegrees -> °C, 0.1 res
}
function memInfo() {
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (k) => {
      const r = new RegExp("^" + k + ":\\s+(\\d+)", "m").exec(m);
      return r ? Number(r[1]) : null;
    };
    return { totalKb: kb("MemTotal"), availableKb: kb("MemAvailable") }; // MemAvailable = the "free" that matters
  } catch (e) {
    return { totalKb: null, availableKb: null };
  }
}
function deviceModel() {
  try {
    return fs.readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
  } catch (e) {
    return "";
  }
}
// SD-card space for About - installs/OTA fail invisibly on a full disk otherwise.
function diskInfo() {
  try {
    const s = fs.statfsSync(os.homedir());
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch (e) {
    return null;
  }
}

function systemInfo(cb) {
  const info = {
    version: pkg.version || "",
    hostname: os.hostname(),
    model: deviceModel(),
    ip: netguard.lanIp(),
    uptimeSec: Math.round(os.uptime()),
    cpuTempC: cpuTempC(),
    mem: memInfo(),
    disk: diskInfo(),
    wifi: { ssid: "", signal: null }, // empty on Ethernet
  };
  execFile("nmcli", ["-t", "-f", "ACTIVE,SIGNAL,SSID", "device", "wifi"], { timeout: 8000 }, (e, out) => {
    if (!e)
      for (const raw of (out || "").split("\n")) {
        if (!raw.startsWith("yes:")) continue; // the connected network
        // The sentinel is NUL, not a space, for the same reason wifiList uses it: an
        // SSID may contain a space, and putting the colons back would corrupt it.
        const m = /^yes:(\d*):(.*)$/.exec(raw.replace(/\\:/g, "\0")); // nmcli -t escapes ':' in values
        if (m) {
          info.wifi.signal = m[1] ? Number(m[1]) : null;
          info.wifi.ssid = m[2].replace(/\0/g, ":");
        }
        break;
      }
    cb(info);
  });
}

module.exports = {
  init,
  memInfo,
  wifiStatus,
  ethernetStatus,
  systemRegion,
  setTimezone,
  setKeymap,
  setHostname,
  wifiList,
  wifiConnect,
  wifiSavedConnections,
  wifiForget,
  systemInfo,
};
