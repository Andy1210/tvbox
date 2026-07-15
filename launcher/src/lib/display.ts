// Launcher-side access to the shell's display control (wlr-randr). Lists the
// connected output's modes, switches resolution/refresh, and toggles the
// "match content framerate" mpv option. Absent during `vite dev`.
export interface DisplayMode {
  key: string; // "WxH@N" (N = whole Hz) - the id we send back to apply
  width: number;
  height: number;
  refresh: number;
  current: boolean;
  preferred: boolean;
}
export interface DisplayInfo {
  output: string;
  modes: DisplayMode[];
  saved: string | null;
  matchFramerate: boolean;
}

export async function fetchDisplayModes(): Promise<DisplayInfo | null> {
  try {
    const r = await fetch("/tvbox/api/display/modes", { cache: "no-store" });
    return (await r.json()) as DisplayInfo;
  } catch {
    return null;
  }
}

export async function applyDisplayMode(mode: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/tvbox/api/display/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function setMatchFramerate(on: boolean): Promise<void> {
  try {
    await fetch("/tvbox/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display: { matchFramerate: on } }),
    });
  } catch {
    /* best effort */
  }
}
