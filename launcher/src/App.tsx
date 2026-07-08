import { useEffect, type ReactNode } from "react";
import { useI18n } from "./lib/i18n";
import { useConfigStore } from "./stores/config";
import { useNavStore } from "./stores/nav";
import { Backdrop } from "./components/Backdrop";
import { Home } from "./components/Home";
import { SetupScreen } from "./components/SetupScreen";
import { Settings } from "./components/Settings";
import { Catalog } from "./components/Catalog";
import { Ambient } from "./components/Ambient";
import { NotificationToast } from "./components/NotificationToast";
import { InstallWatcher } from "./components/InstallWatcher";
import { useIdle } from "./lib/useIdle";
import { applyPendingRestore } from "./lib/backup";

// First launch: language picker (no locale) -> HOME. Apps are packages
// installed from the store (Kodi model), so a fresh box goes straight to an
// empty HOME + "Get more apps" - there is no built-in app (Live TV/IPTV)
// onboarding anymore; each app does its own setup once installed. State comes
// from stores (i18n, config, nav).
export function App() {
  const { locale, t } = useI18n();
  const config = useConfigStore((s) => s.config);
  const configError = useConfigStore((s) => s.error);
  const loadConfig = useConfigStore((s) => s.load);
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

  // Apps now open as shell windows (webclient), not in-launcher views - the
  // launcher only renders Home/Settings/Catalog/Ambient. The
  // notification overlay is mounted alongside every view, so it can appear on top
  // of anything (Home, Settings, the ambient screen).
  let content: ReactNode;
  if (!locale) content = <SetupScreen />;
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
          className="mt-[2vh] px-[3vw] py-[2vh] rounded-[1.4vh] bg-white/10 text-[2.4vh] font-semibold focus:outline focus:outline-[3px] focus:outline-[var(--color-focus)]"
        >
          {t("app.retry")}
        </button>
      </div>
    );
  } else if (config === null)
    content = null; // config loading (brief)
  else if (view === "settings") content = <Settings onExit={home} />;
  else if (view === "catalog") content = <Catalog onExit={home} />;
  else
    content = (
      <>
        <Home />
        {idle && ambientEnabled && <Ambient onExit={wake} />}
      </>
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
