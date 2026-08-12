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
// through systemd, which polkit allows for those four units (provision.sh). The
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
 * script means re-enabling never deletes that note. Not section-aware: an overlay
 * inside a `[pi4]` block reads as in force here, which is one wrong answer on a
 * file nothing but the root helper writes, and one toggle corrects it.
 */
function overlayPresent(text, name) {
  const re = new RegExp(`^\\s*dtoverlay=disable-${name}(?:[\\s,]|$)`, "m");
  return re.test(String(text || ""));
}

/** What the boot config says about both radios, plus whether we could read it.
 *
 * Async because this reads the FAT boot partition from the Electron main process:
 * a card that stalls would otherwise block the whole UI, and both settings pages
 * ask on mount. `cb(state)` - it never errors.
 */
function readState(cb, deps) {
  const read = (deps && deps.readFile) || ((p, enc, done) => fs.readFile(p, enc, done));
  read(CONFIG, "utf8", (err, text) => {
    // A box whose boot partition is not mounted (or a dev box that has no such
    // file) gets "unknown" rather than a wrong answer: the UI then offers
    // nothing, which is better than offering a switch that cannot work.
    if (err) return cb({ readable: false, wifi: null, bt: null });
    cb({
      readable: true,
      wifi: overlayPresent(text, "wifi") ? "off" : "on",
      bt: overlayPresent(text, "bt") ? "off" : "on",
    });
  });
}

/** Whether the root helper is installed at all.
 *
 * It arrives with provision.sh, and **OTA can never deliver it** (root files are
 * provision's, by design), so a box updated only over the air has the UI and not
 * the unit. Saying so is the whole point of this check - the alternative is a
 * switch that fails with nothing to explain it. A stat of a local path, so it
 * stays synchronous.
 */
function helperInstalled(deps) {
  const exists = (deps && deps.exists) || ((p) => fs.existsSync(p));
  return exists("/usr/local/sbin/tvbox-radio");
}

/** Whether this change would leave the box with no way in at all.
 *
 * Nothing is REFUSED for a radio on its own: an owner may want one off, and
 * Settings is on the TV, so a single change is undone from the same couch. The
 * compound is different. With both radios off and no cable there is no network, no
 * BT remote and no phone - only HDMI-CEC, which this repo documents as TV-specific
 * and kernel-fragile - and the setting survives a reboot, so the box may have no
 * way back that does not involve a card reader. That state is reachable on
 * purpose (it is what a box with two USB dongles wants), so what it costs is a
 * confirmation rather than a refusal.
 */
function wouldStrand({ state, radio, on, ethernet }) {
  if (on) return false;
  if (ethernet && ethernet.connected) return false;
  const other = radio === "wifi" ? "bt" : "wifi";
  return (state && state[other]) === "off";
}

/** Ask systemd to apply one change. `cb(err|null)`. */
function apply({ radio, on }, cb, deps) {
  const run = (deps && deps.run) || execFile;
  // A real boolean, like the route's own check: `on: "false"` is truthy, and
  // reading it as "turn it ON" would silently do the opposite of what was asked.
  if (typeof on !== "boolean") return cb(new Error("`on` must be a boolean"));
  const action = `${radio}-${on ? "on" : "off"}`;
  if (!ACTIONS.has(action)) return cb(new Error(`unknown action: ${action}`));
  // `--no-ask-password` for the reason the power menu learned the hard way: this
  // call has a polkit grant, but a box provisioned before that grant existed does
  // not have it - and without the flag systemctl answers "interactive
  // authentication required" by spawning pkttyagent, which reads a terminal, takes
  // SIGTTIN, and stops the whole process group including the shell's respawn loop.
  // A missing grant has to fail, not freeze the box.
  run("systemctl", ["--no-ask-password", "start", UNIT(action)], { timeout: 20000 }, (err, _out, errOut) => {
    if (!err) return cb(null);
    // systemd's own message is the useful one here: a missing polkit rule and a
    // missing unit fail differently, and the box user cannot read the journal.
    const detail = String(errOut || err.message || "")
      .trim()
      .split("\n")[0];
    cb(new Error(detail || "systemctl failed"));
  });
}

module.exports = {
  readState,
  helperInstalled,
  wouldStrand,
  apply,
  CONFIG,
  _test: { overlayPresent, ACTIONS },
};
