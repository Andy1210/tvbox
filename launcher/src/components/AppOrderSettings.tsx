import { useEffect, useMemo, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { AppManifest } from "../lib/types";
import { fetchApps, removeApp } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useAppPrefsStore, orderIds } from "../stores/appPrefs";
import { FocusButton } from "./FocusButton";
import { usePinGuard } from "../lib/usePinGuard";
import { Icon } from "./Icon";

// Apps section of the HOME Settings screen: reorder the home-screen apps
// (move up/down), hide/show them, and uninstall a downloaded bundle (the tile
// reverts to installable - one tap re-fetches it, so no confirm step). Reads/
// writes the same appPrefs store Home uses. D-pad friendly - per-row move
// buttons rather than drag. Renders inside the parent Settings FocusContext.
const Chevron = ({ up }: { up?: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="w-[2.4vh] h-[2.4vh]">
    <path d={up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function AppOrderSettings() {
  const { guard, gate } = usePinGuard();
  const { t, loc, tag } = useI18n();
  // null = still loading (renders nothing), [] = a real empty list - so the
  // "no apps" copy can't flash before fetchApps resolves (StoreSettings pattern)
  const [apps, setApps] = useState<AppManifest[] | null>(null);
  const order = useAppPrefsStore((s) => s.order);
  const hidden = useAppPrefsStore((s) => s.hidden);
  const setOrder = useAppPrefsStore((s) => s.setOrder);
  const toggleHidden = useAppPrefsStore((s) => s.toggleHidden);
  const getMoreHidden = useAppPrefsStore((s) => s.getMoreHidden);
  const toggleGetMore = useAppPrefsStore((s) => s.toggleGetMore);

  useEffect(() => {
    let alive = true;
    fetchApps().then((l) => alive && setApps(l));
    return () => {
      alive = false;
    };
  }, []);

  // full list (incl. hidden) in the effective order, so reordering is stable
  const ordered = useMemo(() => {
    const list = apps ?? [];
    const byId = new Map(list.map((a) => [a.id, a]));
    const byName = (x: string, y: string) => loc(byId.get(x)!.name).localeCompare(loc(byId.get(y)!.name), tag);
    return orderIds(
      list.map((a) => a.id),
      order,
      byName,
    ).map((id) => byId.get(id)!);
  }, [apps, order, loc, tag]);

  // The only static focusable at mount is the "Get more apps" toggle above; the
  // app rows arrive async (fetchApps), and the parent Settings focuses this
  // panel's first child before that resolves - so the initial load must place
  // focus on the list itself or the D-pad can never reach it (it would stick on
  // the toggle) - same convention as StoreSettings. One-shot: refetches must not
  // steal focus.
  const focusPlaced = useRef(false);
  useEffect(() => {
    if (focusPlaced.current || !ordered.length) return;
    focusPlaced.current = true;
    const id = ordered[0].id;
    // the first row's "move up" is a no-op (nothing above it) - land on an
    // actionable control: "move down" when another row exists, otherwise "hide"
    const target = ordered.length > 1 ? "apporder-down-" + id : "apporder-hide-" + id;
    setTimeout(() => setFocus(target), 0);
  }, [ordered]);

  const move = (id: string, dir: -1 | 1) => {
    const ids = ordered.map((a) => a.id);
    const i = ids.indexOf(id),
      j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next); // materialize the full explicit order
    setTimeout(() => setFocus(`apporder-${dir < 0 ? "up" : "down"}-${id}`), 0);
  };

  const [status, setStatus] = useState<string | null>(null);
  const uninstall = async (a: AppManifest) => {
    const ok = await removeApp(a.id);
    setStatus(t(ok ? "appsettings.uninstalled" : "appsettings.uninstallFailed", { name: loc(a.name) }));
    if (ok) fetchApps().then(setApps);
    setTimeout(() => setFocus("apporder-hide-" + a.id), 0); // the uninstall button is about to unmount
  };

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[0.8vh]">{t("appsettings.title")}</div>
      <div className="text-fg-dim text-[1.8vh] mb-[1.4vh] max-w-[70vw]">{t("appsettings.hint")}</div>

      {/* the "Get more apps" HOME tile - shown by default, hideable here */}
      <div className="flex items-center gap-[1.5vw] px-[1.5vw] py-[1.2vh] rounded-[1.1vh] bg-white/5 mb-[1.4vh] max-w-[70vw]">
        <span className="text-[2.1vh] flex-1 min-w-0">{t("appsettings.getMore")}</span>
        <FocusButton
          focusKey="apporder-getmore"
          onEnter={toggleGetMore}
          className="px-[1.6vw] h-[5.4vh] rounded-[1vh] bg-white/5 flex items-center justify-center text-[1.9vh] font-semibold shrink-0"
        >
          {getMoreHidden ? t("appsettings.show") : t("appsettings.hide")}
        </FocusButton>
      </div>

      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {ordered.map((a, i) => {
          const isHidden = hidden.includes(a.id);
          return (
            <div
              key={a.id}
              className={[
                "px-[1.5vw] py-[1.2vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.5vw]",
                isHidden ? "opacity-40" : "",
              ].join(" ")}
            >
              <Icon svg={a.icon} className="w-[3.4vh] h-[3.4vh] shrink-0" />
              <span className="text-[2.1vh] truncate flex-1 min-w-0">{loc(a.name)}</span>
              <FocusButton
                focusKey={"apporder-up-" + a.id}
                onEnter={() => move(a.id, -1)}
                className={[
                  "w-[5.4vh] h-[5.4vh] rounded-[1vh] bg-white/5 flex items-center justify-center",
                  i === 0 ? "opacity-30" : "",
                ].join(" ")}
              >
                <Chevron up />
              </FocusButton>
              <FocusButton
                focusKey={"apporder-down-" + a.id}
                onEnter={() => move(a.id, 1)}
                className={[
                  "w-[5.4vh] h-[5.4vh] rounded-[1vh] bg-white/5 flex items-center justify-center",
                  i === ordered.length - 1 ? "opacity-30" : "",
                ].join(" ")}
              >
                <Chevron />
              </FocusButton>
              <FocusButton
                focusKey={"apporder-hide-" + a.id}
                onEnter={() => toggleHidden(a.id)}
                className="px-[1.6vw] h-[5.4vh] rounded-[1vh] bg-white/5 flex items-center justify-center text-[1.9vh] font-semibold shrink-0"
              >
                {isHidden ? t("appsettings.show") : t("appsettings.hide")}
              </FocusButton>
              {a.installable && a.installed && (
                <FocusButton
                  focusKey={"apporder-remove-" + a.id}
                  onEnter={() => guard(() => uninstall(a), "apporder-remove-" + a.id)}
                  className="px-[1.6vw] h-[5.4vh] rounded-[1vh] bg-red-500/15 text-red-200 flex items-center justify-center text-[1.9vh] font-semibold shrink-0"
                >
                  {t("appsettings.uninstall")}
                </FocusButton>
              )}
            </div>
          );
        })}
        {apps !== null && !ordered.length && <div className="text-[1.9vh] text-fg-dim">{t("appsettings.none")}</div>}
        {status && (
          <div className="text-[1.8vh] text-fg-dim mt-[0.6vh]" role="status" aria-live="polite">
            {status}
          </div>
        )}
        {gate}
      </div>
    </div>
  );
}
