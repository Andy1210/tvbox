// Launcher-side access to the shell's audio control (WirePlumber/wpctl). Lists
// output sinks, picks the default (a manual override of the HDMI auto-detect),
// and sets the default sink's volume. Absent during `vite dev`.
export interface AudioSink {
  id: number;
  name: string; // node.name - the stable id we persist as the override
  description: string;
  isDefault: boolean;
  volume: number | null; // 0..1
  muted: boolean;
}
export interface AudioState {
  sinks: AudioSink[];
  override: string | null; // node.name of the manual override, or null = auto
}

export async function fetchSinks(): Promise<AudioState | null> {
  try {
    const r = await fetch("/tvbox/api/audio/sinks", { cache: "no-store" });
    return (await r.json()) as AudioState;
  } catch {
    return null;
  }
}

// sink = "" clears the override (back to HDMI auto-detect).
export async function setDefaultSink(sink: string): Promise<{ ok: boolean }> {
  try {
    const r = await fetch("/tvbox/api/audio/default", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sink }),
    });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

export async function setSinkVolume(id: number, volume: number): Promise<{ ok: boolean }> {
  try {
    const r = await fetch("/tvbox/api/audio/volume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, volume }),
    });
    return await r.json();
  } catch {
    return { ok: false };
  }
}
