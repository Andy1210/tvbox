// Launcher-side view of the shell's display control. Resolution is AUTOMATIC (the
// UI runs at the panel's own resolution capped to 1080p, video claims a mode that
// suits it), so there is nothing to pick here - only a status read and a
// "re-detect" that re-asserts the UI mode. Absent during `vite dev`.
export interface DisplayModeInfo {
  width: number;
  height: number;
  refresh: number; // exact Hz (23.976, not a rounded 24)
}
export interface DisplayStatus {
  output: string;
  current: DisplayModeInfo | null; // what the output is at right now
  ui: DisplayModeInfo | null; // what the UI should sit at
  desired: DisplayModeInfo | null; // the UI mode, or a live video claim's mode
  claimedBy: string | null; // who holds a video claim ("shell:mpv", "app:<id>")
}

// null = not readable (offline, or the shell answered non-2xx - an error body must
// not be cast to a status). The Resolution row shows "-" then; pressing OK on it
// re-detects AND re-reads, so there is always a way forward without a keyboard.
export async function fetchDisplayStatus(): Promise<DisplayStatus | null> {
  try {
    const r = await fetch("/tvbox/api/display/status", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as DisplayStatus;
  } catch {
    return null;
  }
}

export async function refreshDisplayMode(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/tvbox/api/display/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}
