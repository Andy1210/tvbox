import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FocusContext, doesFocusableExist, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import type { AppManifest } from "../lib/types";
import { fetchApps, quitApp } from "../lib/api";
import { launchApp } from "../lib/shell";
import { fetchWidgets, subscribeWidgets, type HomeWidget } from "../lib/widgets";
import { Icon } from "./Icon";
import { useI18n } from "../lib/i18n";
import { useNavStore } from "../stores/nav";
import { enteredIn, homeRowEnd, homeRowTarget, rememberRow, type HomeRow } from "../lib/homeNav";
import { useAppPrefsStore, orderIds } from "../stores/appPrefs";
import { Clock } from "./Clock";
import { Tile } from "./Tile";
import { FocusButton } from "./FocusButton";
import { PowerMenu } from "./PowerMenu";

// A synthetic HOME tile that opens the app catalog ("Get more apps"). Not a real
// app - onSelect routes its id to the catalog view. Hideable via Settings → Apps.
const GET_MORE_ID = "__getmore";

/**
 * The focus keys HOME builds out of app ids, and the one thing they must not do.
 *
 * An app id is only constrained to `[a-z0-9_-]` and nothing is reserved, so
 * `run-plex`, `home-settings` and `home-rail` are all legal ids - and a tile
 * used to be keyed by the id alone, mounting last and overwriting whichever key
 * it collided with. A press aimed BY NAME then acted on the wrong thing.
 * The colon is what closes it: no id can contain one.
 */
const tileKey = (id: string): string => `tile:${id}`;
/**
 * The catalog tile's own key, which is NOT built from its id.
 *
 * `__getmore` is a legal app id, so a manifest calling itself that would give
 * two tiles one key - the collision this whole naming exists to close, through
 * the one door the id charset cannot shut. The second colon is what no derived
 * key can produce.
 */
const GET_MORE_KEY = "tile::getmore";
const runKey = (id: string): string => `run:${id}`;
const quitKey = (id: string): string => `runx:${id}`;
const widgetKey = (id: string): string => `widget:${id}`;

// Where each row was last left lives in lib/homeNav.ts, outside the component:
// HOME is unmounted while Settings or the catalog is up, and coming back to the
// rail's first app is the same jump this stops inside one visit. Empty on a
// fresh launcher start, so a box that has just booted opens on the first tile.

