// Demo-build fixtures (vite --mode demo): everything the shell serves on a real
// box is synthesized here - the Home app tiles, the App Store / Catalog list
// with changelogs, and the Settings data. All artwork is inline SVG, so the
// demo makes zero network requests. Launcher code is untouched; it talks to
// these through demo/routes.ts.
import type { AppManifest } from "../lib/types";
import type { WifiNet, WifiStatus } from "../lib/wifi";
import type { BtDevice } from "../lib/bluetooth";
import type { AudioState } from "../lib/audio";
import type { DisplayInfo } from "../lib/display";
import type { SystemInfo } from "../lib/system";
import type { RegionInfo } from "../lib/region";
import type { UpdateStatus } from "../lib/update";
import type { PublicConfig } from "../lib/config";
import { FALLBACK_APPS, type StoreEntry } from "../lib/api";

// ---- app tiles ----
// The four first-party base apps are the SAME set the prod launcher falls back
// to when the shell is unreachable, so re-export that single source (defined in
// lib/api.ts) rather than a parallel copy that silently drifts. demo -> lib is
// the safe import direction; nothing here is pulled into the prod bundle.
export const BASE_APPS = FALLBACK_APPS;

// Icon for a base app by id - order-independent, since BASE_APPS mirrors the
// prod fallback order, not the store's.
const appIcon = (id: string): string => BASE_APPS.find((a) => a.id === id)?.icon ?? "";

export const JELLYFIN_APP: AppManifest = {
  id: "jellyfin",
  name: "Jellyfin",
  tagline: { hu: "Filmek és sorozatok a saját szerveredről", en: "Movies & TV from your own server" },
  type: "webclient",
  status: "ready",
  accent: "#00a4dc",
  icon: "<svg viewBox='0 0 24 24'><rect width='24' height='24' rx='4' fill='#101010'/><path d='M12 6.5c-1.2 0-4.9 6.7-4.3 7.8.6 1.1 8 1.1 8.6 0 .6-1.1-3.1-7.8-4.3-7.8zm0 2.9c.5 0 2 2.7 1.8 3.2-.3.5-3.3.5-3.6 0-.2-.5 1.3-3.2 1.8-3.2z' fill='#00a4dc'/><path d='M12 3.2C9.8 3.2 3.2 15 4.3 17c.4.7 2.1 1 4.1 1.1-.7-.3-1.2-.6-1.4-1-.9-1.6 3.3-9.6 5-9.6s5.9 8 5 9.6c-.2.4-.7.7-1.4 1 2-.1 3.7-.4 4.1-1.1 1.1-2-5.5-13.8-7.7-13.8z' fill='#00a4dc' opacity='.55'/></svg>",
};

// ---- Settings data ----

export const CONFIG: PublicConfig = {
  iptv: {
    mode: "m3u",
    xtream: null,
    m3u: { url: "https://demo.tvbox.invalid/playlist.m3u", epgUrl: "https://demo.tvbox.invalid/xmltv.xml" },
    configured: true,
  },
  parental: { pinSet: false, lockedGroups: [], requirePin: false },
  spotify: { deviceName: "tvbox demo", hasCredentials: true, enabled: true },
  ambient: { enabled: true, idleMinutes: 5, city: "Budapest", sleepMinutes: 0, bing: false },
  update: { auto: true, appsAuto: true },
  ui: { hourFormat: "auto", navSounds: true },
  wifi: { country: "" },
  player: { audioLang: "", subLang: "" },
  remote: { devices: {}, power: "tv" },
  mqtt: {
    configured: true,
    host: "homeassistant.local",
    port: null,
    username: "tvbox",
    hasPassword: true,
    deviceId: "tvbox-demo",
  },
};

export const WIFI_STATUS: WifiStatus = {
  connected: true,
  ssid: "tvbox-demo",
  ethernet: { connected: false, ip: "" },
};

