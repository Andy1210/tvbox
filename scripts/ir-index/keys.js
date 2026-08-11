// The four buttons a Fire TV remote's blaster can be given, and the one rule about
// button NAMES that both databases have to obey.
//
// It lives in its own module because the two readers kept disagreeing on the same
// spelling: irdb's contains-match bound `SUBWOOFER VOL+` to the volume and `POWERFUL`
// to power, which the Flipper reader already refused, and then `A/V MUTE` the other way
// round. One index cannot hold two answers for one name, so the table is shared rather
// than described twice.
const IR_KEYS = ["VolumeUp", "VolumeDown", "Mute", "Power"];

// Both databases spell a button freely, and both mix conventions - human ("VOLUME +"),
// evdev-style ("KEY_VOLUMEUP"), Flipper's own ("Vol_up"). Collapsing to letters, digits
// and the two signs, with a KEY_ prefix dropped, makes them comparable. `+` and `-`
// survive because they ARE the name on plenty of remotes.
const canon = (s) =>
  String(s || "")
    .toUpperCase()
    .trim()
    .replace(/^KEY[_ ]/, "")
    .replace(/[^A-Z0-9+-]/g, "");

// A name that must never bind to the key it otherwise looks like. `Powerful` is an
// air-conditioner mode, a woofer or centre-channel trim is not the TV's volume, and
// muting the PICTURE is not what someone pressing Mute on a soundbar wants - while
// `AVR MUTE` on a receiver is exactly that, which is why the video one is matched whole
// rather than by its first two letters.
const REJECT = {
  VolumeUp: /WOOFER|BASS|TREBLE|SUB|CENTER|SURROUND|MIC|ZOOM|SPEED/,
  VolumeDown: /WOOFER|BASS|TREBLE|SUB|CENTER|SURROUND|MIC|ZOOM|SPEED/,
  Mute: /MIC|VIDEO|SCREEN|PAUSE|^A-?VMUTE$/,
  Power: /POWERFUL|SUBWOOFER|MIC/,
};

// Whether a canonicalized name is refused for a key.
const rejected = (key, canonName) => !!REJECT[key] && REJECT[key].test(canonName);

module.exports = { IR_KEYS, canon, REJECT, rejected };
