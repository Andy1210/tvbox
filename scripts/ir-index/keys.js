// The buttons the index carries, and the one rule about button NAMES that both databases
// have to obey.
//
// It lives in its own module because the two readers kept disagreeing on the same
// spelling: irdb's contains-match bound `SUBWOOFER VOL+` to the volume and `POWERFUL`
// to power, which the Flipper reader already refused, and then `A/V MUTE` the other way
// round. One index cannot hold two answers for one name, so the table is shared rather
// than described twice.

// The four that decide a device's IDENTITY. group.js hashes exactly these into the
// device id a saved plan is matched against, and a codeset carrying none of them is
// dropped - so this list must not grow: a fifth member would change every published id
// and orphan every plan already saved on a box.
const IR_KEYS = ["VolumeUp", "VolumeDown", "Mute", "Power"];

// Buttons carried as EXTRA data on a device row, outside the identity signature. What
// they are for is a BLAST: an InstantFire action needs no scan id, so a code can be sent
// without being bound to a physical key - which is the only way to reach a button the
// remote does not have. A TV's input is the case that matters, because a source device
// cannot select a foreign input over CEC at all.
const IR_EXTRA_KEYS = ["HDMI1", "HDMI2", "HDMI3", "HDMI4", "Input"];

// Every key a reader may bind. The order is the order the Flipper reader tries them in,
// so the discrete inputs come before the cycling one.
const ALL_IR_KEYS = [...IR_KEYS, ...IR_EXTRA_KEYS];

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
  // A name that picks ONE source must never bind the cycling Input key. Aiming at HDMI 2
  // is the whole reason these keys are carried, and a toggle cannot be aimed - so a row
  // that would answer "which input?" with "the next one" is refused rather than stored.
  // MUTE is here because irdb matches a synonym by CONTAINS, and `A/V MUTE` canonicalizes
  // to a string ending in the AV an input list starts with.
  Input: /HDMI|COMPONENT|COMPOSITE|SCART|VGA|USB|ANTENNA|CABLE|SATELLITE|MUTE/,
};

// Whether a canonicalized name is refused for a key.
const rejected = (key, canonName) => !!REJECT[key] && REJECT[key].test(canonName);

module.exports = { IR_KEYS, IR_EXTRA_KEYS, ALL_IR_KEYS, canon, REJECT, rejected };
