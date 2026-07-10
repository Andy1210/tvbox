// Bridge to the Electron shell (injected by shell/preload.js as window.tvbox).
// During `vite dev` it's absent, so every call is guarded.
export interface PlayerEvent {
  type: "playing" | "buffering" | "finished" | "error" | "position" | "duration";
  on?: boolean;
  ms?: number;
}

export interface TvNotification {
  kind?: string; // shell-originated structured notes the launcher localizes (e.g. "lowBattery")
  name?: string; // lowBattery: device name
  battery?: number; // lowBattery: %
  title?: string;
  message?: string;
  image?: string; // e.g. a doorbell camera snapshot URL
  duration?: number; // ms before auto-dismiss (0 = sticky)
  raise?: boolean; // bring the launcher window forward (over a remote app)
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
