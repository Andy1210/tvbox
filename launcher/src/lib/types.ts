// A localizable value: either a plain string (e.g. a brand name like "Plex")
// or a per-locale map (e.g. { hu: "Élő TV", en: "Live TV" }).
export type LocaleString = string | Record<string, string>;

export type AppStatus = "ready" | "coming_soon";
// webclient: a self-contained package the shell serves (there are no builtin views).
// native: the app is its own fullscreen window, spawned by the shell (RetroArch).
export type AppType = "webclient" | "native";

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
  running?: boolean; // a live (possibly hidden) window exists - background apps; resume is instant
  foreground?: boolean; // it's the currently visible app (never true while HOME is showing)
  // "Do this from your phone" actions the app declares (QR + code, served by the
  // app's own plugin). The launcher only starts the session and shows the label.
  pairing?: { kind: string; label: LocaleString }[];
  // On/off settings the app declares, with the value in force. Same reason as
  // `pairing`: an app whose screen is not ours (a native app, or a remote site like
  // YouTube's TV page) has nowhere else to put one. `on` comes from the box.
  // `available` is false when the app's plugin is not loaded (a missing dependency, a
  // factory that threw): the switch is still listed - hiding it leaves somebody
  // following release notes with no trace of a setting that should exist - but a press
  // would write config and change nothing.
  switches?: { key: string; label: LocaleString; hint?: LocaleString; on: boolean; available?: boolean }[];
}
