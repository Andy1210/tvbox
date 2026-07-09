// Per-device remote button remap (consumed by remote_input_bridge.py). Codes
// are evdev keycodes captured in learn mode; actions mirror the bridge's set.
export type RemoteAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "ok"
  | "back"
  | "home"
  | "playpause"
  | "stop"
  | "rewind"
  | "fastforward"
  | "prev"
  | "next";
export type RemoteKeymap = Partial<Record<RemoteAction, number[]>>;
export interface RemoteDeviceConfig {
  name: string;
  keymap: RemoteKeymap;
}
// What the remote's Power button does: turn the TV off over CEC only (default),
// also power the box off, or nothing. The button never reaches the OS (the
// bridge intercepts it) so it can't accidentally power the box off.
export type RemotePower = "tv" | "tv_and_box" | "ignore";

// Launcher-side access to the shell config store (secret-free). The parental
// PIN is verified server-side; the launcher only sees whether one is set.
export interface PublicConfig {
  iptv: {
    mode: "xtream" | "m3u" | null;
    xtream: { base: string; user: string } | null;
    m3u: { url: string; epgUrl: string } | null;
    configured: boolean;
  };
  parental: { pinSet: boolean; lockedGroups: string[] };
  spotify: { deviceName: string; hasCredentials: boolean; enabled: boolean };
  ambient: { enabled: boolean; idleMinutes: number; city: string };
  update: { auto: boolean };
  remote: { devices: Record<string, RemoteDeviceConfig>; power: RemotePower };
}

// null = the shell is unreachable - NOT the same as an unconfigured box. The
// UI must offer retry instead of dropping the user into first-run onboarding
// over a transient shell hiccup.
export async function fetchConfig(): Promise<PublicConfig | null> {
  try {
    const res = await fetch("/tvbox/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()) as PublicConfig;
  } catch (e) {
    console.warn("[launcher] /tvbox/api/config unavailable:", e);
    return null;
  }
}

export type IptvInput =
  | { mode: "xtream"; xtream: { base: string; user: string; pass: string } }
  | { mode: "m3u"; m3u: { url: string; epgUrl: string } };

export async function saveIptv(iptv: IptvInput): Promise<PublicConfig> {
  const res = await fetch("/tvbox/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ iptv }),
  });
  const data = await res.json();
  return data.config as PublicConfig;
}

export async function saveParental(p: { pin?: string; lockedGroups?: string[] }): Promise<PublicConfig> {
  const res = await fetch("/tvbox/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parental: p }),
  });
  const data = await res.json();
  return data.config as PublicConfig;
}

export type AmbientInput = Partial<{ enabled: boolean; idleMinutes: number; city: string }>;
export async function saveAmbient(ambient: AmbientInput): Promise<PublicConfig> {
  const res = await fetch("/tvbox/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ambient }),
  });
  const data = await res.json();
  return data.config as PublicConfig;
}

// OTA auto-update toggle (the feed URL itself is box-local, not a UI concern).
export async function saveUpdate(update: { auto: boolean }): Promise<PublicConfig> {
  const res = await fetch("/tvbox/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ update }),
  });
  const data = await res.json();
  return data.config as PublicConfig;
}

// Per-device remote button remap. The caller sends the FULL desired devices map
// (the shell replaces devices, but merges around power) and the shell reloads the bridge.
export async function saveRemote(devices: Record<string, RemoteDeviceConfig>): Promise<PublicConfig> {
  const res = await fetch("/tvbox/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remote: { devices } }),
  });
  const data = await res.json();
  return data.config as PublicConfig;
}

// Power-button policy (independent of the per-device keymap).
export async function saveRemotePower(power: RemotePower): Promise<PublicConfig> {
  const res = await fetch("/tvbox/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remote: { power } }),
  });
  const data = await res.json();
  return data.config as PublicConfig;
}

export async function verifyPin(pin: string): Promise<boolean> {
  try {
    const res = await fetch("/tvbox/api/parental/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    return !!data.ok;
  } catch {
    return false;
  }
}
