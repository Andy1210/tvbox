import { useEffect, useState, type ReactNode } from "react";
import { useI18n, useLocaleStore } from "./lib/i18n";
import { useConfigStore } from "./stores/config";
import { installNavSounds, setSoundsEnabled } from "./lib/sounds";
import { useNavStore } from "./stores/nav";
import { Backdrop } from "./components/Backdrop";
import { Home } from "./components/Home";
import { SetupWizard, markSetupDone } from "./components/SetupWizard";
import { Settings } from "./components/Settings";
import { Catalog } from "./components/Catalog";
import { Ambient } from "./components/Ambient";
import { NotificationToast } from "./components/NotificationToast";
import { InstallWatcher } from "./components/InstallWatcher";
import { useIdle } from "./lib/useIdle";
import { useEntryAnim } from "./lib/useEntryAnim";
import { applyPendingRestore } from "./lib/backup";

// Entry transition for the main screen swaps (Home/Settings/Catalog): App keys
// this per view, so a swap remounts it and replays the ~150ms fade (mount-only;
// re-renders inside a view don't animate). Plain full-height wrapper - the
// views size themselves with h-full. The Ambient screensaver mounts later as a
// child, by which point the wrapper is transform-free (see useEntryAnim), so
// its fixed positioning and its own crossfade are unaffected.
function ScreenTransition({ children }: { children: ReactNode }) {
  const entryAnim = useEntryAnim();
  return (
    <div className="h-full" style={entryAnim}>
      {children}
    </div>
  );
}

// First launch: language picker (no locale) -> HOME. Apps are packages
// installed from the store (Kodi model), so a fresh box goes straight to an
// empty HOME + "Get more apps" - there is no built-in app (Live TV/IPTV)
// onboarding anymore; each app does its own setup once installed. State comes
// from stores (i18n, config, nav).
export function App() {
  const { t } = useI18n();
  // First-boot gate: show the setup wizard until setup is marked complete
  // (persisted flag). MIGRATION - an already-configured box (a locale was
  // chosen before the wizard existed) has no flag yet, so on first mount we
  // set it and skip the wizard; only a truly fresh box (no locale, no flag)
  // starts at the wizard's language step.
  const [setupDone, setSetupDone] = useState<boolean>(() => {
    try {
      if (localStorage.getItem("tvbox.setup.done") === "1") return true;
      if (useLocaleStore.getState().locale) {
        markSetupDone();
        return true;
      }
    } catch {
      /* no storage: treat as fresh - the wizard is harmless and fully skippable */
    }
    return false;
  });
  const config = useConfigStore((s) => s.config);
  const configError = useConfigStore((s) => s.error);
  const loadConfig = useConfigStore((s) => s.load);

  // Fire TV-style navigation ticks (WebAudio, lib/sounds.ts). The listener is
  // permanent; the config toggle only flips the enabled flag.
  useEffect(() => installNavSounds(), []);
  useEffect(() => {
    setSoundsEnabled(config?.ui.navSounds ?? true);
  }, [config?.ui.navSounds]);
  const view = useNavStore((s) => s.view);
  const home = useNavStore((s) => s.home);

  // Ambient/screensaver: only on Home, only when enabled - suppressed elsewhere so
  // it never covers playback or an app view. Hooks run before any early return.
  const ambientEnabled = config?.ambient.enabled ?? false;
  const [idle, wake] = useIdle((config?.ambient.idleMinutes ?? 5) * 60000, view !== "home" || !ambientEnabled);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // A settings restore (backup) parked the previous box's launcher storage
  // shell-side; apply it once and reload so locale/app-order/onboarding state
  // survive a restore or re-flash. No-op (single cheap fetch) otherwise.
  useEffect(() => {
    applyPendingRestore();
  }, []);

  // A remapped Settings button on a remote (/tvbox/api/nav). Two delivery paths:
  // the #settings hash when the shell (re)loads the launcher out of an app, and
  // the onNav shell event while the launcher is already up (no reload).
  useEffect(() => {
    const nav = useNavStore.getState();
    if (window.location.hash === "#settings") {
      history.replaceState(null, "", window.location.pathname); // one-shot: a manual reload lands on Home
      nav.open("settings");
    }
    return window.tvbox?.onNav?.((n) => (n.dest === "settings" ? nav.open("settings") : nav.home()));
  }, []);

  // Apps now open as shell windows (webclient), not in-launcher views - the
  // launcher only renders Home/Settings/Catalog/Ambient. The
  // notification overlay is mounted alongside every view, so it can appear on top
  // of anything (Home, Settings, the ambient screen).
  let content: ReactNode;
  if (!setupDone) content = <SetupWizard onDone={() => setSetupDone(true)} />;
  else if (config === null && configError) {
    // The shell API didn't answer - a transient hiccup must NOT look like a
    // factory-fresh box (it would drop the user into onboarding). Offer retry.
    content = (
      <div className="h-full flex flex-col items-center justify-center gap-[2vh] px-[8vw] text-center">
        <div className="text-[3.4vh] font-bold">{t("app.shellUnreachable")}</div>
        <div className="text-[2vh] text-fg-dim max-w-[60vw]">{t("app.shellUnreachableHint")}</div>
        <button
          autoFocus
          onClick={() => loadConfig()}
          className="mt-[2vh] px-[3vw] py-[2vh] rounded-[1.4vh] bg-white/10 text-[2.4vh] font-semibold transition-[background-color,color] duration-150 focus:outline-none focus:bg-white focus:text-[#06090d]"
        >
          {t("app.retry")}
        </button>
      </div>
    );
  } else if (config === null)
    content = null; // config loading (brief)
  else if (view === "settings")
    content = (
      <ScreenTransition key="settings">
        <Settings onExit={home} />
      </ScreenTransition>
    );
  else if (view === "catalog")
    content = (
      <ScreenTransition key="catalog">
        <Catalog onExit={home} />
      </ScreenTransition>
    );
  else
    content = (
      <ScreenTransition key="home">
        <Home />
        {idle && ambientEnabled && <Ambient onExit={wake} />}
      </ScreenTransition>
    );

  return (
    <>
      <Backdrop />
      {content}
      <NotificationToast />
      <InstallWatcher />
    </>
  );
}
