// Pure translation between what an APP knows about a stream and what mpv wants.
// Kept out of main.js so it can be tested without an Electron process, and so
// there is exactly one place that decides what a renderer is allowed to change
// about playback.
//
// Track terms: an app speaks 0-based ORDINALS within a track type ("the second
// audio stream"), because that is what a media server hands it; mpv's aid/sid
// are the same ordinals 1-based, in track-list order. `sub: -1` means "no
// subtitles", which is NOT the same as saying nothing - left alone, mpv enables
// whichever subtitle track carries the container's default flag.

// The mpv properties an app may set, each with a validator returning the value
// to send or null to refuse. An allowlist and not a passthrough: mpv's property
// space reaches its configuration and the filesystem, and none of that belongs
// to a renderer. Units are mpv's own (seconds, not milliseconds) - a client that
// speaks something else converts in its own bridge.
const num = (lo, hi) => (v) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const color = (v) => (typeof v === "string" && /^#[0-9a-fA-F]{6,8}$/.test(v) ? v : null);
const PLAYER_PROPS = {
  "sub-delay": num(-120, 120),
  "audio-delay": num(-120, 120),
  speed: num(0.25, 4),
  volume: num(0, 100),
  "sub-scale": num(0.1, 10),
  "sub-pos": num(0, 150),
  "sub-visibility": (v) => (typeof v === "boolean" ? v : null),
  "sub-color": color,
  "sub-border-color": color,
};

// { name, value } -> the value to hand mpv, or null if the property isn't on the
// list or the value is out of range. Callers must treat null as "refuse", never
// as "send nothing and report success".
function propValue(name, value) {
  const check = Object.prototype.hasOwnProperty.call(PLAYER_PROPS, name) ? PLAYER_PROPS[name] : null;
  return check ? check(value) : null;
}

const ordinal = (v) => (Number.isInteger(v) && v >= 0 && v < 100 ? v + 1 : null);

// Selection as mpv command-line arguments, for a file that is about to start.
// Anything unparseable is dropped rather than guessed: mpv's own default beats a
// wrong track.
function streamArgs(sel) {
  const out = [];
  if (!sel || typeof sel !== "object") return out;
  const a = ordinal(sel.audio);
  if (a) out.push("--aid=" + a);
  if (subFileOf(sel)) out.push("--sub-file=" + sel.subFile);
  else if (sel.sub === -1 || sel.sub === false) out.push("--sid=no");
  else {
    const s = ordinal(sel.sub);
    if (s) out.push("--sid=" + s);
  }
  return out;
}

// Selection as mpv IPC commands, for a file already playing. A sidecar is added
// and selected by name because mpv appends it to the end of the subtitle list,
// so its ordinal isn't knowable in advance.
function streamCommands(sel) {
  const out = [];
  if (!sel || typeof sel !== "object") return out;
  if (subFileOf(sel)) return [["sub-add", sel.subFile, "select"]];
  for (const [key, prop] of [
    ["audio", "aid"],
    ["sub", "sid"],
  ]) {
    const v = sel[key];
    if (v === undefined || v === null) continue;
    if (v === -1 || v === false) out.push(["set_property", prop, "no"]);
    else {
      const n = ordinal(v);
      if (n) out.push(["set_property", prop, n]);
    }
  }
  return out;
}

// A sidecar subtitle URL, or null. http(s) only: the value reaches mpv's argv,
// where a local path would let an app open a file off the box.
function subFileOf(sel) {
  const u = sel && sel.subFile;
  return typeof u === "string" && /^https?:\/\/[^\s]+$/.test(u) ? u : null;
}

module.exports = { streamArgs, streamCommands, propValue, subFileOf, PLAYER_PROPS };
