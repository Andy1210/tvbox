// Device info + identity, served by the shell. GET /tvbox/api/system/info feeds
// the HOME → Settings → Diagnostics section; setHostname renames the box. Absent
// during `vite dev`.
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

// Rename the box (hostnamectl, via the hostname1 polkit grant). Returns whether
// it actually applied - false on a box whose image predates the grant, so the
// caller keeps the entered name on screen with a "applies after the next update"
// note (same pattern as the timezone/keyboard controls).
export async function setHostname(hostname: string): Promise<boolean> {
  try {
    const res = await fetch("/tvbox/api/system/hostname", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname }),
    });
    const d = await res.json();
    return !!d.ok;
  } catch {
    return false;
  }
}
