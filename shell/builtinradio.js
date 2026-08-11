// The Pi's OWN wifi and Bluetooth, as a permanent setting rather than a switch.
//
// `nmcli radio wifi off` (wifiradio.js) lasts until the next boot and only parks
// the wifi; this turns a radio off in `/boot/firmware/config.txt`, which is what
// actually hands the antenna over. Two reasons a box wants that:
//
//   • A USB dongle has its own antenna, outside the case. On the combo chip wifi
//     and Bluetooth share ONE antenna and one supply rail, so the built-in radio
//     has to get out of the way to make that worth anything. Measured on a box in
//     a sealed aluminium case: with a BT remote connected, 2.4 GHz wifi fell from
//     ~4.7 Mbit/s to under 0.7, and the reported RSSI dropped 5 dB with it.
//   • Some owners simply want a radio off. A box on a cable needs no wifi, and a
//     box driven by CEC needs no Bluetooth.
//
// Root belongs to the unit, not to us: the shell starts `tvbox-radio@<action>`
// through systemd, which polkit allows for that one unit (provision.sh). The
// shell never runs sudo - hard rule 1 - and the action is one of four words, so
// nothing the caller says reaches a path or a shell.
const { execFile } = require("child_process");
const fs = require("fs");

const CONFIG = "/boot/firmware/config.txt";
const UNIT = (action) => `tvbox-radio@${action}.service`;

// The four the root script accepts. Anything else is a bug on this side, and the
// script rejects it anyway.
const ACTIONS = new Set(["bt-off", "bt-on", "wifi-off", "wifi-on"]);

/** Whether `dtoverlay=disable-<name>` is in force in this config text.
 *
 * A commented line is a note, not a setting - a box whose owner left
 * `#dtoverlay=disable-bt` behind reads as enabled, and the same rule in the root
 * script means re-enabling never deletes that note.
 */
function overlayPresent(text, name) {
  const re = new RegExp(`^\\s*dtoverlay=disable-${name}(?:[\\s,]|$)`, "m");
  return re.test(String(text || ""));
}

/** What the boot config says about both radios, plus whether we could read it. */
function readState(deps) {
  const read = (deps && deps.readFile) || ((p) => fs.readFileSync(p, "utf8"));
  let text;
  try {
    text = read(CONFIG);
  } catch (e) {
    // A box whose boot partition is not mounted (or a dev box that has no such
    // file) gets "unknown" rather than a wrong answer: the UI then offers
    // nothing, which is better than offering a switch that cannot work.
    return { readable: false, wifi: null, bt: null };
  }
  return {
    readable: true,
    wifi: overlayPresent(text, "wifi") ? "off" : "on",
    bt: overlayPresent(text, "bt") ? "off" : "on",
  };
}

/** Whether the root helper is installed at all.
 *
 * It arrives with provision.sh, and **OTA can never deliver it** (root files are
 * provision's, by design), so a box updated only over the air has the UI and not
 * the unit. Saying so is the whole point of this check - the alternative is a
 * switch that fails with nothing to explain it.
 */
function helperInstalled(deps) {
  const exists = (deps && deps.exists) || ((p) => fs.existsSync(p));
  return exists("/usr/local/sbin/tvbox-radio");
}

/** What the owner should be told before turning a radio off, or null.
 *
 * Nothing is REFUSED here, deliberately. The runtime switch in wifiradio.js has
 * an ethernet rule because it can strand a box that nobody is standing in front
 * of; this setting lives in Settings ON THE TV, reachable with the remote and no
 * network at all, so every one of these is recoverable from the couch. What the
 * owner is owed is the consequence, in advance - which is the UI's job, and this
 * is what it asks about.
 */
function warningFor({ radio, on, ethernet }) {
  if (on) return null;
  if (radio === "wifi" && !(ethernet && ethernet.connected)) return "goes-offline";
  if (radio === "bt") return "loses-bluetooth";
  return null;
}

/** Ask systemd to apply one change. `cb(err|null)`. */
function apply({ radio, on }, cb, deps) {
  const run = (deps && deps.run) || execFile;
  const action = `${radio}-${on ? "on" : "off"}`;
  if (!ACTIONS.has(action)) return cb(new Error(`unknown action: ${action}`));
  run("systemctl", ["start", UNIT(action)], { timeout: 20000 }, (err, _out, errOut) => {
    if (!err) return cb(null);
    // systemd's own message is the useful one here: a missing polkit rule and a
    // missing unit fail differently, and the box user cannot read the journal.
    const detail = String(errOut || err.message || "")
      .trim()
      .split("\n")[0];
    cb(new Error(detail || "systemctl failed"));
  });
}

module.exports = { readState, helperInstalled, warningFor, apply, CONFIG, _test: { overlayPresent, ACTIONS } };
