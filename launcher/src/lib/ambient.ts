// Launcher-side ambient/screensaver data (shell-served). Weather is open-meteo
// via the shell; photos are local files under ~/.tvbox/ambient/.
export interface Weather {
  city?: string;
  tempC?: number;
  code?: number;
}

export async function fetchWeather(): Promise<Weather | null> {
  try {
    const r = await fetch("/tvbox/api/ambient/weather", { cache: "no-store" });
    const j = (await r.json()) as Weather;
    return j && j.tempC != null ? j : null;
  } catch {
    return null;
  }
}
export async function fetchPhotos(): Promise<string[]> {
  try {
    const r = await fetch("/tvbox/api/ambient/photos", { cache: "no-store" });
    return ((await r.json()).photos as string[]) || [];
  } catch {
    return [];
  }
}
export function photoUrl(name: string): string {
  return "/tvbox/api/ambient/photo?name=" + encodeURIComponent(name);
}
export async function clearPhotos(): Promise<number> {
  try {
    return (await (await fetch("/tvbox/api/ambient/photos/clear", { method: "POST" })).json()).removed || 0;
  } catch {
    return 0;
  }
}
export async function deletePhoto(name: string): Promise<boolean> {
  try {
    return (
      await (
        await fetch("/tvbox/api/ambient/photos/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        })
      ).json()
    ).ok;
  } catch {
    return false;
  }
}

// WMO weather code -> a coarse group the ambient screen maps to text + an SVG.
export function weatherGroup(code: number | undefined): "clear" | "cloudy" | "fog" | "rain" | "snow" | "storm" {
  if (code == null) return "cloudy";
  if (code === 0) return "clear";
  if (code <= 3) return "cloudy";
  if (code <= 48) return "fog";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 85 && code <= 86) return "snow";
  if (code >= 95) return "storm";
  return "rain"; // drizzle / rain / rain showers
}
