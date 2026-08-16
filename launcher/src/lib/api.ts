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
  // The flatpak(s) this app is: what it RUNS (RetroArch) or what its bundle was
  // extracted FROM (Plex). Its version is the box's, not the registry's, and it
  // moves through `flatpak update` - the nightly timer or the manual button.
  flatpaks?: { ref: string; name: string; version: string | null }[];
  flatpakStatus?: { ok: boolean; changed: boolean; version: string | null } | null; // last manual flatpak update
  source?: StoreSource; // the registry this entry came from
  // Other configured registries offering the same id. Enough to draw a button
  // rather than only to name them: switching an app to a local copy of itself is
  // how somebody debugs an app that is also published.
  alsoIn?: { url: string; name: string | null; official: boolean; silent?: boolean }[];
  /** The app came from a registry other than the one offering it now. */
  pinnedElsewhere?: boolean;
}
// A configured registry. The first one the box returns is the primary (the
// official index unless it was replaced); the rest were added by the owner.
export interface StoreSource {
  url: string;
  official: boolean; // the index this release ships - the only one that arrived reviewed
  name: string | null; // the owner's label for it
  autoUpdate: boolean; // may the box install this registry's updates unattended
  error?: string | null; // why this registry did not answer (the others still did)
  count?: number; // apps it contributed to the catalogue
}
export interface StoreList {
  registry: string;
  apps: StoreEntry[];
  error: string | null; // no registry at all answered
  updates: string[]; // ids with an update available - for a HOME "updates" hint
  autoUpdates?: string[]; // the subset the nightly run may install by itself
  sources?: StoreSource[]; // every configured registry, primary first
  maxSources?: number; // how many the box will take beyond the primary
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

// `sourceUrl` names WHICH configured registry to take it from - the box checks
// it against its own list, so this is a choice between sources already trusted,
// never a new one. Omitted, the app comes from wherever it stands now.
export const storeInstall = (id: string, sourceUrl?: string): Promise<{ ok: boolean; error?: string }> =>
  // The BODY, not just the boolean. The box distinguishes "that registry does
  // not offer it" from "registry unreachable" from "not a configured registry",
  // and a screen that renders all three as "action failed" throws away the only
  // sentence that tells somebody what to do next.
  postJson("/tvbox/api/store/install", sourceUrl ? { id, sourceUrl } : { id }, { ok: false });
export const storeUninstall = (id: string) => post("/tvbox/api/store/uninstall", { id });
// The added registries, saved as a whole list (an add, a rename and a removal are
// the same edit to the same array). `autoUpdate` is the PRIMARY registry's flag;
// each added source carries its own inside the array. The box answers with what it
// stored, so a refused entry - a bad url, a duplicate, one over the cap - comes
// back missing rather than being shown as saved.
export async function saveStoreSources(
  sources: { url: string; name?: string | null; autoUpdate?: boolean }[],
  autoUpdate?: boolean,
): Promise<{ ok: boolean; sources: { url: string; name?: string; autoUpdate?: boolean }[] }> {
  try {
    const res = await fetch("/tvbox/api/store/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources, ...(autoUpdate === undefined ? {} : { autoUpdate }) }),
    });
    const d = await res.json();
    return { ok: !!d.ok, sources: Array.isArray(d.sources) ? d.sources : [] };
  } catch {
    return { ok: false, sources: [] };
  }
}
// Move the app's flatpak now instead of waiting for the nightly timer. Returns as
// soon as the update is running; the store polls /store/list for the outcome.
// The reason matters here: "busy" is a refusal to start, not a failed update.
export async function storeFlatpakUpdate(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/tvbox/api/store/flatpak-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    return { ok: !!d.ok, error: d.error };
  } catch {
    return { ok: false };
  }
}
// Tell the box onboarding is finished. Best-effort: the launcher's own copy in
// localStorage still drives the first render, this is what survives a browser-store
// hiccup (an instance that lost Chromium's storage lock reads nothing).
export const markSetupDoneOnBox = () => post("/tvbox/api/setup/done", {});
// ---- LAN file server (WebDAV) ----
// The candidate folders come from the BOX (it discovers them); the launcher only
// renders them and sends back which ids are shared. The password is write-only:
// `hasPass` says whether one is stored, omitting it keeps it.
export interface FileServerStatus {
  enabled: boolean;
  running: boolean;
  user: string;
  hasPass: boolean;
  port: number;
  url: string | null; // the LAN address to type on a computer
  folders: string[]; // candidate ids currently shared
  shared: string[]; // the names a computer sees
  rclone: boolean; // the binary that serves it is present
  installing?: boolean; // ...and is being fetched right now
  minPassword: number;
  candidates: { id: string; name: string; warn: boolean }[]; // name = what a computer will see
}
export async function fetchFileServer(): Promise<FileServerStatus | null> {
  try {
    const res = await fetch("/tvbox/api/fileserver", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()) as FileServerStatus;
  } catch (e) {
    console.warn("[launcher] file server status failed:", e);
    return null;
  }
}
export async function saveFileServer(patch: {
  enabled?: boolean;
  user?: string;
  port?: number;
  folders?: string[];
  pass?: string;
}): Promise<{ ok: boolean; error?: string; status?: FileServerStatus }> {
  try {
    const res = await fetch("/tvbox/api/fileserver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return await res.json();
  } catch {
    return { ok: false, error: "failed" };
  }
}
export const installRclone = () => post("/tvbox/api/fileserver/install-rclone", {});

// App sharing: the folders installed apps declare, offered read-only to another
// box, and the boxes this one has been paired with. No credential ever crosses
// this boundary - the box says whether it HAS a token, never what it is.
export interface AppShare {
  id: string; // "<app id>/<share name>", stable: what the enable list stores
  appId: string;
  appName: string;
  name: string;
  present: boolean; // the folder exists (an app that has saved nothing yet has not made it)
  on: boolean;
}
export interface AppSharesStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  issued: number; // boxes holding a key to this one - each revocable on its own
  rclone: boolean;
  installing?: boolean;
  shares: AppShare[];
  serving: string[];
  peers: { id: string; name: string; host: string }[];
}
export async function fetchAppShares(): Promise<AppSharesStatus | null> {
  try {
    const res = await fetch("/tvbox/api/appshares", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()) as AppSharesStatus;
  } catch (e) {
    console.warn("[launcher] app shares status failed:", e);
    return null;
  }
}
export const saveAppShares = (enabled: string[]) =>
  postJson<{ ok: boolean; error?: string; status?: AppSharesStatus }>(
    "/tvbox/api/appshares",
    { enabled },
    {
      ok: false,
      error: "failed",
    },
  );
