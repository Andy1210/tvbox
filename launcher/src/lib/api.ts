import type { AppManifest } from "./types";

// The shell publishes installed app manifests here. During `vite dev` (no
// shell) the fetch fails and we fall back to a static list so the UI still
// renders - the real list always comes from the shell in production.
const FALLBACK_APPS: AppManifest[] = [
  {
    id: "plex",
    name: "Plex",
    tagline: { hu: "Filmek és sorozatok", en: "Movies & TV shows" },
    type: "webclient",
    status: "ready",
    accent: "#e5a00d",
    icon: "<svg viewBox='0 0 24 24' fill='#e5a00d'><path d='M5 2h7l7 10-7 10H5l7-10z'/></svg>",
  },
  {
    id: "livetv",
    name: { hu: "Élő TV", en: "Live TV" },
    tagline: { hu: "IPTV csatornák", en: "IPTV channels" },
    type: "webclient",
    status: "ready",
    accent: "#39c0d6",
    icon: "<svg viewBox='0 0 24 24' fill='none' stroke='#39c0d6' stroke-width='2'><rect x='2.5' y='5' width='19' height='13' rx='2'/><path d='M8 21h8M9 5l3-2 3 2' stroke-linecap='round'/></svg>",
  },
  {
    id: "youtube",
    name: "YouTube",
    tagline: { hu: "Videók", en: "Videos" },
    type: "webclient",
    status: "ready",
    accent: "#ff0033",
    icon: "<svg viewBox='0 0 24 24'><rect x='2' y='5' width='20' height='14' rx='4' fill='#ff0033'/><path d='M10 9l5 3-5 3z' fill='#fff'/></svg>",
  },
  {
    id: "spotify",
    name: "Spotify",
    tagline: { hu: "Zene", en: "Music" },
    type: "webclient",
    status: "ready",
    accent: "#1DB954",
    icon: "<svg viewBox='0 0 24 24' fill='#1DB954'><circle cx='12' cy='12' r='10'/><path d='M7 10c3-1 7-.6 9.5 1M7.5 13c2.5-.7 5.5-.4 7.5 1M8 15.6c2-.5 4-.3 5.5.7' stroke='#0a160f' stroke-width='1.3' fill='none' stroke-linecap='round'/></svg>",
  },
];

export async function fetchApps(): Promise<AppManifest[]> {
  try {
    const res = await fetch("/tvbox/api/apps", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = (await res.json()) as AppManifest[];
    // An EMPTY array is the correct answer on a fresh box (Kodi model: nothing
    // installed → empty HOME + "Get more apps"). Only a real fetch FAILURE
    // (shell unreachable, e.g. `vite dev`) falls back to the static demo list -
    // treating "empty" as failure wrongly seeded 4 phantom apps on a fresh box.
    if (Array.isArray(data)) return data;
    throw new Error("bad app list");
  } catch (e) {
    console.warn("[launcher] /tvbox/api/apps unavailable, using fallback:", e);
    return FALLBACK_APPS;
  }
}

// ---- app store (Settings → Store): a git-hosted registry of vetted,
// manifest-only apps. Install = the shell writes the manifest to
// ~/.tvbox/apps/<id>.json; the HOME tile appears live. ----
export interface StoreEntry {
  id: string;
  name: import("./types").LocaleString;
  tagline?: import("./types").LocaleString;
  icon: string;
  accent?: string;
  installed: boolean;
  builtin: boolean; // ships with the box - shown as already present
  version: string; // version in the registry
  installedVersion: string | null; // version on disk (null if not installed)
  updateAvailable: boolean; // registry version > installed - offer Update (re-install)
  urlConfig: string | null; // config section holding the app's server URL (self-hosted apps)
  baseUrl: string; // current value of that URL ("" = not set)
  missing: string[]; // binaries the app needs but the box lacks (tvbox deps <id>)
  changelog: { version: string; notes: string }[]; // release notes, newest version first (English, from the manifest)
}
export interface StoreList {
  registry: string;
  apps: StoreEntry[];
  error: string | null;
  updates: string[]; // ids with an update available - for a HOME "updates" hint
}

export async function fetchStore(refresh = false): Promise<StoreList | null> {
  try {
    const res = await fetch("/tvbox/api/store/list" + (refresh ? "?refresh=1" : ""), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()) as StoreList;
  } catch (e) {
    console.warn("[launcher] store list failed:", e);
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

export const storeInstall = (id: string) => post("/tvbox/api/store/install", { id });
export const storeUninstall = (id: string) => post("/tvbox/api/store/uninstall", { id });
// Set a urlConfig app's server address (empty clears it).
export const saveAppUrl = (key: string, baseUrl: string) => post("/tvbox/api/config/app", { key, baseUrl });

// Remove an installed web-client bundle (Settings → Apps). The manifest stays;
// the tile reverts to installable.
export async function removeApp(id: string): Promise<boolean> {
  try {
    const res = await fetch("/tvbox/api/apps/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    return !!d.ok;
  } catch {
    return false;
  }
}
