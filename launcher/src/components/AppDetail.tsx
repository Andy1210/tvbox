import { useEffect } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useFocusableItem } from "@sdk/useFocusableItem";
import { type StoreEntry } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { FocusButton } from "./FocusButton";
import { Icon } from "./Icon";

// Full-screen App Store detail view, opened when a store row is selected. Shows
// the app's icon/name/tagline, its version state (installed vs latest), the
// available actions (Install / Update / Remove / Set address / Back) and the
// "What's new" changelog. Rendered as a fixed overlay (like Osk) so it looks the
// same whether the store is reached from Settings or the full-screen Catalog.
// All actions are handled by StoreSettings (the callbacks refresh the list);
// Back (remote + button) returns to the list. Its own focus boundary.

// One changelog entry - a non-actionable D-pad-focusable card so a long
// "What's new" list can be scrolled with the remote (focus scrolls it in view).
function ChangelogEntry({ focusKey, version, notes }: { focusKey: string; version: string; notes: string }) {
  const { ref, focused } = useFocusableItem({ focusKey }, { block: "nearest" });
  return (
    <div
      ref={ref}
      className={[
        "rounded-[1.1vh] px-[1.6vw] py-[1.3vh] bg-white/5 border-[0.3vh] transition-colors",
        focused ? "border-focus bg-white/10" : "border-transparent",
      ].join(" ")}
    >
      <div className="text-[1.9vh] font-semibold mb-[0.5vh]">v{version}</div>
      <div className="text-[1.7vh] text-fg-dim leading-[1.5] whitespace-pre-line">{notes}</div>
    </div>
  );
}

// A store screenshot: a D-pad-focusable card so the remote can scroll a wide
// gallery into view (like ChangelogEntry). The image is an external https URL
// (hosted in the registry); a broken/offline URL just hides itself.
function Screenshot({ focusKey, src }: { focusKey: string; src: string }) {
  const { ref, focused } = useFocusableItem<HTMLDivElement>({ focusKey }, { block: "nearest", inline: "nearest" });
  return (
    <div
      ref={ref}
      className={[
        "shrink-0 rounded-[1.1vh] overflow-hidden border-[0.3vh] transition-colors bg-black/30",
        focused ? "border-focus" : "border-transparent",
      ].join(" ")}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        className="h-[26vh] w-auto block"
        onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = "none")}
      />
    </div>
  );
}

// Shown while a store install runs: a localized phase line + an indeterminate
// progress bar (the shell reports a coarse phase, not a percentage, so the bar
// animates rather than fills). It replaces the action buttons; focus lives on
// the Back button meanwhile so the D-pad is never stranded.
function InstallProgress({ phase }: { phase?: string | null }) {
  const { t } = useI18n();
  const label =
    phase === "deps"
      ? t("store.phaseDeps")
      : phase === "bundle"
        ? t("store.phaseBundle")
        : phase === "finishing"
          ? t("store.phaseFinishing")
          : t("store.installingGeneric");
  return (
    <div className="flex flex-col gap-[1.1vh] min-w-[32vw]" role="status" aria-live="polite">
      <span className="text-[2.1vh] font-semibold text-sky-200">{label}</span>
      <div className="h-[0.9vh] w-full rounded-full bg-white/10 overflow-hidden">
        <div className="tv-install-bar h-full w-[40%] rounded-full bg-sky-400" />
      </div>
    </div>
  );
}