export const WIFI_NETWORKS: WifiNet[] = [
  { ssid: "tvbox-demo", signal: 86, secured: true, active: true },
  { ssid: "Landing Zone 5G", signal: 71, secured: true, active: false },
  { ssid: "Cafe Guest", signal: 54, secured: false, active: false },
  { ssid: "IoT-2.4", signal: 38, secured: true, active: false },
];

export const BT_DEVICES: BtDevice[] = [
  {
    mac: "F4:73:35:8A:11:02",
    name: "Living Room Speaker",
    type: "audio",
    paired: true,
    connected: true,
    battery: null,
  },
  { mac: "DC:2C:26:0F:44:9B", name: "TV Keyboard", type: "keyboard", paired: true, connected: false, battery: 72 },
  { mac: "A8:9C:ED:71:23:D4", name: "Demo Phone", type: "phone", paired: false, connected: false, battery: null },
];

export const BT_SCAN_EXTRA: BtDevice = {
  mac: "5C:EB:68:C2:70:1E",
  name: "Kitchen Soundbar",
  type: "audio",
  paired: false,
  connected: false,
  battery: null,
};

export const AUDIO: AudioState = {
  sinks: [
    {
      id: 51,
      name: "alsa_output.platform-fef05700.hdmi.hdmi-stereo",
      description: "HDMI / TV",
      isDefault: true,
      volume: 0.8,
      muted: false,
    },
    {
      id: 74,
      name: "bluez_output.F4_73_35_8A_11_02.1",
      description: "Living Room Speaker",
      isDefault: false,
      volume: 0.65,
      muted: false,
    },
  ],
  override: null,
};

export const DISPLAY: DisplayInfo = {
  output: "HDMI-A-1",
  modes: [
    { key: "3840x2160@60", width: 3840, height: 2160, refresh: 60, current: false, preferred: true },
    { key: "3840x2160@50", width: 3840, height: 2160, refresh: 50, current: false, preferred: false },
    { key: "3840x2160@30", width: 3840, height: 2160, refresh: 30, current: false, preferred: false },
    { key: "1920x1080@60", width: 1920, height: 1080, refresh: 60, current: true, preferred: false },
    { key: "1920x1080@50", width: 1920, height: 1080, refresh: 50, current: false, preferred: false },
    { key: "1280x720@60", width: 1280, height: 720, refresh: 60, current: false, preferred: false },
  ],
  saved: null,
  matchFramerate: true,
};

export const SYSTEM_INFO: SystemInfo = {
  version: "1.1.3",
  hostname: "tvbox-demo",
  model: "Raspberry Pi 5 Model B Rev 1.0",
  ip: "192.168.1.50",
  uptimeSec: 5 * 24 * 3600 + 7 * 3600,
  cpuTempC: 47.8,
  mem: { totalKb: 8244768, availableKb: 6083112 },
  disk: { freeBytes: 21.4e9, totalBytes: 31.1e9 },
  wifi: { ssid: "tvbox-demo", signal: 86 },
};

export const UPDATE_STATUS: UpdateStatus = {
  current: "1.1.3",
  release: "versions/1.1.3",
  state: "idle",
  error: null,
  latest: { version: "1.1.3", notes: null },
  available: false,
  lastCheckAt: null,
  auto: true,
  failed: null,
  last: { from: "1.1.2", to: "1.1.3", at: Date.now() - 3 * 24 * 3600 * 1000 },
  os: { rebootRequired: false, packages: [] },
};

