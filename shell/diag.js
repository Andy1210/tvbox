// What one box says about itself, so several of them can be looked at together.
//
// Every number here already exists somewhere on the box, and that is the problem
// the fleet payload solves: the version is in the shell, the update outcome is in
// ~/.tvbox/update, the link rate is in NetworkManager and the temperature is in
// sysfs, so answering "which box is on an old release" or "which one rolled back
// last night" means visiting each box by hand. Collected here, published retained
// on tvbox/<id>/diag (mqtt.js), it is one subscribe for the whole fleet.
//
// Two things shape what is in it:
//
//   • A ROLLBACK is only legible for as long as its marker survives. deploy/run-shell.sh
//     writes update/failed ("<prev> <new>") when a release loses its three boot
//     attempts, and nothing else records that it happened, so the file's mtime is
//     the only timestamp there is. Publishing it retained is what turns a silent
//     overnight rollback into something a dashboard can show the next morning.
//   • The wifi LINK RATE, not just the signal, because a link can sit at full bars
//     and still negotiate 10 Mbit/s. `iw` is not in the platform baseline, so the
//     rate comes from NetworkManager's own D-Bus property; /proc/net/wireless
//     supplies the level in dBm, which nmcli only exposes as a 0-100 quality.
//
// Commands go through an injectable execFile for the same reason system.js does
// it: the parsing is the part that breaks, and a test has to be able to feed the
// real output back in.
const child = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const UPDATE_DIR = path.join(os.homedir(), ".tvbox", "update");
const FAILED_FILE = path.join(UPDATE_DIR, "failed");

let execFile = child.execFile;

function init(deps) {
  if (deps && deps.execFile) execFile = deps.execFile;
}

// -- pure parsing -----------------------------------------------------------

// /proc/net/wireless carries the signal LEVEL in dBm, which is the number that
// says how far the box is from the AP. The columns are fixed-width and every
// value may carry a trailing '.', e.g. "  wlan0: 0000   55.  -55.  -256".
function parseWirelessLevel(text, iface) {
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*([\w.-]+):\s+\S+\s+([-\d.]+)\s+([-\d.]+)/.exec(line);
    if (!m) continue;
    if (iface && m[1] !== iface) continue;
    const level = Number(String(m[3]).replace(/\.$/, ""));
    const quality = Number(String(m[2]).replace(/\.$/, ""));
    return { levelDbm: isFinite(level) ? level : null, quality: isFinite(quality) ? quality : null };
  }
  return { levelDbm: null, quality: null };
}

// gdbus prints a GVariant, e.g. "(<uint32 390000>,)". NetworkManager reports the
// bitrate in kb/s; Mbit/s is what a person reads.
function parseBitrateKbps(out) {
  const m = /uint32\s+(\d+)/.exec(String(out || ""));
  if (!m) return null;
  const kbps = Number(m[1]);
  return isFinite(kbps) ? kbps : null;
}

// The object path of a device, out of NetworkManager's GetDeviceByIpIface reply.
function parseDevicePath(out) {
  const m = /'(\/org\/freedesktop\/NetworkManager\/Devices\/\d+)'/.exec(String(out || ""));
  return m ? m[1] : null;
}

// nmcli -t -f DEVICE,TYPE,STATE device. The box may have both, and which one
// CARRIES the traffic is the connected one; ethernet wins when both are up
// because that is the route the kernel prefers on these boxes.
function parseDevices(out) {
  const devices = [];
  for (const line of String(out || "").split("\n")) {
    const parts = line.split(":");
    if (parts.length < 3) continue;
    devices.push({ device: parts[0], type: parts[1], state: parts.slice(2).join(":") });
  }
  const connected = (t) => devices.find((d) => d.type === t && /^connected/.test(d.state));
  const eth = connected("ethernet");
  const wifi = connected("wifi");
  return { devices, active: eth || wifi || null, wifiDevice: wifi ? wifi.device : null };
}

// `tvbox-wc --version` prints "tvbox-wc 0.1.6". A box still on the old session
// has no such binary, and an empty answer is the honest one there.
function parseCompositorVersion(out) {
  const m = /(\d+\.\d+\.\d+\S*)/.exec(String(out || ""));
  return m ? m[1] : "";
}

// update/failed is "<prev> <new>": the release that could not boot and the one it
// was rolled back to. Its mtime is when the rollback ran, which is the only record
// of WHEN, so it travels with it.
function parseRollback(text, mtimeMs) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return {
    from: parts[1], // the release that failed to boot
    to: parts[0], // what the box went back to
    at: mtimeMs ? new Date(mtimeMs).toISOString() : null,
  };
}

