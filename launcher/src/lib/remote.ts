// Launcher-side access to the shell's remote-input bridge (per-device button
// remap). The bridge publishes the connected remotes and, in learn mode, the
// last button pressed; the shell proxies those plus the saved keymap.
import type { RemoteAction, RemoteKeymap } from "@sdk/config";

// Order shown in the remap UI. Mirrors ACTION_KEY in remote_input_bridge.py.
// The volume trio doubles as the IR-blaster hook: when config.ir is set, the
// bridge forwards these to the TV over IR instead of emitting them.
export const REMOTE_ACTIONS: RemoteAction[] = [
  "up",
  "down",
  "left",
  "right",
  "ok",
  "back",
  "home",
  "playpause",
  "rewind",
  "fastforward",
  "prev",
  "next",
  "stop",
  "volume_up",
  "volume_down",
  "mute",
  // special: the bridge acts instead of emitting a key
  "power",
  "settings",
  "appswitcher",
];

export interface ConnectedRemote {
  id: string;
  name: string;
  keymap: RemoteKeymap;
}
export interface LearnedButton {
  id: string;
  code: number;
  name: string;
  ts: number;
}

async function getJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return fallback; // a 404/500 (with or without a JSON body) is "no data"
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}
async function post(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    /* bridge/shell down - caller reflects "no device" state */
  }
}

export async function fetchRemoteDevices(): Promise<ConnectedRemote[]> {
  return (await getJson<{ devices: ConnectedRemote[] }>("/tvbox/api/remote/devices", { devices: [] })).devices ?? [];
}
export async function fetchLearned(): Promise<LearnedButton | null> {
  return (await getJson<{ learned: LearnedButton | null }>("/tvbox/api/remote/learned", { learned: null })).learned;
}
export function learnRemote(id: string): Promise<void> {
  return post("/tvbox/api/remote/learn", { id });
}
export function learnRemoteOff(): Promise<void> {
  return post("/tvbox/api/remote/learn-off", {});
}
// Reset one remote's remapping through the shell endpoint (NOT a client-side
// config rewrite): the endpoint preserves irPassthrough, which a plain
// devices-map save would drop. Same path the bridge's panic gesture uses.
export function resetRemote(id: string): Promise<void> {
  return post("/tvbox/api/remote/reset", { id });
}
