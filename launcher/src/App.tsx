import { installNavSounds, setSoundsEnabled } from "./lib/sounds";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n, useLocaleStore } from "./lib/i18n";
import { useConfigStore } from "./stores/config";
import { useNavStore } from "./stores/nav";
import { Backdrop } from "./components/Backdrop";
import { Home } from "./components/Home";
import { SetupWizard, markSetupDone } from "./components/SetupWizard";
import { markSetupDoneOnBox } from "./lib/api";
import { Settings } from "./settings/Settings";
import { Catalog } from "./components/Catalog";
import { Ambient } from "./components/Ambient";
import { TypingOverlay } from "./components/TypingOverlay";
import { MirrorOverlay } from "./components/MirrorOverlay";
import { NotificationToast } from "./components/NotificationToast";
import { InstallWatcher } from "./components/InstallWatcher";
import { RestoreWatcher } from "./components/RestoreWatcher";
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
  // null = not decided yet (the box has not answered), which renders nothing rather
  // than flashing onboarding at someone who already set this box up.
  const [setupDone, setSetupDone] = useState<boolean | null>(() => {
    try {
      if (localStorage.getItem("tvbox.setup.done") === "1") return true;
      if (useLocaleStore.getState().locale) {
        markSetupDone();
        return true;
      }
    } catch {
      /* no storage at all: ask the box, same as an empty one */
    }
    return null;
  });
  const config = useConfigStore((s) => s.config);
  const configError = useConfigStore((s) => s.error);
  const loadConfig = useConfigStore((s) => s.load);

  // Fire TV-style navigation ticks (WebAudio, app-sdk/src/sounds.ts). The listener is
  // permanent; the config toggle only flips the enabled flag.
  useEffect(() => installNavSounds(), []);
  useEffect(() => {
    setSoundsEnabled(config?.ui.navSounds ?? true);
  }, [config?.ui.navSounds]);
  const view = useNavStore((s) => s.view);
  const home = useNavStore((s) => s.home);

  // Ambient/screensaver: only on Home, only when enabled - suppressed elsewhere so
  // it never covers playback or an app view. Hooks run before any early return.
  //
  // A typing session counts as elsewhere without changing the view, and nothing it
  // does reaches this window, so an idle Home is exactly what the timer sees while
  // the user types. The overlay reports it (see TypingOverlay).
  const ambientEnabled = config?.ambient.enabled ?? false;
  const [typing, setTyping] = useState(false);
  const [mirroring, setMirroring] = useState(false);
  // An app asked for the screensaver over itself (see the nav handler below).
  // Kept apart from `idle`, because this one did not come from a timer here and
  // dismissing it goes somewhere else: back to the app that asked.
  //
  // Dropped when this window goes away, which is what an app coming forward does
  // to it (the shell keeps exactly one visible toplevel and says nothing to us
  // about it). Left set, the screensaver would keep running its clock, its photo
  // fetches and its sleep timer behind whatever is on screen. `idle` has the same
  // edge, inside useIdle.
  const [askedAmbient, setAskedAmbient] = useState(false);
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) setAskedAmbient(false);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const [idle, wake] = useIdle(
    (config?.ambient.idleMinutes ?? 5) * 60000,
    view !== "home" || !ambientEnabled || typing || mirroring,
  );
  // The nav subscription below is set up once and must not be torn down and
  // rebuilt on every render just to reach the current `wake`.
  const wakeNow = useRef(wake);
  wakeNow.current = wake;

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Our own store said nothing, so ask the BOX. This store is not always the truth:
  // an Electron instance that lost Chromium's storage lock reads an empty
  // localStorage, and a configured box was then walked through onboarding again -
  // and could not save the answer either. The box remembers instead (config.setup),
  // and a box that already knows is told once, so existing boxes carry over.
  useEffect(() => {
    if (setupDone !== null || !config) return;
    const done = !!config.setup?.done;
    if (done) markSetupDone();
    setSetupDone(done);
  }, [config, setupDone]);
  useEffect(() => {
    if (setupDone === true && config && !config.setup?.done) markSetupDoneOnBox();
  }, [setupDone, config]);

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
    // "typing" and "mirroring" are their overlays' business (they open over
    // whatever is on screen); everything else is a view switch.
    return window.tvbox?.onNav?.((n) => {
      if (n.dest === "typing" || n.dest === "mirroring") return;
      // An app on screen asked for the screensaver (its own screen had nothing to
      // show). The shell has already brought this window forward and remembers
      // where to go back to; the timer cannot be waited for, because it never ran
      // while this window was hidden.
      if (n.dest === "ambient") {
        nav.home();
        setAskedAmbient(true);
        return;
      }
      // Any other destination is somebody asking for a screen, so the screensaver
      // gets out of the way rather than sitting over it - either kind. The remote's
      // Home key arrives as one of these and nothing else was taking it: the
      // preload turns it into a nav event before the page sees a key, so the
      // screensaver's own first-key handler never fired and Home left it up.
      setAskedAmbient(false);
      wakeNow.current();
      if (n.dest === "settings") nav.open("settings");
      else nav.home();
    });
  }, []);

  // Apps now open as shell windows (webclient), not in-launcher views - the
  // launcher only renders Home/Settings/Catalog/Ambient. The
  // notification overlay is mounted alongside every view, so it can appear on top
  // of anything (Home, Settings, the ambient screen).
  let content: ReactNode;
  if (setupDone === false) content = <SetupWizard onDone={() => setSetupDone(true)} />;
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
          className="mt-[2vh] px-[3vw] py-[2vh] rounded-[1.4vh] bg-white/10 text-[2.4vh] font-semibold focus:outline-none focus:bg-white focus:text-[#06090d]"
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
        {(idle || askedAmbient) && ambientEnabled && (
          <Ambient
            onExit={() => {
              wake();
              if (!askedAmbient) return;
              setAskedAmbient(false);
              // Straight back to the app that asked, rather than leaving the
              // person on a Home screen they never navigated to. A no-op in the
              // shell if it has since sent the screen somewhere else.
              window.tvbox?.ambient?.done?.();
            }}
          />
        )}
      </ScreenTransition>
    );

  return (
    <>
      <Backdrop />
      {/* While a phone is on screen the launcher draws nothing of its own. Making
          the window transparent is not enough on its own - the view underneath
          keeps rendering, and Home's tiles ended up printed over someone's phone.
          The overlay below is the whole UI for the duration. */}
      {mirroring ? null : content}
      <NotificationToast />
      <TypingOverlay onActiveChange={setTyping} />
      <MirrorOverlay onActiveChange={setMirroring} />
      <InstallWatcher />
      <RestoreWatcher />
    </>
  );
}