export function AppDetail({
  app,
  status,
  onInstall,
  onUpdate,
  onRemove,
  onSetUrl,
  onExit,
}: {
  app: StoreEntry;
  status?: string | null;
  onInstall: () => void;
  onUpdate: () => void;
  onRemove: () => void;
  onSetUrl: () => void;
  onExit: () => void;
}) {
  const { t, loc } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "app-detail", isFocusBoundary: true });
  const accent = app.accent || "#4152d8";
  const changelog = app.changelog || [];

  // The first action that exists for this app - where focus lands on open.
  const firstAction = (): string => {
    if (app.installing) return "detail-back"; // progress replaces the action buttons
    if (!app.builtin && !app.installed) return "detail-install";
    if (!app.builtin && app.updateAvailable) return "detail-update";
    if (!app.builtin && app.installed) return "detail-remove";
    if (app.urlConfig) return "detail-url";
    return "detail-back";
  };
  useEffect(() => {
    const id = setTimeout(() => setFocus(firstAction()), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useBackspace(onExit);

  const hints = [app.urlConfig && app.installed && !app.baseUrl ? t("store.urlMissing") : null].filter(Boolean);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-50 bg-bg-0 flex flex-col px-[6vw] py-[5vh] overflow-y-auto no-scrollbar"
      >
        {/* header */}
        <div className="flex items-center gap-[2vw] mb-[2.5vh]">
          <div
            className="w-[9vh] h-[9vh] rounded-[1.6vh] flex items-center justify-center shrink-0"
            style={{ backgroundColor: accent + "22" }}
          >
            <Icon svg={app.icon} className="w-[6vh] h-[6vh]" />
          </div>
          <div className="min-w-0">
            <div className="text-[3.4vh] font-bold truncate">{loc(app.name)}</div>
            {app.tagline && <div className="text-[2vh] text-fg-dim truncate">{loc(app.tagline)}</div>}
          </div>
        </div>

        {/* version */}
        <div className="flex flex-wrap items-center gap-[1.2vw] mb-[1.6vh]">
          <span className="text-[2vh] text-fg-dim">
            {app.installed && app.installedVersion
              ? t("store.installedLatest", { installed: app.installedVersion, latest: app.version })
              : t("store.version", { v: "v" + app.version })}
          </span>
          {/* fixed emerald (same as the Update button) - the manifest accent
              can be arbitrarily dark and unreadable */}
          {app.updateAvailable && (
            <span className="text-[1.7vh] font-semibold px-[1.2vw] py-[0.5vh] rounded-[0.8vh] bg-emerald-500/15 text-emerald-200">
              {t("store.updateAvailableBadge")}
            </span>
          )}
        </div>

        {app.description && (
          <div className="text-[2.1vh] text-fg leading-[1.6] max-w-[72vw] mb-[2vh] whitespace-pre-line">
            {loc(app.description)}
          </div>
        )}

        {hints.length > 0 && <div className="text-[1.7vh] text-warn mb-[1.6vh]">{hints.join(" · ")}</div>}

        {/* actions - while an install runs, the progress indicator takes the
            place of Install/Update/Remove (Back stays focusable throughout) */}
        <div className="flex flex-wrap items-center gap-[1.2vw]">
          {app.builtin && <span className="text-[2vh] text-fg-dim px-[1.6vw] py-[1.4vh]">{t("store.builtin")}</span>}
          {!app.builtin &&
            (app.installing ? (
              <InstallProgress phase={app.progress?.phase} />
            ) : (
              <>
                {!app.installed && (
                  <FocusButton
                    focusKey="detail-install"
                    onEnter={onInstall}
                    className="px-[2.4vw] h-[6vh] rounded-[1.1vh] bg-sky-500/15 text-sky-200 flex items-center justify-center text-[2.1vh] font-semibold"
                  >
                    {t("home.install")}
                  </FocusButton>
                )}
                {app.updateAvailable && (
                  <FocusButton
                    focusKey="detail-update"
                    onEnter={onUpdate}
                    className="px-[2.4vw] h-[6vh] rounded-[1.1vh] bg-emerald-500/15 text-emerald-200 flex items-center justify-center text-[2.1vh] font-semibold"
                  >
                    {t("store.update")}
                  </FocusButton>
                )}
                {app.installed && (
                  <FocusButton
                    focusKey="detail-remove"
                    onEnter={onRemove}
                    className="px-[2.4vw] h-[6vh] rounded-[1.1vh] bg-red-500/15 text-red-200 flex items-center justify-center text-[2.1vh] font-semibold"
                  >
                    {t("appsettings.uninstall")}
                  </FocusButton>
                )}
              </>
            ))}
          {app.urlConfig && (
            <FocusButton
              focusKey="detail-url"
              onEnter={onSetUrl}
              className="px-[2.4vw] h-[6vh] rounded-[1.1vh] bg-white/5 flex items-center justify-center text-[2.1vh] font-semibold"
            >
              {t("store.setUrl")}
            </FocusButton>
          )}
          <FocusButton
            focusKey="detail-back"
            onEnter={onExit}
            className="px-[2.4vw] h-[6vh] rounded-[1.1vh] bg-white/5 flex items-center justify-center text-[2.1vh] font-semibold"
          >
            {t("store.back")}
          </FocusButton>
        </div>

        {status && (
          <div className="text-[1.8vh] text-fg-dim mt-[1.2vh]" role="status" aria-live="polite">
            {status}
          </div>
        )}

        {/* screenshots */}
        {app.screenshots && app.screenshots.length > 0 && (
          <>
            <div className="text-[2.4vh] font-semibold mt-[3.5vh] mb-[1.4vh]">{t("store.screenshots")}</div>
            <div className="flex gap-[1.5vw] overflow-x-auto no-scrollbar pb-[1vh] -mx-[1vw] px-[1vw]">
              {app.screenshots.map((s, i) => (
                <Screenshot key={i} focusKey={"detail-shot-" + i} src={s} />
              ))}
            </div>
          </>
        )}

        {/* what's new */}
        <div className="text-[2.4vh] font-semibold mt-[3.5vh] mb-[1.4vh]">{t("store.whatsNew")}</div>
        {changelog.length === 0 ? (
          <div className="text-[1.9vh] text-fg-dim">{t("store.noNotes")}</div>
        ) : (
          <div className="flex flex-col gap-[1vh] max-w-[74vw]">
            {changelog.map((c, i) => (
              <ChangelogEntry
                key={c.version + "-" + i}
                focusKey={"detail-cl-" + i}
                version={c.version}
                notes={c.notes}
              />
            ))}
          </div>
        )}
      </div>
    </FocusContext.Provider>
  );
}
