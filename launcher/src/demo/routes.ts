// In-memory shell API for the demo build. install.ts patches window.fetch and
// forwards every /tvbox/api/* call here; state (installed apps, WiFi pick,
// audio volume, …) lives for the session only, so a reload resets the demo.
import type { AppManifest } from "../lib/types";
import type { PublicConfig } from "../lib/config";
import * as data from "./data";
import { demoLocale, notifyAll } from "./bridge";

const config: PublicConfig = structuredClone(data.CONFIG);
const region = structuredClone(data.REGION);
const wifiNetworks = data.WIFI_NETWORKS.map((n) => ({ ...n }));
const btDevices = data.BT_DEVICES.map((d) => ({ ...d }));
const audio = structuredClone(data.AUDIO);
const display = structuredClone(data.DISPLAY);
let btExtraFound = false;
let jellyfinInstalled = false;
let jellyfinUrl = "";
let parentalPin = "";
let updateLastCheck: number | null = null;
// Active phone-pairing kind (null = none). While an "iptv"/"spotify" pairing
// runs, the matching config flag reads false so the QR screen stays open -
// on a real box the phone's submit flips it; in the demo Back (pairing/stop)
// restores it. The QR points at the static demo phone page (demo-public/pair/).
let pairingKind: string | null = null;

const ok = { ok: true };