// -- collection -------------------------------------------------------------

function rollback() {
  try {
    const text = fs.readFileSync(FAILED_FILE, "utf8");
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(FAILED_FILE).mtimeMs;
    } catch (e) {
      mtimeMs = null;
    }
    return parseRollback(text, mtimeMs);
  } catch (e) {
    return null; // no marker = no rollback on record, which is the normal case
  }
}

// A command's stdout, or "" if it could not run at all - a box provisioned before
// the baseline gained a binary must lose that field, not the whole report.
// The guard fires ONCE: execFile may answer synchronously (a fake, or a spawn that
// throws), and without the latch a throw further down the callback chain would be
// caught here and re-enter the flow with an empty answer.
function run(cmd, args, cb) {
  let answered = false;
  const finish = (v) => {
    if (answered) return;
    answered = true;
    cb(v);
  };
  try {
    execFile(cmd, args, { timeout: 8000 }, (e, out) => finish(e ? "" : String(out || "")));
  } catch (e) {
    finish("");
  }
}

// The link: which interface carries traffic, and for wifi how fast it actually
// negotiated. Answers with nulls rather than failing, since a box on ethernet has
// no wifi numbers and that is not an error.
function link(cb) {
  run("nmcli", ["-t", "-f", "DEVICE,TYPE,STATE", "device"], (devOut) => {
    const { active, wifiDevice } = parseDevices(devOut);
    const net = {
      kind: active ? active.type : null,
      device: active ? active.device : null,
      ssid: "",
      signalDbm: null,
      rateMbps: null,
    };
    if (!wifiDevice || (active && active.type !== "wifi")) return cb(net);
    let wireless;
    try {
      wireless = fs.readFileSync("/proc/net/wireless", "utf8");
    } catch (e) {
      wireless = ""; // not a Linux wireless box, or no radio at all
    }
    net.signalDbm = parseWirelessLevel(wireless, wifiDevice).levelDbm;
    run(
      "gdbus",
      [
        "call",
        "--system",
        "--dest",
        "org.freedesktop.NetworkManager",
        "--object-path",
        "/org/freedesktop/NetworkManager",
        "--method",
        "org.freedesktop.NetworkManager.GetDeviceByIpIface",
        wifiDevice,
      ],
      (pathOut) => {
        const objPath = parseDevicePath(pathOut);
        if (!objPath) return cb(net);
        run(
          "gdbus",
          [
            "call",
            "--system",
            "--dest",
            "org.freedesktop.NetworkManager",
            "--object-path",
            objPath,
            "--method",
            "org.freedesktop.DBus.Properties.Get",
            "org.freedesktop.NetworkManager.Device.Wireless",
            "Bitrate",
          ],
          (rateOut) => {
            const kbps = parseBitrateKbps(rateOut);
            net.rateMbps = kbps == null ? null : Math.round(kbps / 100) / 10;
            cb(net);
          },
        );
      },
    );
  });
}

// One box's answer. `system` and `updater` are injected rather than required so
// this module stays loadable (and testable) without the shell's wiring.
function collect(deps, cb) {
  const { system, updater } = deps || {};
  const started = Date.now() - Math.round(os.uptime()) * 1000;
  system.systemInfo((info) => {
    link((net) => {
      run("tvbox-wc", ["--version"], (wcOut) => {
        const upd = updater.status();
        cb({
          at: new Date().toISOString(),
          hostname: info.hostname,
          model: info.model,
          ip: info.ip,
          version: info.version,
          release: upd.release, // null = a dev deploy, not an OTA release
          compositor: parseCompositorVersion(wcOut),
          bootedAt: new Date(started).toISOString(),
          uptimeSec: info.uptimeSec,
          cpuTempC: info.cpuTempC,
          mem: info.mem,
          disk: info.disk,
          net: { ...net, ssid: net.kind === "wifi" ? info.wifi.ssid : "" },
          update: {
            state: upd.state,
            auto: upd.auto,
            available: upd.available,
            latest: upd.latest ? upd.latest.version : null,
            unmet: upd.unmet,
            lastCheckAt: upd.lastCheckAt,
            rollback: rollback(),
            os: upd.os,
          },
        });
      });
    });
  });
}

module.exports = {
  init,
  collect,
  link,
  rollback,
  parseWirelessLevel,
  parseBitrateKbps,
  parseDevicePath,
  parseDevices,
  parseCompositorVersion,
  parseRollback,
};