const V = { version: "1.0.0", installedVersion: "1.0.0", updateAvailable: false, installing: false, progress: null };
export const STORE_ENTRIES: StoreEntry[] = [
  {
    id: "livetv",
    name: { hu: "Élő TV", en: "Live TV" },
    tagline: { hu: "IPTV csatornák", en: "IPTV channels" },
    icon: appIcon("livetv"),
    accent: "#39c0d6",
    installed: true,
    builtin: true,
    ...V,
    urlConfig: null,
    baseUrl: "",
    missing: [],
    changelog: [],
  },
  {
    id: "spotify",
    name: "Spotify",
    tagline: { hu: "Zene", en: "Music" },
    icon: appIcon("spotify"),
    accent: "#1DB954",
    installed: true,
    builtin: true,
    ...V,
    urlConfig: null,
    baseUrl: "",
    missing: [],
    changelog: [
      {
        version: "1.0.0",
        notes:
          "Spotify Connect playback with a full-screen now-playing view.\nSynced lyrics and album artwork on the TV.",
      },
      { version: "0.9.0", notes: "Initial release: browse your playlists and liked songs." },
    ],
  },
  {
    id: "youtube",
    name: "YouTube",
    tagline: { hu: "Videók", en: "Videos" },
    icon: appIcon("youtube"),
    accent: "#ff0033",
    installed: true,
    builtin: true,
    ...V,
    urlConfig: null,
    baseUrl: "",
    missing: [],
    changelog: [],
  },
  {
    id: "plex",
    name: "Plex",
    tagline: { hu: "Filmek és sorozatok", en: "Movies & TV shows" },
    icon: appIcon("plex"),
    accent: "#e5a00d",
    installed: true,
    builtin: true,
    ...V,
    urlConfig: null,
    baseUrl: "",
    missing: [],
    changelog: [{ version: "1.0.0", notes: "Direct-play movies and TV shows from your Plex server." }],
  },
  {
    id: "jellyfin",
    name: "Jellyfin",
    tagline: { hu: "Filmek és sorozatok a saját szerveredről", en: "Movies & TV from your own server" },
    icon: JELLYFIN_APP.icon,
    accent: "#00a4dc",
    installed: false,
    builtin: false,
    version: "1.0.0",
    installedVersion: null,
    updateAvailable: false,
    installing: false,
    progress: null,
    urlConfig: "jellyfin",
    baseUrl: "",
    missing: [],
    changelog: [
      {
        version: "1.0.0",
        notes: "Connect to your own Jellyfin server.\nResume playback and browse libraries with the remote.",
      },
      { version: "0.8.0", notes: "Beta: login and basic library browsing." },
    ],
  },
];

export const WEATHER = { city: "Budapest", tempC: 27, code: 1 };

// Region/keyboard fixtures for the first-boot wizard + Settings -> General. A
// representative subset (the real box exposes ~485 zones / ~99 keymaps) that
// still spans several regions incl. a sub-region ("America/Argentina/...") and a
// slash-less zone ("UTC") so the drill-down is fully exercisable in the demo.
export const REGION: RegionInfo = {
  timezone: "Europe/Budapest",
  keymap: "hu",
  timezones: [
    "UTC",
    "Europe/Budapest",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Europe/Madrid",
    "Europe/Rome",
    "Europe/Vienna",
    "Europe/Warsaw",
    "Europe/Prague",
    "Europe/Bucharest",
    "Europe/Athens",
    "Europe/Moscow",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Toronto",
    "America/Mexico_City",
    "America/Sao_Paulo",
    "America/Argentina/Buenos_Aires",
    "America/Argentina/Cordoba",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "Asia/Hong_Kong",
    "Asia/Singapore",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Asia/Jerusalem",
    "Africa/Cairo",
    "Africa/Lagos",
    "Africa/Johannesburg",
    "Australia/Sydney",
    "Australia/Perth",
    "Pacific/Auckland",
    "Pacific/Honolulu",
  ],
  keymaps: [
    "gb",
    "us",
    "hu",
    "de",
    "fr",
    "es",
    "it",
    "pt",
    "br",
    "nl",
    "pl",
    "cz",
    "sk",
    "ro",
    "hr",
    "rs",
    "ru",
    "ua",
    "gr",
    "tr",
    "se",
    "no",
    "dk",
    "fi",
    "ch",
    "be",
    "jp",
    "kr",
    "dvorak",
    "colemak",
  ],
};