export function Home() {
  const { t, loc, tag } = useI18n();
  const open = useNavStore((s) => s.open);
  const order = useAppPrefsStore((s) => s.order);
  const hidden = useAppPrefsStore((s) => s.hidden);
  const getMoreHidden = useAppPrefsStore((s) => s.getMoreHidden);
  const [apps, setApps] = useState<AppManifest[]>([]);
  const [loaded, setLoaded] = useState(false); // first app-list fetch has resolved
  const [widgets, setWidgets] = useState<HomeWidget[]>([]);
  const [powerOpen, setPowerOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { ref, focusKey } = useFocusable({ focusKey: "home-rail" });

  // The launcher window stays loaded across app switches now (background apps),
  // so HOME can't rely on a remount for fresh data: refetch when the window
  // becomes visible again (Electron hide/show flips document visibility) - that
  // also keeps the running-apps row honest after a quit/eviction.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchApps().then((list) => {
        if (!alive) return;
        setApps(list);
        setLoaded(true);
      });
    load();
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    // ...and when the box changes the set itself, which visibility cannot catch:
    // an app started hidden at boot happens with this window on screen the whole
    // time, so without this it ran with no row here and no way to quit it.
    const offApps = window.tvbox?.onAppsChanged?.(() => void load()) ?? (() => {});
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVis);
      offApps();
    };
  }, []);

  // plugin-pushed HOME cards (e.g. Spotify now-playing): initial fetch + live push
  useEffect(() => {
    let alive = true;
    fetchWidgets().then((w) => {
      if (alive) setWidgets(w);
    });
    const off = subscribeWidgets(setWidgets);
    return () => {
      alive = false;
      off();
    };
  }, []);

  // apply the user's manual order + hidden set (Settings → Apps); unlisted apps
  // fall back to localized-name order, so a newly installed app appears at the end.
  // HOME shows ONLY launchable apps: the shell marks those `ready` - an app still
  // installing or not yet provisioned is `ready:false` and lives in the store with
  // its progress. `ready` absent (dev/demo/fallback apps) still shows.
  const sorted = useMemo(() => {
    const byId = new Map(apps.map((a) => [a.id, a]));
    const visible = apps.filter((a) => a.ready !== false && !hidden.includes(a.id));
    const byName = (x: string, y: string) => loc(byId.get(x)!.name).localeCompare(loc(byId.get(y)!.name), tag);
    return orderIds(
      visible.map((a) => a.id),
      order,
      byName,
    ).map((id) => byId.get(id)!);
  }, [apps, order, hidden, loc, tag]);

  /** Where a row was left, recorded as the cursor lands on it. */
  const rememberTile = useCallback((id: string) => rememberRow("rail", tileKey(id)), []);

  /**
   * HOME as rows, top to bottom and left to right.
   *
   * Read at press time rather than memoised: a row's remembered key lives
   * outside React, and a stale row list aims a press at a chip whose app has
   * quit.
   */
  const homeRows = useCallback((): HomeRow[] => {
    const tiles = [...sorted.map((a) => tileKey(a.id)), ...(getMoreHidden ? [] : [GET_MORE_KEY])];
    const running = apps.filter((a) => a.running);
    const widgetKeys = widgets.map((w) => widgetKey(w.id));
    return [
      // No name, so no memory: arriving at the header is the settings gear, and
      // the power button - a menu nobody wants to reach by accident - is one
      // press away from it.
      { name: "", keys: ["home-power", "home-settings"], entries: ["home-settings", "home-power"] },
      { name: "widgets", keys: widgetKeys, entries: widgetKeys },
      {
        name: "running",
        keys: running.flatMap((a) => [runKey(a.id), quitKey(a.id)]),
        entries: running.map((a) => runKey(a.id)),
      },
      { name: "rail", keys: tiles, entries: tiles },
    ];
  }, [apps, sorted, widgets, getMoreHidden]);

  /** One HOME focusable's arrows: the row above or below, and the ends of its own row. */
  const arrows = useCallback(
    (from: string) =>
      (dir: string): boolean => {
        if (dir === "left" || dir === "right") {
          const round = homeRowEnd(homeRows(), from, dir, doesFocusableExist);
          // Not an end: geometry moves inside the row, as it always has.
          if (round === undefined) return true;
          // An end with nowhere to go round to is still the row's own press.
          if (round) setFocus(round);
          return false;
        }
        if (dir !== "up" && dir !== "down") return true;
        const target = homeRowTarget(homeRows(), from, dir, doesFocusableExist);
        // Nothing above or below: hand the press back rather than eat it.
        if (!target) return true;
        // Set here, inside the press, rather than a macrotask later: deferring
        // it meant two presses arriving together both resolved from the same
        // row and moved one row between them - measured on a box, 7 times in 10
        // at no gap - and left a window in which the target could unmount with
        // the press already refused, which is a cursor nowhere and a dead
        // remote.
        setFocus(target);
        return false;
      },
    [homeRows],
  );

  // Place focus ONCE, after the first app-list load: the tile the rail was left
  // on, else the first tile, else the "Get more" tile, else the Settings gear.
  // One-shot so a later setApps (the quit handler, or the visibility refetch)
  // can't overwrite an explicitly-set focus - e.g. the quit flow's target.
  // The remembered tile is what makes a trip to Settings and back land where it
  // left rather than at the start of the rail; on a fresh start there is none.
  const didInitialFocus = useRef(false);
  useEffect(() => {
    if (didInitialFocus.current || !loaded) return;
    const rail = sorted.map((a) => tileKey(a.id));
    const held = enteredIn("rail");
    const first =
      held && rail.includes(held) ? held : rail.length ? rail[0] : !getMoreHidden ? GET_MORE_KEY : "home-settings";
    const id = setTimeout(() => {
      setFocus(first);
      didInitialFocus.current = true; // mark done only after focus actually ran (a cleared timer must retry)
    }, 0);
    return () => clearTimeout(id);
  }, [loaded, sorted, getMoreHidden]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // Clear a pending toast timer on unmount so it can't fire setState after the
  // component is gone (cf. InstallWatcher).
  useEffect(() => () => clearTimeout(toastTimer.current ?? undefined), []);

  // Every HOME tile is a ready, launchable app now - installing is entirely the
  // store's job (Settings → Store / the catalog show progress there). So onSelect
  // just launches, with the synthetic "Get more" tile, coming-soon and
  // needs-setup cases still handled.
  const onSelect = useCallback(
    (app: AppManifest) => {
      if (app.id === GET_MORE_ID) {
        open("catalog"); // the "Get more apps" tile -> the app catalog
        return;
      }
      if (app.status !== "ready") {
        showToast(t("home.comingSoon", { name: loc(app.name) }));
        return;
      }
      if (app.configured === false) {
        // a config-driven remote app (e.g. Home Assistant) has no URL yet
        showToast(t("home.setupNeeded", { name: loc(app.name) }));
        open("settings");
        return;
      }
      if (!launchApp(app.id)) showToast(t("home.bridgeMissing")); // every app opens as a shell window
    },
    [showToast, t, loc, open],
  );

  const getMoreTile: AppManifest = {
    id: GET_MORE_ID,
    name: t("home.getMore"),
    type: "webclient",
    status: "ready",
    accent: "#5b6b7f",
    icon: "<svg viewBox='0 0 24 24' fill='none' stroke='#c7d0da' stroke-width='2' stroke-linecap='round'><path d='M12 5v14M5 12h14'/></svg>",
    depsOk: true,
    installed: true,
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col">
        <header className="flex items-start gap-[2vw] px-[4vw] pt-[3.2vh]">
          <div className="flex-1 min-w-0">
            <Clock />
          </div>
          <FocusButton
            focusKey="home-power"
            onEnter={() => setPowerOpen(true)}
            onArrowPress={arrows("home-power")}
            className="shrink-0 w-[6vh] h-[6vh] rounded-full bg-white/5 flex items-center justify-center"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="w-[3vh] h-[3vh]"
            >
              <path d="M12 4v8" />
              <path d="M7.5 7.5a7 7 0 1 0 9 0" />
            </svg>
          </FocusButton>
          <FocusButton
            focusKey="home-settings"
            onEnter={() => open("settings")}
            onArrowPress={arrows("home-settings")}
            className="shrink-0 w-[6vh] h-[6vh] rounded-full bg-white/5 flex items-center justify-center"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-[3vh] h-[3vh]"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </FocusButton>
        </header>
        {powerOpen && (
          <PowerMenu
            onClose={() => {
              setPowerOpen(false);
              setTimeout(() => setFocus("home-power"), 0);
            }}
          />
        )}
        <main className="flex-1 flex flex-col justify-center px-[4vw]">
          {widgets.length > 0 && (
            <div className="flex gap-[1.5vw] mb-[3vh]">
              {widgets.map((w) => {
                const app = apps.find((a) => a.id === w.id);
                if (!app) return null;
                return (
                  <FocusButton
                    key={w.id}
                    focusKey={widgetKey(w.id)}
                    onEnter={() => onSelect(app)}
                    onArrowPress={arrows(widgetKey(w.id))}
                    onFocused={() => rememberRow("widgets", widgetKey(w.id))}
                    className="px-[1.6vw] py-[1.4vh] rounded-[1.4vh] bg-white/5 flex items-center gap-[1.2vw] max-w-[34vw]"
                  >
                    <span
                      className="w-[5vh] h-[5vh] rounded-[1vh] shrink-0 flex items-center justify-center overflow-hidden"
                      style={{ background: app.accent ? app.accent + "22" : undefined }}
                    >
                      <Icon svg={app.icon} className="w-[3.6vh] h-[3.6vh]" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[2vh] font-semibold truncate">{w.title}</span>
                      {w.subtitle && <span className="block text-[1.7vh] text-fg-dim truncate">{w.subtitle}</span>}
                    </span>
                  </FocusButton>
                );
              })}
            </div>
          )}
          {apps.some((a) => a.running) && (
            <div className="mb-[2.6vh]">
              <h1 className="text-[2vh] font-semibold text-fg-dim mb-[1.4vh] tracking-wide">{t("home.running")}</h1>
              {/* One line that scrolls, not a wrapping block. The row model
                  above declares these chips as ONE row, and a second visual
                  line made that claim false: measured with eight apps running,
                  no press reached it at all, because Down from line 1 goes to
                  the rail and Up from line 2 to the header. A box with 8 GB of
                  RAM keeps up to seven windows alive, so that is an ordinary
                  state, not a corner. The focused chip scrolls itself into view
                  the way every other focusable does; the padding pair is the
                  focus ring's room, since overflow-x clips the other axis too. */}
              <div className="flex gap-[1.2vw] flex-nowrap overflow-x-auto no-scrollbar -my-[1vh] py-[1vh] scroll-px-[4vw]">
                {apps
                  .filter((a) => a.running)
                  .map((app) => (
                    <div key={app.id} className="flex items-center gap-[0.5vw]">
                      <FocusButton
                        focusKey={runKey(app.id)}
                        onEnter={() => onSelect(app)}
                        onArrowPress={arrows(runKey(app.id))}
                        onFocused={() => rememberRow("running", runKey(app.id))}
                        className="px-[1.4vw] py-[1.2vh] rounded-l-[1.2vh] rounded-r-[0.3vh] bg-white/5 flex items-center gap-[0.9vw]"
                      >
                        <span
                          className="w-[3.6vh] h-[3.6vh] rounded-[0.8vh] shrink-0 flex items-center justify-center overflow-hidden"
                          style={{ background: app.accent ? app.accent + "22" : undefined }}
                        >
                          <Icon svg={app.icon} className="w-[2.7vh] h-[2.7vh]" />
                        </span>
                        <span className="text-[2vh] font-semibold truncate max-w-[16vw]">{loc(app.name)}</span>
                      </FocusButton>
                      <FocusButton
                        focusKey={quitKey(app.id)}
                        onArrowPress={arrows(quitKey(app.id))}
                        // The CHIP, not this button: a row is never entered at
                        // the control that quits an app.
                        onFocused={() => rememberRow("running", runKey(app.id))}
                        onEnter={() =>
                          quitApp(app.id).then(() =>
                            fetchApps().then((list) => {
                              setApps(list);
                              // the chip we sat on is gone - land somewhere sane
                              const still = list.filter((a) => a.running);
                              const was = apps.filter((a) => a.running).findIndex((x) => x.id === app.id);
                              const rail = sorted.map((a) => tileKey(a.id));
                              const held = enteredIn("rail");
                              setTimeout(() => {
                                // The app that slid into this one's place, or
                                // the one before it at the end of the row: the
                                // cursor stays where the eye is. Aiming at the
                                // FIRST chip snapped a scrolling row back to
                                // its start on the one press this row exists
                                // for. With nothing left running it is the tile
                                // the rail was left on, for the same reason.
                                const next = still[Math.min(Math.max(was, 0), still.length - 1)];
                                if (next) setFocus(runKey(next.id));
                                else if (held && rail.includes(held)) setFocus(held);
                                else if (rail.length) setFocus(rail[0]);
                                else setFocus("home-settings");
                              }, 0);
                            }),
                          )
                        }
                        className="px-[0.9vw] py-[1.2vh] rounded-r-[1.2vh] rounded-l-[0.3vh] bg-white/5 text-[2vh] font-semibold"
                        aria-label={t("home.quit")}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          className="w-[2.2vh] h-[2.2vh]"
                        >
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </FocusButton>
                    </div>
                  ))}
              </div>
            </div>
          )}
          <h1 className="text-[2vh] font-semibold text-fg-dim mb-[2.4vh] tracking-wide">{t("home.apps")}</h1>
          {/* overflow-x:auto forces vertical clipping too (overflow-y:visible is
              not honoured next to auto), so give the focused tile's scale +
              outline + shadow room INSIDE the scroll box and cancel the layout
              shift with the negative margins - otherwise they crop in a hard line */}
          <div className="flex gap-[2.4vw] overflow-x-auto py-[9vh] -my-[5vh] px-[3vw] -mx-[1.4vw] no-scrollbar">
            {sorted.map((app) => (
              <Tile
                key={app.id}
                app={app}
                focusKey={tileKey(app.id)}
                onSelect={onSelect}
                onArrowPress={arrows(tileKey(app.id))}
                onFocused={rememberTile}
              />
            ))}
            {!getMoreHidden && (
              <Tile
                key={GET_MORE_ID}
                app={getMoreTile}
                focusKey={GET_MORE_KEY}
                onSelect={onSelect}
                onArrowPress={arrows(GET_MORE_KEY)}
                onFocused={rememberTile}
              />
            )}
          </div>
        </main>

        <div
          className={[
            "fixed left-1/2 -translate-x-1/2 bottom-[6vh] px-[3vw] py-[1.6vh] rounded-[1.2vh]",
            "bg-[rgba(20,26,36,0.96)] text-[2vh] font-semibold shadow-[0_1vh_3vh_rgba(0,0,0,0.5)]",
            "transition-[opacity,translate] duration-200",
            toast ? "opacity-100 translate-y-0" : "opacity-0 translate-y-[2vh] pointer-events-none",
          ].join(" ")}
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      </div>
    </FocusContext.Provider>
  );
}