// A sweep of the LAN for a box that is waiting to pair right now. Slow by nature,
// so it is a button rather than something the page does on its own.
export const scanForBoxes = () =>
  postJson<{ ok: boolean; found?: { host: string }[]; error?: string }>(
    "/tvbox/api/appshares/scan",
    {},
    {
      ok: false,
      error: "failed",
    },
  );
export const pairWithBox = (host: string, code: string) =>
  postJson<{ ok: boolean; peer?: { id: string; name: string; host: string }; mutual?: boolean; error?: string }>(
    "/tvbox/api/appshares/pair",
    { host, code },
    { ok: false, error: "failed" },
  );
export const forgetBox = (id: string) =>
  postJson<{ ok: boolean }>("/tvbox/api/appshares/peer-remove", { id }, { ok: false });

// Screen mirroring (Wi-Fi Display). There is no stored setting to read: the box
// is either mirroring right now or it is not, because a group owner holds the
// radio and opens a pairing button that anyone in range could press. So this
// reports live state and the two actions that change it.
export interface MirrorStatus {
  armed: boolean;
  streaming: boolean;
  name: string; // what to look for in the phone's cast list
  ssid: string;
  channel: string;
}
export async function fetchMirroring(): Promise<MirrorStatus | null> {
  try {
    const res = await fetch("/tvbox/api/miracast", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()) as MirrorStatus;
  } catch (e) {
    console.warn("[launcher] mirroring status failed:", e);
    return null;
  }
}
// Not the plain `post` helper: arming fails for one reason worth reading - the
// radio is carrying the box's own network - and the sentence has to survive as
// far as the screen, because someone holding a remote cannot go and read a log.
async function mirrorAction(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false };
  }
}
export const startMirroring = () => mirrorAction("/tvbox/api/miracast/start");
export const stopMirroring = () => mirrorAction("/tvbox/api/miracast/stop");

// Network shares (SMB): the other direction of the file server - someone else's
// folders brought IN, so a film can live on a NAS. The password is never returned,
// only whether one is stored.
export interface ShareRow {
  name: string; // the mount folder, and the source name on the TV
  host: string;
  share: string;
  path: string; // sub-folder inside the share ("" = its root)
  user: string;
  domain: string;
  // What is on it, which decides how it is mounted: a film is streamed once, a
  // emulator seeks around a disc image for hours, so it has to be cached to play.
  cache: "media" | "games";
  hasPass: boolean;
  mountPoint: string;
  mounted: boolean;
}
export interface SharesStatus {
  rclone: boolean; // the binary that mounts them is present
  installing?: boolean; // ...and is being fetched right now
  max: number;
  shares: ShareRow[];
}
export interface ShareInput {
  original?: string; // the share being edited, when it is an edit
  name?: string;
  host?: string;
  share?: string;
  path?: string;
  cache?: "media" | "games";
  user?: string;
  domain?: string;
  pass?: string; // omitted keeps the stored one, "" clears it
}
export async function fetchShares(): Promise<SharesStatus | null> {
  try {
    const res = await fetch("/tvbox/api/shares", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()) as SharesStatus;
  } catch (e) {
    console.warn("[launcher] shares status failed:", e);
    return null;
  }
}
// These answer with the box's own reason for refusing (a name already taken, an
// address that is not one, rclone's NT_STATUS line), which the form shows - so
// unlike post() they carry the body back rather than just whether it worked.
async function postJson<T>(path: string, body: unknown, onFail: T): Promise<T> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  } catch {
    return onFail;
  }
}
export const saveShare = (input: ShareInput) =>
  postJson<{ ok: boolean; error?: string; status?: SharesStatus }>("/tvbox/api/shares/save", input, {
    ok: false,
    error: "failed",
  });
export const removeShare = (name: string) =>
  postJson<{ ok: boolean; status?: SharesStatus }>("/tvbox/api/shares/remove", { name }, { ok: false });
// With no `share` this asks the server what it offers; with one, what is inside it.
export const testShare = (input: ShareInput) =>
  postJson<{ ok: boolean; error?: string; dirs?: string[]; shares?: string[] }>("/tvbox/api/shares/test", input, {
    ok: false,
    error: "failed",
  });

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
