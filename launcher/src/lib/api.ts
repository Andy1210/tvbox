import type { AppManifest } from "./types";

// The shell publishes installed app manifests here. During `vite dev` (no
// shell) the fetch fails and we fall back to a static list so the UI still
// renders - the real list always comes from the shell in production.
//
// This is also the single source of truth for the demo build's base app tiles:
// demo/data.ts re-exports it as BASE_APPS (demo -> lib is the safe import
// direction; prod never pulls demo/ in). Keep the two in sync THROUGH that
// re-export, never by copying the array.
export const FALLBACK_APPS: AppManifest[] = [
  {
    id: "plex",
    name: "Plex",
    tagline: { hu: "Filmek és sorozatok", en: "Movies & TV shows" },
    type: "webclient",
    status: "ready",
    accent: "#e5a00d",
    icon: "<svg viewBox='0 0 512 512'><rect width='512' height='512' rx='15%' fill='#282a2d'/><path d='m256 70h-108l108 186-108 186h108l108-186z' fill='#e5a00d'/></svg>",
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
    icon: "<svg viewBox='0 0 28.57 20'><path d='M27.9727 3.12324C27.6435 1.89323 26.6768 0.926623 25.4468 0.597366C23.2197 2.24288e-07 14.285 0 14.285 0C14.285 0 5.35042 2.24288e-07 3.12323 0.597366C1.89323 0.926623 0.926623 1.89323 0.597366 3.12324C2.24288e-07 5.35042 0 10 0 10C0 10 2.24288e-07 14.6496 0.597366 16.8768C0.926623 18.1068 1.89323 19.0734 3.12323 19.4026C5.35042 20 14.285 20 14.285 20C14.285 20 23.2197 20 25.4468 19.4026C26.6768 19.0734 27.6435 18.1068 27.9727 16.8768C28.5701 14.6496 28.5701 10 28.5701 10C28.5701 10 28.5677 5.35042 27.9727 3.12324Z' fill='#FF0000'/><path d='M11.4253 14.2854L18.8477 10.0004L11.4253 5.71533V14.2854Z' fill='#fff'/></svg>",
  },
  {
    id: "spotify",
    name: "Spotify",
    tagline: { hu: "Zene", en: "Music" },
    type: "webclient",
    status: "ready",
    accent: "#1DB954",
    icon: "<svg viewBox='0 0 496 512'><path fill='#1ed760' d='M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8Z'/><path d='M406.6 231.1c-5.2 0-8.4-1.3-12.9-3.9-71.2-42.5-198.5-52.7-280.9-29.7-3.6 1-8.1 2.6-12.9 2.6-13.2 0-23.3-10.3-23.3-23.6 0-13.6 8.4-21.3 17.4-23.9 35.2-10.3 74.6-15.2 117.5-15.2 73 0 149.5 15.2 205.4 47.8 7.8 4.5 12.9 10.7 12.9 22.6 0 13.6-11 23.3-23.2 23.3zm-31 76.2c-5.2 0-8.7-2.3-12.3-4.2-62.5-37-155.7-51.9-238.6-29.4-4.8 1.3-7.4 2.6-11.9 2.6-10.7 0-19.4-8.7-19.4-19.4s5.2-17.8 15.5-20.7c27.8-7.8 56.2-13.6 97.8-13.6 64.9 0 127.6 16.1 177 45.5 8.1 4.8 11.3 11 11.3 19.7-.1 10.8-8.5 19.5-19.4 19.5zm-26.9 65.6c-4.2 0-6.8-1.3-10.7-3.6-62.4-37.6-135-39.2-206.7-24.5-3.9 1-9 2.6-11.9 2.6-9.7 0-15.8-7.7-15.8-15.8 0-10.3 6.1-15.2 13.6-16.8 81.9-18.1 165.6-16.5 237 26.2 6.1 3.9 9.7 7.4 9.7 16.5s-7.1 15.4-15.2 15.4z'/></svg>",
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

// Quit a RUNNING (background) app: the shell destroys its window and page
// state; the next launch is a fresh start. HOME's running-apps row calls this.
export async function quitApp(id: string): Promise<boolean> {
  try {
    const res = await fetch("/tvbox/api/apps/quit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return !!((await res.json()) as { ok?: boolean }).ok;
  } catch {
    return false;
  }
}

// ---- app store (Settings → Store): a git-hosted registry of vetted,
// manifest-only apps. Install = the shell writes the manifest to
// ~/.tvbox/apps/<id>.json; the HOME tile appears live. ----
export interface StoreEntry {
  id: string;
  name: import("./types").LocaleString;
  tagline?: import("./types").LocaleString;
  description?: import("./types").LocaleString | null; // longer store-detail copy
  screenshots?: string[]; // https screenshot URLs for the store detail (may be [])
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
  installing: boolean; // a full install (deps + bundle) is currently running in the background
  progress: { phase: string } | null; // install phase while installing (deps | bundle | finishing), null otherwise
}
export interface StoreList {
  registry: string;
  apps: StoreEntry[];
  error: string | null;
  updates: string[]; // ids with an update available - for a HOME "updates" hint
  installing?: string[]; // ids currently installing (mirrors entry.installing)
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
