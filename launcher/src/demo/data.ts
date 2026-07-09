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
import type { StoreEntry } from "../lib/api";

// ---- app tiles (visuals copied from the real first-party manifests) ----

export const BASE_APPS: AppManifest[] = [
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
    id: "spotify",
    name: "Spotify",
    tagline: { hu: "Zene", en: "Music" },
    type: "webclient",
    status: "ready",
    accent: "#1DB954",
    icon: "<svg viewBox='0 0 496 512'><path fill='#1ed760' d='M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8Z'/><path d='M406.6 231.1c-5.2 0-8.4-1.3-12.9-3.9-71.2-42.5-198.5-52.7-280.9-29.7-3.6 1-8.1 2.6-12.9 2.6-13.2 0-23.3-10.3-23.3-23.6 0-13.6 8.4-21.3 17.4-23.9 35.2-10.3 74.6-15.2 117.5-15.2 73 0 149.5 15.2 205.4 47.8 7.8 4.5 12.9 10.7 12.9 22.6 0 13.6-11 23.3-23.2 23.3zm-31 76.2c-5.2 0-8.7-2.3-12.3-4.2-62.5-37-155.7-51.9-238.6-29.4-4.8 1.3-7.4 2.6-11.9 2.6-10.7 0-19.4-8.7-19.4-19.4s5.2-17.8 15.5-20.7c27.8-7.8 56.2-13.6 97.8-13.6 64.9 0 127.6 16.1 177 45.5 8.1 4.8 11.3 11 11.3 19.7-.1 10.8-8.5 19.5-19.4 19.5zm-26.9 65.6c-4.2 0-6.8-1.3-10.7-3.6-62.4-37.6-135-39.2-206.7-24.5-3.9 1-9 2.6-11.9 2.6-9.7 0-15.8-7.7-15.8-15.8 0-10.3 6.1-15.2 13.6-16.8 81.9-18.1 165.6-16.5 237 26.2 6.1 3.9 9.7 7.4 9.7 16.5s-7.1 15.4-15.2 15.4z'/></svg>",
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
    id: "plex",
    name: "Plex",
    tagline: { hu: "Filmek és sorozatok", en: "Movies & TV shows" },
    type: "webclient",
    status: "ready",
    accent: "#e5a00d",
    icon: "<svg viewBox='0 0 512 512'><rect width='512' height='512' rx='15%' fill='#282a2d'/><path d='m256 70h-108l108 186-108 186h108l108-186z' fill='#e5a00d'/></svg>",
  },
];

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
  parental: { pinSet: false, lockedGroups: [] },
  spotify: { deviceName: "tvbox demo", hasCredentials: true, enabled: true },
  ambient: { enabled: true, idleMinutes: 5, city: "Budapest" },
  update: { auto: true },
  remote: { devices: {}, power: "tv" },
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
  { mac: "F4:73:35:8A:11:02", name: "Living Room Speaker", type: "audio", paired: true, connected: true },
  { mac: "DC:2C:26:0F:44:9B", name: "TV Keyboard", type: "keyboard", paired: true, connected: false },
  { mac: "A8:9C:ED:71:23:D4", name: "Demo Phone", type: "phone", paired: false, connected: false },
];

export const BT_SCAN_EXTRA: BtDevice = {
  mac: "5C:EB:68:C2:70:1E",
  name: "Kitchen Soundbar",
  type: "audio",
  paired: false,
  connected: false,
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
    icon: BASE_APPS[0].icon,
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
    icon: BASE_APPS[1].icon,
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
    icon: BASE_APPS[2].icon,
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
    icon: BASE_APPS[3].icon,
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
