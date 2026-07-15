// Push the current now-playing to the shell, which bridges it to MQTT (retained)
// for Home Assistant. The launcher is the single place that knows what's playing
// across apps (Spotify store, Live TV), so it's the source of truth here.
export interface NowPlaying {
  app: string; // spotify | livetv
  state: "playing" | "paused" | "idle";
  title?: string;
  artist?: string;
  image?: string;
}

export function postNowPlaying(np: NowPlaying): void {
  try {
    fetch("/tvbox/api/nowplaying", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(np),
    }).catch(() => {});
  } catch {
    /* no shell (vite dev) */
  }
}
