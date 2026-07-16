// tvbox audio control (PipeWire via WirePlumber's wpctl; no pactl on the box).
// Lists output sinks, reads their volume, and sets a sink's volume. Setting the
// DEFAULT sink is done by audio-default.sh (pw-metadata by node.name, the
// rescan-proof method) - this module only reads + adjusts volume. Callers pass
// the session's Wayland env (main's childEnv).
const { execFile } = require("child_process");

// Parse `wpctl status` for the audio Sinks section -> [{ id, isDefault }].
// Stops at the first "Sources:" so the (empty) video Sinks block is ignored.
function statusSinks(env, cb) {
  execFile("wpctl", ["status"], { env, timeout: 8000 }, (e, out) => {
    if (e) return cb([]);
    let inSinks = false;
    const sinks = [];
    for (const line of (out || "").split("\n")) {
      if (/Sinks:/.test(line)) {
        inSinks = true;
        continue;
      }
      if (inSinks && /Sources:/.test(line)) break;
      if (!inSinks) continue;
      const m = /^[\s│]*(\*)?\s*(\d+)\.\s/.exec(line); // "*" marks the default sink
      if (m) sinks.push({ id: Number(m[2]), isDefault: !!m[1] });
    }
    cb(sinks);
  });
}
function inspectSink(env, id, cb) {
  execFile("wpctl", ["inspect", String(id)], { env, timeout: 8000 }, (e, out) => {
    if (e) return cb(null);
    const name = (/node\.name = "([^"]*)"/.exec(out) || [])[1] || "";
    const desc =
      (/node\.description = "([^"]*)"/.exec(out) || [])[1] ||
      (/device\.description = "([^"]*)"/.exec(out) || [])[1] ||
      name;
    cb({ name, description: desc });
  });
}
function getVolume(env, id, cb) {
  execFile("wpctl", ["get-volume", String(id)], { env, timeout: 8000 }, (e, out) => {
    if (e) return cb({ volume: null, muted: false });
    const v = (/Volume:\s*([\d.]+)/.exec(out) || [])[1];
    cb({ volume: v != null ? Number(v) : null, muted: /MUTED/.test(out || "") });
  });
}

// [{ id, name(node.name), description, isDefault, volume(0..1), muted }]
function listSinks(env, cb) {
  statusSinks(env, (sinks) => {
    if (!sinks.length) return cb([]);
    let pending = sinks.length;
    const out = [];
    sinks.forEach((s) =>
      inspectSink(env, s.id, (info) =>
        getVolume(env, s.id, (vol) => {
          out.push({
            id: s.id,
            name: info ? info.name : "",
            description: info ? info.description : "",
            isDefault: s.isDefault,
            volume: vol.volume,
            muted: vol.muted,
          });
          if (--pending === 0) {
            out.sort((a, b) => a.id - b.id);
            cb(out);
          }
        }),
      ),
    );
  });
}

// Set a sink's volume (0..1). Targeted by id (from the current list); wireplumber
// persists per-device volume, so no config write is needed.
function setVolume(env, id, volume, cb) {
  const n = Number(volume);
  if (!Number.isFinite(n)) return cb(false); // reject a bad value, don't silently mute the sink
  const v = Math.max(0, Math.min(1, n));
  execFile("wpctl", ["set-volume", String(id), v.toFixed(2)], { env, timeout: 8000 }, (e) => cb(!e));
}

module.exports = { listSinks, setVolume };
