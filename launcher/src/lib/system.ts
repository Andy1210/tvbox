// Read-only device diagnostics, served by the shell (GET /tvbox/api/system/info).
// Used by the HOME → Settings → Diagnostics section. Absent during `vite dev`.
export interface SystemInfo {
  version: string;
  hostname: string;
  model: string;
  ip: string;
  uptimeSec: number;
  cpuTempC: number | null;
  mem: { totalKb: number | null; availableKb: number | null };
  wifi: { ssid: string; signal: number | null };
}

export async function fetchSystemInfo(): Promise<SystemInfo | null> {
  try {
    const res = await fetch("/tvbox/api/system/info", { cache: "no-store" });
    return (await res.json()) as SystemInfo;
  } catch {
    return null;
  }
}
