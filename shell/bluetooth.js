// tvbox Bluetooth control (BlueZ via bluetoothctl; runs as the session user, no
// sudo - the active local session + netdev grants D-Bus access to org.bluez).
// Covers audio (speakers/headphones) AND input devices (keyboard/mouse/remote):
// pair does agent -> pair -> trust -> connect, which establishes A2DP or HID.
// Callers pass the session env (main's childEnv). MAC addresses are validated by
// the route before reaching here; execFile (no shell) means args are literal.
const { execFile, spawn } = require("child_process");

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
// agent -> pair -> trust -> connect, in ONE persistent bluetoothctl session.
//
// A one-shot `bluetoothctl pair` registers no pairing agent, so when a BLE HID
// device (e.g. the Fire TV remote) asks for authentication BlueZ logs
// "No agent available for request type 2" and pairing dies with
// AuthenticationFailed. The fix is an interactive session that registers a
// NoInputNoOutput ("just works") agent BEFORE pairing, and keeps discovery on
// while pairing so a briefly-advertising remote is reachable. Works for "just
// works" SSP audio/mice/keyboards too; a device demanding a typed passkey is
// still unsupported (noted in the UI). We report ok once the bond completes
// (Paired: yes); the connection then establishes here or on first keypress, and
// the live status poll reflects it. trust so it auto-reconnects on boot.
function pair(env, mac, cb) {
  const p = spawn("bluetoothctl", [], { env });
  let out = "";
  const grab = (d) => (out += d.toString());
  p.stdout.on("data", grab);
  p.stderr.on("data", grab);
  const send = (s) => {
    try {
      p.stdin.write(s + "\n");
    } catch (_e) {
      /* session gone */
    }
  };
  // Bring up the agent + discovery, then pair. Small delays let each command
  // settle (bluetoothctl processes stdin lines as it prints prompts).
  [
    [0, "power on"],
    [300, "agent NoInputNoOutput"],
    [600, "default-agent"],
    [900, "pairable on"],
    [1200, "scan on"],
    [2500, "pair " + mac],
  ].forEach(([t, c]) => setTimeout(() => send(c), t));

  let finished = false;
  let bonded = false;
  const finish = (ok) => {
    if (finished) return;
    finished = true;
    clearInterval(iv);
    clearTimeout(to);
    send("scan off");
    send("quit");
    setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch (_e) {
        /* already gone */
      }
    }, 400);
    cb({ ok, log: out.replace(/\s+/g, " ").trim().slice(-240) });
  };
  const paired = () => /Pairing successful|Paired: yes|AlreadyExists|already exists/i.test(out);
  const iv = setInterval(() => {
    if (!bonded && !paired() && /Failed to pair|org\.bluez\.Error\.Auth/i.test(out)) {
      return finish(false); // hard auth failure and not (yet) bonded
    }
    if (paired() && !bonded) {
      bonded = true; // trust + connect, then report success (bond is the win)
      send("trust " + mac);
      setTimeout(() => send("connect " + mac), 800);
      setTimeout(() => finish(true), 6000);
    }
  }, 500);
  const to = setTimeout(() => finish(paired()), 35000);
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
