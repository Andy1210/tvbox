// Bridge to the Electron shell (injected by shell/preload.js as window.tvbox).
// During `vite dev` it's absent, so every call is guarded.
export interface PlayerEvent {
  type: "playing" | "buffering" | "finished" | "error" | "position" | "duration";
  on?: boolean;
  ms?: number;
  /** Why playback ended, when it did not simply run out: "tv-standby", "stopped".
   * An app that auto-advances on `finished` should not do so when this is set. */
  reason?: string;
}

export interface TvNotification {
  kind?: string; // shell-originated structured notes the launcher localizes (e.g. "lowBattery")
  cause?: string; // which failure, for the kinds that have more than one (irFailed)
  name?: string; // lowBattery: device name
  battery?: number; // lowBattery: %
  title?: string;
  message?: string;
  image?: string; // e.g. a doorbell camera snapshot URL
  duration?: number; // ms before auto-dismiss (0 = sticky)
  raise?: boolean; // bring the launcher window forward (over a remote app)
}

// Launcher navigation pushed by the shell while the launcher is up (a remapped
// Settings button on a remote, /tvbox/api/nav). Out of an app the shell reloads
// the launcher with the #settings hash instead (App.tsx handles both).
// "typing" is not a view: it opens the typing screen over whatever is on screen
// (the shell pushes it when a text field takes focus in an app), and the shell
// pushes "home" when that session ends. "mirroring" works the same way and for
// the same reason - the shell knows whether frames are still arriving from a
// phone, and the screen must follow that rather than guess.
// "ambient" is an app on screen asking for the screensaver over itself: the
// launcher's window is hidden while an app is in front, so its idle timer never
// runs there and an app with nothing to show (Spotify with no music) would hold
// a static screen all night. The shell has already brought this window forward
// by the time it arrives, and remembers which app to go back to.
export interface TvNav {
  dest: "home" | "settings" | "typing" | "mirroring" | "ambient";
}

export interface TvboxBridge {
  launch(appId: string): void;
  home(): void;
  // built-in apps with the "player" capability (e.g. Live TV) drive mpv:
  play?(url: string): void;
  stop?(): void;
  // Live TV: shrink current channel to a PiP at `rect` (device px) / restore fullscreen
  pip?(on: boolean, rect?: { x: number; y: number; w: number; h: number }): void;
  onPlayer?(cb: (ev: PlayerEvent) => void): () => void;
  // on-screen notifications pushed from the shell (MQTT)
  onNotify?(cb: (n: TvNotification) => void): () => void;
  // media commands forwarded from the shell (MQTT tv_control) for the active app
  onCommand?(cb: (cmd: { action: string; app?: string }) => void): () => void;
  onWidgets?(cb: (widgets: { id: string; title: string; subtitle: string }[]) => void): () => void;
  /** The set of running apps changed - refetch. The box can start one itself. */
  onAppsChanged?(cb: () => void): () => void;
  onNav?(cb: (n: TvNav) => void): () => void;
  // The screensaver an app asked for: done() tells the shell a key was pressed on
  // it, which sends the screen back to that app. request() is the app's half and
  // is never called from here.
  ambient?: { request(): void; done(): void };
}

declare global {
  interface Window {
    tvbox?: TvboxBridge;
  }
}

export function hasShell(): boolean {
  return typeof window !== "undefined" && !!window.tvbox;
}

export function launchApp(appId: string): boolean {
  if (window.tvbox?.launch) {
    window.tvbox.launch(appId);
    return true;
  }
  console.warn("[launcher] no shell bridge; would launch:", appId);
  return false;
}
