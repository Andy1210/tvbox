// Demo stand-in for the Electron shell bridge (shell/preload.js): implements
// the shell-only slice of window.tvbox. There is no in-launcher app view left
// to drive a player, so launches (Home tiles) just surface a toast via the
// launcher's own notification overlay instead of opening a window.
import type { TvNotification, TvboxBridge } from "../lib/shell";
import { localize, useLocaleStore } from "../lib/i18n";
import { BASE_APPS, JELLYFIN_APP } from "./data";

const notifyCbs = new Set<(n: TvNotification) => void>();
const commandCbs = new Set<(cmd: { action: string; app?: string }) => void>();

export function notifyAll(n: TvNotification): void {
  for (const cb of notifyCbs) cb(n);
}

export const demoLocale = (): string => useLocaleStore.getState().locale ?? "en";

// ---- bridge ----

const LAUNCH_MSG: Record<string, string> = {
  en: "{name} opens on a real box - this demo runs entirely in your browser.",
  hu: "A(z) {name} a valódi eszközön nyílik meg - ez a demó teljes egészében a böngésződben fut.",
};

function launchNotice(appId: string): void {
  const app = [...BASE_APPS, JELLYFIN_APP].find((a) => a.id === appId);
  const name = app ? localize(app.name, demoLocale()) : appId;
  const msg = (LAUNCH_MSG[demoLocale()] ?? LAUNCH_MSG.en).replace("{name}", name);
  notifyAll({ title: "tvbox demo", message: msg, duration: 4000 });
}

export function installBridge(): void {
  const bridge: TvboxBridge = {
    launch: launchNotice,
    home: () => {},
    onNotify: (cb) => {
      notifyCbs.add(cb);
      return () => notifyCbs.delete(cb);
    },
    onCommand: (cb) => {
      commandCbs.add(cb);
      return () => commandCbs.delete(cb);
    },
  };
  window.tvbox = bridge;
}
