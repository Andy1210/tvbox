// In-memory shell API for the demo build. install.ts patches window.fetch and
// forwards every /tvbox/api/* call here; state (installed apps, WiFi pick,
// audio volume, …) lives for the session only, so a reload resets the demo.
import type { AppManifest } from "../lib/types";
import type { PublicConfig } from "../lib/config";
import * as data from "./data";
import { demoLocale, notifyAll } from "./bridge";

const config: PublicConfig = structuredClone(data.CONFIG);
const wifiNetworks = data.WIFI_NETWORKS.map((n) => ({ ...n }));
const btDevices = data.BT_DEVICES.map((d) => ({ ...d }));
const audio = structuredClone(data.AUDIO);
const display = structuredClone(data.DISPLAY);
let btExtraFound = false;
let plexInstalled = false;
let plexInstallKick = 0;
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

function appsList(): AppManifest[] {
  if (plexInstallKick && Date.now() - plexInstallKick > 4000) {
    plexInstalled = true;
    plexInstallKick = 0;
  }
  const apps = data.BASE_APPS.map((a) =>
    a.id === "plex" ? { ...a, installed: plexInstalled, installing: plexInstallKick > 0 } : { ...a },
  );
  if (jellyfinInstalled) apps.push({ ...data.JELLYFIN_APP, configured: jellyfinUrl !== "" });
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
    const p = body.parental as { pin?: string; lockedGroups?: string[] };
    if (p.pin !== undefined) {
      parentalPin = p.pin;
      config.parental.pinSet = p.pin !== "";
    }
    if (p.lockedGroups) config.parental.lockedGroups = p.lockedGroups;
  }
  if (body.ambient && typeof body.ambient === "object") Object.assign(config.ambient, body.ambient);
  if (body.update && typeof body.update === "object") Object.assign(config.update, body.update);
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
    case "/tvbox/api/apps/install":
      plexInstallKick = Date.now();
      return ok;
    case "/tvbox/api/apps/remove":
      if (b.id === "plex") plexInstalled = false;
      return ok;
    case "/tvbox/api/store/list":
      return {
        registry: "github.com/Andy1210/tvbox · registry/",
        apps: data.STORE_ENTRIES.map((e) =>
          e.id === "jellyfin" ? { ...e, installed: jellyfinInstalled, baseUrl: jellyfinUrl } : { ...e },
        ),
        error: null,
        updates: [],
      };
    case "/tvbox/api/store/install":
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
  }
  return undefined;
}
