import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { AppManifest } from "../lib/types";
import { fetchApps } from "../lib/api";
import { launchApp } from "../lib/shell";
import { useI18n } from "../lib/i18n";
import { useNavStore } from "../stores/nav";
import { useAppPrefsStore, orderIds } from "../stores/appPrefs";
import { Clock } from "./Clock";
import { Tile } from "./Tile";
import { FocusButton } from "./FocusButton";
import { PowerMenu } from "./PowerMenu";

// A synthetic HOME tile that opens the app catalog ("Get more apps"). Not a real
// app - onSelect routes its id to the catalog view. Hideable via Settings → Apps.
const GET_MORE_ID = "__getmore";

export function Home() {
  const { t, loc, tag } = useI18n();
  const open = useNavStore((s) => s.open);
  const order = useAppPrefsStore((s) => s.order);
  const hidden = useAppPrefsStore((s) => s.hidden);
  const getMoreHidden = useAppPrefsStore((s) => s.getMoreHidden);
  const [apps, setApps] = useState<AppManifest[]>([]);
  const [powerOpen, setPowerOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { ref, focusKey } = useFocusable({ focusKey: "home-rail" });

  useEffect(() => {
    let alive = true;
    fetchApps().then((list) => {
      if (alive) setApps(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  // apply the user's manual order + hidden set (Settings → Apps); unlisted apps
  // fall back to localized-name order, so a newly installed app appears at the end
  const sorted = useMemo(() => {
    const byId = new Map(apps.map((a) => [a.id, a]));
    const visible = apps.filter((a) => !hidden.includes(a.id));
    const byName = (x: string, y: string) => loc(byId.get(x)!.name).localeCompare(loc(byId.get(y)!.name), tag);
    return orderIds(
      visible.map((a) => a.id),
      order,
      byName,
    ).map((id) => byId.get(id)!);
  }, [apps, order, hidden, loc, tag]);

  // focus the first tile once the apps load; else the "Get more" tile; else the
  // Settings gear (nothing installed and Get-more hidden)
  useEffect(() => {
    const first = sorted.length ? sorted[0].id : !getMoreHidden ? GET_MORE_ID : "home-settings";
    const id = setTimeout(() => setFocus(first), 0);
    return () => clearTimeout(id);
  }, [sorted, getMoreHidden]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // Kick off an on-demand provision - either a bundle install (e.g. Plex's
  // flatpak, /apps/install) or a no-root binary-dep install (/apps/deps, the
  // "no CLI" path for an app whose required binary ships as a download dep).
  // Optimistically mark the tile installing; the poll effect below refetches
  // until it completes. `kind` is remembered so the completion toast checks the
  // right success signal (bundle -> installed, deps -> depsOk).
  const pendingKind = useRef<Map<string, "bundle" | "deps">>(new Map());
  const provision = useCallback(
    (app: AppManifest, kind: "bundle" | "deps") => {
      showToast(t("home.installing", { name: loc(app.name) }));
      pendingKind.current.set(app.id, kind);
      setApps((prev) => prev.map((a) => (a.id === app.id ? { ...a, installing: true } : a)));
      // On a failed kickoff just clear the optimistic flag; the installing→idle
      // transition is announced once by the completion effect below (avoids a
      // double "install failed" toast).
      const clear = () => setApps((prev) => prev.map((a) => (a.id === app.id ? { ...a, installing: false } : a)));
      fetch(kind === "deps" ? "/tvbox/api/apps/deps" : "/tvbox/api/apps/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: app.id }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!d.ok) clear();
        })
        .catch(clear);
    },
    [showToast, t, loc],
  );

  // While any app is installing, poll /apps so the tile updates and completions
  // are announced; polling stops once nothing is installing.
  const prevInstalling = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(apps.filter((a) => a.installing).map((a) => a.id));
    for (const id of prevInstalling.current) {
      if (!now.has(id)) {
        const a = apps.find((x) => x.id === id);
        const kind = pendingKind.current.get(id);
        pendingKind.current.delete(id);
        // success = the thing we provisioned actually landed: a bundle install
        // flips `installed`; a deps install flips `depsOk`. If we don't know the
        // kind (e.g. a reload observed an install we didn't start), be lenient -
        // treat either signal as success rather than a false "failed".
        const ok =
          a &&
          (kind === "bundle" ? a.installed : kind === "deps" ? a.depsOk !== false : a.installed || a.depsOk !== false);
        if (a) showToast(t(ok ? "home.installed" : "home.installFailed", { name: loc(a.name) }));
      }
    }
    prevInstalling.current = now;
    if (!now.size) return;
    let alive = true;
    const iv = setInterval(() => {
      fetchApps().then((list) => {
        if (alive) setApps(list);
      });
    }, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [apps, showToast, t, loc]);

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
      if (app.installing) {
        showToast(t("home.installing", { name: loc(app.name) }));
        return;
      }
      if (app.depsOk === false) {
        // a required binary isn't installed. If it's a no-root download dep,
        // install it right here (remote-only, no CLI); otherwise it needs the
        // box (`tvbox deps <id>` / an apt package).
        if (app.depsInstallable) provision(app, "deps");
        else showToast(t("home.needs", { dep: (app.missing || []).join(", ") }));
        return;
      }
      if (app.configured === false) {
        // a config-driven remote app (e.g. Home Assistant) has no URL yet
        showToast(t("home.setupNeeded", { name: loc(app.name) }));
        open("settings");
        return;
      }
      if (app.installable && !app.installed) {
        provision(app, "bundle");
        return;
      } // fetch the bundle first (e.g. Plex)
      if (!launchApp(app.id)) showToast(t("home.bridgeMissing")); // every app opens as a shell window
    },
    [showToast, t, loc, open, provision],
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
            className="shrink-0 w-[6vh] h-[6vh] rounded-full bg-white/5 flex items-center justify-center text-[3vh]"
          >
            ⚙
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
          <h1 className="text-[2vh] font-semibold text-fg-dim mb-[2.4vh] tracking-wide">{t("home.apps")}</h1>
          {/* overflow-x:auto forces vertical clipping too (overflow-y:visible is
              not honoured next to auto), so give the focused tile's scale+shadow
              room INSIDE the scroll box and cancel the layout shift with the
              negative margins - otherwise the shadow crops in a hard line */}
          <div className="flex gap-[2.4vw] overflow-x-auto py-[9vh] -my-[5vh] px-[3vw] -mx-[1.4vw] no-scrollbar">
            {sorted.map((app) => (
              <Tile key={app.id} app={app} onSelect={onSelect} />
            ))}
            {!getMoreHidden && <Tile key={GET_MORE_ID} app={getMoreTile} onSelect={onSelect} />}
          </div>
        </main>

        <div
          className={[
            "fixed left-1/2 -translate-x-1/2 bottom-[6vh] px-[3vw] py-[1.6vh] rounded-[1.2vh]",
            "bg-[rgba(20,26,36,0.96)] text-[2vh] font-semibold shadow-[0_1vh_3vh_rgba(0,0,0,0.5)]",
            "transition-[opacity,transform] duration-200",
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
