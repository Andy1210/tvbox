// The box as ONE media player.
//
// Three things know part of what is playing and none of them knows the rest:
// mpv, which the shell owns (position, duration, paused - but not what the file
// is called, because the app resolved that), the launcher's now-playing report
// from the foreground app (Spotify's title/artist/artwork, Live TV's channel -
// the shell cannot see inside an app's renderer), and the audio sink (volume,
// mute). Home Assistant wants one entity, so this composes them into one payload.
//
// Pure on purpose: it takes a snapshot and returns the payload, with no I/O and no
// timers, so the merge rules - which source wins for which field, and when a
// change is worth publishing - are unit-testable.

// Position moves every second while something plays. Publishing that every second
// is pointless traffic on a retained topic, so a position-only change has to clear
// this to count; everything else publishes immediately.
const POSITION_EPS_S = 5;

// Merge order per field is the one that OWNS it: the player for the clock, the app
// for the metadata, the sink for the volume. An app may override position/duration
// when it plays its own audio (librespot has no mpv to observe).
function compose(input) {
  const i = input || {};
  const np = i.nowPlaying && typeof i.nowPlaying === "object" ? i.nowPlaying : null;
  const mpv = i.mpv && typeof i.mpv === "object" ? i.mpv : null;
  const playing = mpv && mpv.active;
  const state = playing
    ? mpv.paused
      ? "paused"
      : "playing"
    : np && (np.state === "playing" || np.state === "paused")
      ? np.state
      : "idle";
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  return {
    state,
    title: str(np && np.title),
    artist: str(np && np.artist),
    album: str(np && np.album),
    image: str(np && np.image),
    // Which app the media belongs to, and which app is on screen. They differ:
    // Live TV can keep playing behind a hidden window while HOME is in front.
    app: str(np && np.app),
    source: str(i.currentApp),
    sourceList: Array.isArray(i.sources) ? i.sources : [],
    position: playing ? num(mpv.position) : num(np && np.position),
    duration: playing ? num(mpv.duration) : num(np && np.duration),
    // Absolute seeking only means anything while WE hold the clock; an app that
    // reports its own position has no mpv to seek.
    seekable: !!(playing && num(mpv.duration)),
    volume: typeof i.volume === "number" && i.volume >= 0 ? Math.round(i.volume * 100) / 100 : null,
    muted: !!i.muted,
  };
}

function str(v) {
  return typeof v === "string" && v ? v.slice(0, 300) : null;
}

// Is `next` worth putting on the wire? Everything except the clock publishes on
// any change; the clock has to move POSITION_EPS_S to count.
function worthPublishing(prev, next) {
  if (!prev) return true;
  for (const k of Object.keys(next)) {
    if (k === "position") continue;
    if (k === "sourceList") {
      if (JSON.stringify(prev[k] || []) !== JSON.stringify(next[k] || [])) return true;
      continue;
    }
    if (prev[k] !== next[k]) return true;
  }
  const a = prev.position;
  const b = next.position;
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) >= POSITION_EPS_S;
}

module.exports = { compose, worthPublishing, POSITION_EPS_S };
