// A localizable value: either a plain string (e.g. a brand name like "Plex")
// or a per-locale map (e.g. { hu: "Élő TV", en: "Live TV" }).
export type LocaleString = string | Record<string, string>;

export type AppStatus = "ready" | "coming_soon";
export type AppType = "webclient"; // apps are self-contained packages the shell serves; no builtin views

// The subset of an app manifest the launcher needs to render a tile. The shell
// exposes this via GET /tvbox/api/apps (the full manifest also carries install
// recipe + runtime, which only the shell consumes).
export interface AppManifest {
  id: string;
  name: LocaleString;
  tagline?: LocaleString;
  type: AppType;
  status: AppStatus;
  accent?: string; // hex color (shell drops anything else); tiles fall back to neutral
  icon: string; // inline SVG markup (declared in the app's manifest)
  depsOk?: boolean; // false when a required binary is missing (shell-resolved)
  missing?: string[]; // the missing binaries, for a "needs X" label
  depsInstallable?: boolean; // every missing binary is a no-root download dep -> installable from the UI (no CLI)
  installable?: boolean; // has a bundle install recipe provisionable from the UI (e.g. Plex flatpak)
  installed?: boolean; // its bundle is present (only meaningful when installable)
  installing?: boolean; // an on-demand install is currently running
  configured?: boolean; // false when a config-driven remote app has no URL yet (e.g. Home Assistant)
  ready?: boolean; // launchable: installed + depsOk + configured, not installing. Only ready apps belong on HOME. Absent on dev/demo/fallback apps (which still show).
  progress?: { phase: string } | null; // install phase while installing (deps | bundle | finishing), null otherwise
}
