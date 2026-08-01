// What makes this box THIS box, and which of its settings must never be shared
// with another one.
//
// A settings backup is also how a second box gets set up ("copy this box"), and
// that is where identity bites: `mqtt.deviceId` becomes an MQTT TOPIC SEGMENT, so
// two boxes carrying the same one subscribe to each other's commands and
// overwrite each other's now-playing; `spotify.deviceName` is what the phone shows
// in the Connect picker, and two identical entries there are indistinguishable.
// Neither fails loudly - they just make one box act on the other's input.
//
// So identity is DERIVED from the hostname (which the box already asks for, and
// which restore deliberately does not carry) rather than stored by default, and a
// restore that declares itself a clone re-derives every field in IDENTITY_FIELDS.
const fs = require("fs");
const os = require("os");

// The same character class mqtt.js uses for a topic segment, so a derived id and
// the topics built from it always agree.
function safeId(s) {
  return String(s || "tvbox").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hostname() {
  return os.hostname() || "tvbox";
}

// The systemd machine id: stable for the life of an INSTALL, and different on a
// box flashed from the same image. Not a security token (world-readable) - it is
// only ever compared with itself to answer "is this the same install the backup
// came from".
function machineId() {
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (/^[0-9a-f]{32}$/.test(v)) return v;
    } catch (e) {
      /* try the next one */
    }
  }
  return "";
}

// The MQTT device id this box uses when nothing is configured. Derived, not the
// literal "tvbox": that constant is what made every unconfigured box publish to
// one topic tree, which is invisible until there are two of them.
function defaultDeviceId() {
  return safeId(hostname());
}

// The name this box advertises on Spotify Connect when nothing is configured.
// Human-facing, so the hostname goes in as-is.
function defaultSpotifyName() {
  return hostname();
}

// Config fields that identify the box rather than describe its setup. `derive`
// takes a hostname and returns what the field should be on a box with that name;
// `get`/`set` are the accessors into a raw config object.
//
// A field is only re-derived when it still holds the SOURCE box's identity - a
// user who deliberately typed "living-room-tv" on a box called `pi5-b` gets to
// keep it, because that value is a choice and not an inherited collision.
const IDENTITY_FIELDS = [
  {
    path: "mqtt.deviceId",
    derive: (h) => safeId(h),
    get: (c) => (c.mqtt || {}).deviceId || "",
    set: (c, v) => {
      if (c.mqtt) c.mqtt.deviceId = v;
    },
    unset: (c) => {
      if (c.mqtt) delete c.mqtt.deviceId;
    },
    applies: (c) => !!c.mqtt,
  },
  {
    path: "spotify.deviceName",
    derive: (h) => h,
    get: (c) => (c.spotify || {}).deviceName || "",
    set: (c, v) => {
      if (c.spotify) c.spotify.deviceName = v;
    },
    unset: (c) => {
      if (c.spotify) delete c.spotify.deviceName;
    },
    applies: (c) => !!c.spotify,
  },
];

// Re-derive the identity fields of a config that came from ANOTHER box.
// `fromHost` is the hostname the backup was taken on, `toHost` this box's.
// Returns { config, host, changed: [{ path, from, to }] } - the caller logs
// `changed`, because silently renaming someone's Spotify device is worse than
// saying so.
//
// `uniqueSuffix` covers the case that actually breaks: two boxes that have the
// SAME hostname, which is the normal state of a freshly flashed one (both
// `raspberrypi`, neither named yet). Deriving from an identical name would hand
// both the identity we are here to keep apart, so the suffix - the caller passes
// something box-specific, e.g. a slice of the machine id - is appended for the
// derivation only. It is not pretty; it is unique, and the owner can rename the
// box in Settings, which re-derives from a name they chose.
//
// Pure: takes and returns a plain object, so the decision is testable without a
// config file, a broker or a second Raspberry Pi.
function rebrand(config, fromHost, toHost, uniqueSuffix) {
  const cfg = config && typeof config === "object" ? config : {};
  const changed = [];
  let host = toHost || "";
  if (!host || host === fromHost) {
    if (!uniqueSuffix) return { config: cfg, host, changed }; // nothing unique to derive from
    host = (host || "tvbox") + "-" + uniqueSuffix;
  }
  for (const f of IDENTITY_FIELDS) {
    if (!f.applies(cfg)) continue;
    const cur = f.get(cfg);
    // Empty means the source box was running on its derived default, which is
    // inherited just the same - the default IS what it published under.
    if (cur && cur !== f.derive(fromHost)) continue; // a deliberate name, not an inherited one
    const next = f.derive(host);
    if (cur === next && !cur) continue;
    // UNSET rather than write, whenever the target's own live default already is the
    // answer. Writing it would make the field explicit again, and one generation
    // later `cur !== derive(hostname)` would read that inherited value as a name its
    // owner chose - so a clone of the clone would inherit it verbatim and the two
    // boxes would share a topic tree after all. Leaving it unset keeps the
    // derivation live, which is also what setMqtt/setSpotify enforce.
    if (host === toHost) f.unset(cfg);
    else f.set(cfg, next); // the uniqueSuffix path: nothing derives this, so it must be stored
    if (cur === next) continue; // already effectively right; nothing to report
    changed.push({ path: f.path, from: cur || f.derive(fromHost), to: next });
  }
  return { config: cfg, host, changed };
}

module.exports = { safeId, hostname, machineId, defaultDeviceId, defaultSpotifyName, rebrand, IDENTITY_FIELDS };
