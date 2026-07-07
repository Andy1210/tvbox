// tvbox Bluetooth control (BlueZ via bluetoothctl; runs as the session user, no
// sudo - the active local session + netdev grants D-Bus access to org.bluez).
// Covers audio (speakers/headphones) AND input devices (keyboard/mouse): pair
// does pair -> trust -> connect, which establishes A2DP or HID respectively.
// Callers pass the session env (main's childEnv). MAC addresses are validated by
// the route before reaching here; execFile (no shell) means args are literal.
const { execFile } = require("child_process");

function bt(env, args, timeout, cb) {
  execFile("bluetoothctl", args, { env, timeout: timeout || 15000 }, (_e, out, err) => cb((out || "") + (err || "")));
}
function parseDevices(text) {
  const out = [];
  for (const raw of (text || "").split("\n")) {
    const m = /^Device\s+([0-9A-F:]{17})\s+(.*)$/i.exec(raw.trim());
    if (m) out.push({ mac: m[1].toUpperCase(), name: m[2].trim() });
  }
  return out;
}
function parseMacs(text) {
  const s = new Set();
  for (const raw of (text || "").split("\n")) {
    const m = /^Device\s+([0-9A-F:]{17})/i.exec(raw.trim());
    if (m) s.add(m[1].toUpperCase());
  }
  return s;
}
// BlueZ Icon -> a coarse type the UI maps to an SVG (no per-device guessing there).
function typeFromIcon(icon) {
  if (!icon) return "";
  if (icon.indexOf("audio") === 0) return "audio";
  if (icon === "input-keyboard") return "keyboard";
  if (icon === "input-mouse" || icon === "input-tablet") return "mouse";
  if (icon === "input-gaming") return "gamepad";
  if (icon === "phone") return "phone";
  if (icon === "computer") return "computer";
  return "";
}

function status(env, cb) {
  bt(env, ["show"], 8000, (out) =>
    cb({ powered: /Powered:\s*yes/i.test(out), discovering: /Discovering:\s*yes/i.test(out) }),
  );
}
function info(env, mac, cb) {
  bt(env, ["info", mac], 5000, (out) => {
    if (/not available/i.test(out)) return cb(null); // out of range / cache gone
    cb({
      name: (/Name:\s*(.*)/.exec(out) || [])[1] || "",
      type: typeFromIcon(((/Icon:\s*(.*)/.exec(out) || [])[1] || "").trim()),
      paired: /Paired:\s*yes/i.test(out),
      connected: /Connected:\s*yes/i.test(out),
    });
  });
}
// [{ mac, name, type, paired, connected }] - paired/connected from the reliable
// `devices <filter>` sets (correct even when a device is out of range), type/name
// enriched from `info` best-effort.
function list(env, cb) {
  bt(env, ["devices"], 8000, (allTxt) => {
    bt(env, ["devices", "Paired"], 8000, (pairedTxt) => {
      bt(env, ["devices", "Connected"], 8000, (connTxt) => {
        const all = parseDevices(allTxt);
        const paired = parseMacs(pairedTxt);
        const connected = parseMacs(connTxt);
        if (!all.length) return cb([]);
        let pending = all.length;
        const result = [];
        all.forEach((d) =>
          info(env, d.mac, (i) => {
            result.push({
              mac: d.mac,
              name: (i && i.name) || d.name || d.mac,
              type: (i && i.type) || "",
              paired: paired.has(d.mac) || !!(i && i.paired),
              connected: connected.has(d.mac) || !!(i && i.connected),
            });
            if (--pending === 0) {
              result.sort(
                (a, b) =>
                  (b.connected ? 1 : 0) - (a.connected ? 1 : 0) ||
                  (b.paired ? 1 : 0) - (a.paired ? 1 : 0) ||
                  a.name.localeCompare(b.name),
              );
              cb(result);
            }
          }),
        );
      });
    });
  });
}
// Timed discovery (blocks ~seconds), then returns the refreshed device list.
function scan(env, seconds, cb) {
  const s = Math.max(2, Math.min(30, Number(seconds) || 8));
  bt(env, ["--timeout", String(s), "scan", "on"], s * 1000 + 6000, () => list(env, cb));
}
// pair -> trust -> connect. Works for "just works" SSP devices (most speakers,
// headphones, mice, many keyboards); a device that demands a typed passkey needs
// manual bluetoothctl (noted in the UI). trust so it auto-reconnects on boot.
function pair(env, mac, cb) {
  bt(env, ["pair", mac], 35000, (o1) => {
    bt(env, ["trust", mac], 8000, () => {
      bt(env, ["connect", mac], 25000, (o3) => {
        const ok = /Pairing successful|already|AlreadyExists|Connection successful|Connected: yes/i.test(o1 + o3);
        cb({ ok, log: (o1 + o3).replace(/\s+/g, " ").trim().slice(-200) });
      });
    });
  });
}
function connect(env, mac, cb) {
  bt(env, ["connect", mac], 25000, (o) => cb({ ok: /Connection successful|already connected/i.test(o) }));
}
function disconnect(env, mac, cb) {
  bt(env, ["disconnect", mac], 12000, (o) => cb({ ok: !/Failed/i.test(o) }));
}
function remove(env, mac, cb) {
  bt(env, ["remove", mac], 12000, (o) => cb({ ok: !/Failed to remove/i.test(o) }));
}

module.exports = { status, list, scan, pair, connect, disconnect, remove };
