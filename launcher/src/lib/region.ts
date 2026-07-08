// Device region control via the shell's localtime/keymap routes. Used by the
// first-boot wizard and the Settings General panel to read the current timezone
// and keyboard layout and change them. Matches the shape of lib/wifi.ts.
export interface RegionInfo {
  timezone: string; // active IANA zone, e.g. "Europe/London"
  timezones: string[]; // ~485 available zones ("Region/City")
  keymap: string; // active console/X keymap code, e.g. "gb"
  keymaps: string[]; // ~99 available layout codes
}

export async function fetchRegion(): Promise<RegionInfo | null> {
  try {
    const res = await fetch("/tvbox/api/system/region", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()) as RegionInfo;
  } catch {
    return null;
  }
}

async function post(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    return !!d.ok;
  } catch {
    return false;
  }
}

// Both return whether the change actually applied. setKeymap can legitimately
// return false on a box whose image predates the polkit grant - callers still
// mark the pick but surface a "applies after the next update" note.
export const setTimezone = (timezone: string): Promise<boolean> => post("/tvbox/api/system/timezone", { timezone });
export const setKeymap = (keymap: string): Promise<boolean> => post("/tvbox/api/system/keymap", { keymap });
