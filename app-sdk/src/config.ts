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
  | "next"
  | "volume_up"
  | "volume_down"
  | "mute"
  // special: no key emitted - the bridge acts (TV power toggle / open Settings
  // / cycle running apps / launch the app named after the colon)
  | "power"
  | "settings"
  | "appswitcher"
  | `app:${string}`;
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
  parental: { pinSet: boolean; lockedGroups: string[]; requirePin: boolean };
  spotify: { deviceName: string; hasCredentials: boolean; enabled: boolean };
  ambient: { enabled: boolean; idleMinutes: number; city: string; sleepMinutes: number; bing: boolean };
  ui: { hourFormat: "auto" | "12" | "24"; navSounds: boolean };
  update: { auto: boolean; appsAuto: boolean };
  wifi: { country: string };
  player: { audioLang: string; subLang: string };
  remote: { devices: Record<string, RemoteDeviceConfig>; power: RemotePower };
  // MQTT bridge (Home Assistant / any broker). Secret-free: hasPassword says
  // whether one is stored, never the value. port null = the default (1883).
  mqtt: {
    configured: boolean;
    host: string;
    port: number | null;
    username: string;
    hasPassword: boolean;
    deviceId: string;
  };
  // IR blaster (shell ir.js): TV volume/mute over a network IR transceiver.
  // Secret-free: the ESPHome encryption key / HA token are write-only (has*).
  // port null = the ESPHome default (6053). Actions map an abstract command
  // (volume_up/volume_down/mute) to a backend value (signal option / HA script).
  // background apps (shell appwindows.js): leaving an app hides its window for
  // instant resume; false = the old destroy-on-leave behavior
  apps: { background: boolean };
  ir: {
    configured: boolean;
    backend: IrBackend;
    esphome: {
      host: string;
      port: number | null;
      hasEncryptionKey: boolean;
      select: string;
      button: string;
      actions: IrActionMap;
    };
    homeassistant: { url: string; hasToken: boolean; actions: IrActionMap };
  };
}

export type IrBackend = "esphome" | "homeassistant";
export type IrAction = "volume_up" | "volume_down" | "mute";
export type IrActionMap = Partial<Record<IrAction, string>>;

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

// POST a partial config patch and return the fresh PublicConfig the shell echoes
// back. Every save funnels through here so failure handling is uniform: a
// non-2xx response (or a body missing `config`) THROWS rather than resolving
// with `undefined`, which would corrupt useConfigStore.config. This mirrors
// fetchConfig's "don't silently write garbage into the store" contract - the
// store's setters await these, so a throw surfaces as a rejected save the caller
// can catch, instead of a store quietly holding an invalid config.
async function postConfig(patch: Record<string, unknown>): Promise<PublicConfig> {
  const res = await fetch("/tvbox/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("config save failed: HTTP " + res.status);
  const data = await res.json();
  if (!data || !data.config) throw new Error("config save failed: no config in response");
  return data.config as PublicConfig;
}

export type IptvInput =
  | { mode: "xtream"; xtream: { base: string; user: string; pass: string } }
  | { mode: "m3u"; m3u: { url: string; epgUrl: string } };

export async function saveIptv(iptv: IptvInput): Promise<PublicConfig> {
  return postConfig({ iptv });
}

export async function saveParental(p: {
  pin?: string;
  lockedGroups?: string[];
  requirePin?: boolean;
}): Promise<PublicConfig> {
  return postConfig({ parental: p });
}

export type AmbientInput = Partial<{
  enabled: boolean;
  idleMinutes: number;
  city: string;
  sleepMinutes: number;
  bing: boolean; // mix Bing's daily wallpapers into the slideshow (shell-cached)
}>;
export async function saveAmbient(ambient: AmbientInput): Promise<PublicConfig> {
  return postConfig({ ambient });
}

// Wi-Fi regulatory country (ISO 3166-1 alpha-2, "" = image default). Applied
// at the next boot by the root-side unit; the shell only stores it.
export async function saveWifi(wifi: { country: string }): Promise<PublicConfig> {
  return postConfig({ wifi });
}

// Launcher UI preferences (clock format; "auto" = whatever the locale does).
export type UiInput = Partial<{ hourFormat: "auto" | "12" | "24"; navSounds: boolean }>;
export async function saveUi(ui: UiInput): Promise<PublicConfig> {
  return postConfig({ ui });
}

// Shared-player track-language defaults (mpv --alang/--slang; "" = stream default).
export type PlayerInput = Partial<{ audioLang: string; subLang: string }>;
export async function savePlayer(player: PlayerInput): Promise<PublicConfig> {
  return postConfig({ player });
}

// MQTT broker connection (Home Assistant or any broker). The shell whitelists
// and sanitizes (config.js setMqtt): an empty host clears the whole section
// (integration off); an empty password keeps the stored one, so re-saving the
// other fields never wipes the secret. Applied live - the shell reconnects.
export type MqttInput = Partial<{
  host: string;
  port: number | null;
  username: string;
  password: string;
  deviceId: string;
}>;
export async function saveMqtt(mqtt: MqttInput): Promise<PublicConfig> {
  return postConfig({ mqtt });
}

// IR blaster backend + action map. The shell merges like setMqtt: send the FULL
// block for the backend being edited (an empty host/url clears that block, an
// empty secret keeps the stored one); an omitted block stays untouched.
export type IrInput = Partial<{
  backend: IrBackend;
  esphome: Partial<{
    host: string;
    port: number | null;
    encryptionKey: string;
    select: string;
    button: string;
    actions: IrActionMap;
  }>;
  homeassistant: Partial<{ url: string; token: string; actions: IrActionMap }>;
}>;
export async function saveIr(ir: IrInput): Promise<PublicConfig> {
  return postConfig({ ir });
}

// OTA auto-update toggle (the feed URL itself is box-local, not a UI concern).
export async function saveUpdate(update: { auto?: boolean; appsAuto?: boolean }): Promise<PublicConfig> {
  return postConfig({ update });
}

// Per-device remote button remap. The caller sends the FULL desired devices map
// (the shell replaces devices, but merges around power) and the shell reloads the bridge.
export async function saveRemote(devices: Record<string, RemoteDeviceConfig>): Promise<PublicConfig> {
  return postConfig({ remote: { devices } });
}

// Power-button policy (independent of the per-device keymap).
export async function saveRemotePower(power: RemotePower): Promise<PublicConfig> {
  return postConfig({ remote: { power } });
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