function pairingStart(b: Record<string, unknown>) {
  pairingKind = typeof b.kind === "string" ? b.kind : "iptv";
  const code = Array.from({ length: 4 }, () => "0123456789"[Math.floor(Math.random() * 10)]).join("");
  const base = window.location.origin + window.location.pathname.replace(/[^/]*$/, "");
  const lang = typeof b.locale === "string" ? b.locale : "en";
  const url = `${base}pair/?kind=${pairingKind}&lang=${lang}&c=${code}`;
  return { ok: true, url, shortUrl: base.replace(/^https?:\/\//, "") + "pair", code };
}

// HOME shows only `ready` (launchable) apps now; installing is the store's job.
// The base apps are all installed + ready; jellyfin is only ready once its
// server URL is set (an unconfigured app stays in the store, not on HOME).
function appsList(): AppManifest[] {
  const apps = data.BASE_APPS.map((a) => ({ ...a, ready: true, progress: null }));
  if (jellyfinInstalled) {
    const configured = jellyfinUrl !== "";
    apps.push({ ...data.JELLYFIN_APP, configured, ready: configured, progress: null });
  }
  return apps;
}

function updateStatus() {
  return { ...data.UPDATE_STATUS, lastCheckAt: updateLastCheck, auto: config.update.auto };
}

const POWER_MSG: Record<string, Record<string, string>> = {
  en: {
    sleep: "On a real box the display would turn off now (HDMI-CEC standby).",
    reboot: "On a real box this would reboot the device.",
    poweroff: "On a real box this would power the device off.",
  },
  hu: {
    sleep: "A valódi eszközön most kikapcsolna a TV (HDMI-CEC standby).",
    reboot: "A valódi eszköz most újraindulna.",
    poweroff: "A valódi eszköz most kikapcsolna.",
  },
};

function applyConfig(body: Record<string, unknown>): void {
  if (body.iptv) config.iptv = { ...config.iptv, configured: true };
  if (body.parental && typeof body.parental === "object") {
    const p = body.parental as { pin?: string; lockedGroups?: string[]; requirePin?: boolean };
    if (p.pin !== undefined) {
      parentalPin = p.pin;
      config.parental.pinSet = p.pin !== "";
    }
    if (p.lockedGroups) config.parental.lockedGroups = p.lockedGroups;
    if (p.requirePin !== undefined) config.parental.requirePin = !!p.requirePin;
  }
  if (body.ambient && typeof body.ambient === "object") Object.assign(config.ambient, body.ambient);
  if (body.update && typeof body.update === "object") Object.assign(config.update, body.update);
  if (body.ui && typeof body.ui === "object") Object.assign(config.ui, body.ui);
  if (body.player && typeof body.player === "object") Object.assign(config.player, body.player);
  if (body.wifi && typeof body.wifi === "object") Object.assign(config.wifi, body.wifi);
  if (body.mqtt && typeof body.mqtt === "object") {
    // mirrors shell config.setMqtt: an empty host clears the section (integration
    // off); an empty password keeps the stored one, a non-empty one replaces it
    const m = body.mqtt as {
      host?: string;
      port?: number | null;
      username?: string;
      password?: string;
      deviceId?: string;
    };
    const host = (m.host ?? "").trim();
    if (!host) {
      config.mqtt = { configured: false, host: "", port: null, username: "", hasPassword: false, deviceId: "" };
    } else {
      const port = Number(m.port);
      config.mqtt.host = host;
      config.mqtt.port = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
      config.mqtt.username = (m.username ?? "").trim();
      config.mqtt.deviceId = (m.deviceId ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
      if (m.password) config.mqtt.hasPassword = true;
      config.mqtt.configured = !!(config.mqtt.host && config.mqtt.username);
    }
  }
  if (body.display && typeof body.display === "object") {
    const d = body.display as { matchFramerate?: boolean };
    if (d.matchFramerate !== undefined) display.matchFramerate = d.matchFramerate;
  }
  if (typeof body.spotifyDeviceName === "string") config.spotify.deviceName = body.spotifyDeviceName;
}

export async function handleApi(
  method: string,
  path: string,
  _params: URLSearchParams,
  body: unknown,
): Promise<unknown> {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (path) {
    // ---- config ----
    case "/tvbox/api/config":
      if (method === "POST") {
        applyConfig(b);
        return { ok: true, config };
      }
      // during a phone pairing the matching "already set up" flag reads false,
      // so the QR screen doesn't dismiss itself (see pairingKind above)
      return {
        ...config,
        iptv: { ...config.iptv, configured: config.iptv.configured && pairingKind !== "iptv" },
        spotify: { ...config.spotify, hasCredentials: config.spotify.hasCredentials && pairingKind !== "spotify" },
      };
    case "/tvbox/api/parental/verify":
      return { ok: config.parental.pinSet && b.pin === parentalPin };

    // ---- apps + store ----
    case "/tvbox/api/apps":
      return appsList();
    case "/tvbox/api/apps/remove":
      // still reachable from Settings → Apps; the demo base apps aren't
      // removable, so this is a no-op here.
      return ok;
    case "/tvbox/api/store/list":
      return {
        registry: "github.com/Andy1210/tvbox · registry/",
        apps: data.STORE_ENTRIES.map((e) =>
          e.id === "jellyfin" ? { ...e, installed: jellyfinInstalled, baseUrl: jellyfinUrl } : { ...e },
        ),
        error: null,
        updates: [],
        installing: [],
      };
    case "/tvbox/api/store/install":
      // POST /store/install does the full install and returns at once; the demo
      // completes instantly (installing stays false in /store/list).
      jellyfinInstalled = true;
      return ok;
    case "/tvbox/api/store/uninstall":
      jellyfinInstalled = false;
      jellyfinUrl = "";
      return ok;
    case "/tvbox/api/config/app":
      if (b.key === "jellyfin") jellyfinUrl = String(b.baseUrl ?? "");
      return ok;

    // ---- settings: network / bt / audio / display ----
    case "/tvbox/api/wifi/status": {
      const active = wifiNetworks.find((n) => n.active);
      return { ...data.WIFI_STATUS, connected: !!active, ssid: active?.ssid ?? "" };
    }
    case "/tvbox/api/wifi/list":
      return { networks: wifiNetworks };
    case "/tvbox/api/wifi/connect":
      for (const n of wifiNetworks) n.active = n.ssid === b.ssid;
      return ok;
    case "/tvbox/api/bt/status":
      return { powered: true, discovering: false };
    case "/tvbox/api/bt/devices":
      return { devices: btDevices };
    case "/tvbox/api/bt/scan":
      await new Promise((r) => setTimeout(r, 1500));
      if (!btExtraFound) {
        btDevices.push({ ...data.BT_SCAN_EXTRA });
        btExtraFound = true;
      }
      return { devices: btDevices };
    case "/tvbox/api/bt/pair":
    case "/tvbox/api/bt/connect":
    case "/tvbox/api/bt/disconnect":
    case "/tvbox/api/bt/remove": {
      const action = path.split("/").pop()!;
      const i = btDevices.findIndex((d) => d.mac === b.mac);
      if (i >= 0) {
        if (action === "remove") btDevices.splice(i, 1);
        else if (action === "pair") Object.assign(btDevices[i], { paired: true, connected: true });
        else btDevices[i].connected = action === "connect";
      }
      return ok;
    }
    case "/tvbox/api/audio/sinks":
      return audio;
    case "/tvbox/api/audio/default":
      audio.override = b.sink ? String(b.sink) : null;
      for (const s of audio.sinks) s.isDefault = audio.override ? s.name === audio.override : s.id === 51;
      return ok;
    case "/tvbox/api/audio/volume": {
      const s = audio.sinks.find((x) => x.id === b.id);
      if (s) s.volume = Number(b.volume);
      return ok;
    }
    case "/tvbox/api/display/modes":
      return display;
    case "/tvbox/api/display/apply":
      for (const m of display.modes) m.current = m.key === b.mode;
      display.saved = String(b.mode ?? "");
      return ok;

    // ---- system / update / ambient / backup / misc ----
    case "/tvbox/api/system/info":
      return data.SYSTEM_INFO;
    case "/tvbox/api/system/region":
      return region;
    case "/tvbox/api/system/timezone":
      region.timezone = String(b.timezone ?? region.timezone);
      return ok;
    case "/tvbox/api/system/keymap":
      // The real box may reject this until a polkit grant ships; the demo shows
      // the happy path so the picker's highlight tracks the selection.
      region.keymap = String(b.keymap ?? region.keymap);
      return ok;
    case "/tvbox/api/system/hostname":
      data.SYSTEM_INFO.hostname = String(b.hostname ?? data.SYSTEM_INFO.hostname);
      return ok;
    case "/tvbox/api/update/status":
      return updateStatus();
    case "/tvbox/api/update/check":
      updateLastCheck = Date.now();
      return updateStatus();
    case "/tvbox/api/update/apply":
      return updateStatus();
    case "/tvbox/api/ambient/weather":
      return data.WEATHER;
    case "/tvbox/api/ambient/photos":
      return { photos: [] };
    case "/tvbox/api/ambient/photos/clear":
      return { removed: 0 };
    case "/tvbox/api/ambient/photos/delete":
      return ok;
    case "/tvbox/api/backup/status":
      return { restoredAt: null };
    case "/tvbox/api/backup/context":
      return ok;
    case "/tvbox/api/backup/pending-localstorage":
      return { data: "" };
    case "/tvbox/api/backup/pending-localstorage/clear":
      return ok;
    case "/tvbox/api/nowplaying":
      return ok;
    case "/tvbox/api/pairing/start":
      return pairingStart(b);
    case "/tvbox/api/pairing/status":
      return { active: pairingKind !== null, phoneConnected: false, done: false };
    case "/tvbox/api/pairing/stop":
      pairingKind = null;
      return ok;
    case "/tvbox/api/power": {
      const action = String(b.action ?? "sleep");
      const msgs = POWER_MSG[demoLocale()] ?? POWER_MSG.en;
      notifyAll({ title: "tvbox demo", message: msgs[action] ?? msgs.sleep, duration: 4000 });
      return ok;
    }

    // ---- remote remap + Fire TV IR (Settings → Peripherals) ----
    case "/tvbox/api/remote/devices":
      return { devices: data.REMOTES };
    case "/tvbox/api/remote/learned":
      return { learned: null };
    case "/tvbox/api/remote/learn":
    case "/tvbox/api/remote/learn-off":
      return ok;
    case "/tvbox/api/firetvir/status":
      // deps ready, TV brand pre-detected from EDID - so the flow lands straight
      // on brand/codeset like it would on a box that's already set up.
      return {
        toolPresent: true,
        venvPresent: true,
        depsOk: true,
        installing: false,
        installStep: "",
        installError: "",
        configured: null,
        suggestedBrand: "LG",
      };
    case "/tvbox/api/firetvir/programmable":
      return { macs: data.REMOTES.map((r) => r.id.toLowerCase()) };
    case "/tvbox/api/firetvir/brands":
      return { ok: true, brands: data.IR_BRANDS };
    case "/tvbox/api/firetvir/codeset":
      return {
        ok: true,
        path: "codes/LG/TV/4,-1.csv",
        keys: {
          VolumeUp: { functionname: "VOLUME +", protocol: "NEC1" },
          VolumeDown: { functionname: "VOLUME -", protocol: "NEC1" },
          Mute: { functionname: "MUTE", protocol: "NEC1" },
          Power: { functionname: "POWER TOGGLE", protocol: "NEC1" },
        },
        protocols: ["NEC1"],
        supported: { NEC1: true },
      };
    case "/tvbox/api/firetvir/deps":
      return ok;
    case "/tvbox/api/firetvir/test":
      return { ok: true, output: "demo: IR sent (no real remote here)" };
    case "/tvbox/api/firetvir/program":
      return { ok: true, output: "demo: keymap written to the remote" };
    case "/tvbox/api/firetvir/erase":
      return ok;
  }
  return undefined;
}
