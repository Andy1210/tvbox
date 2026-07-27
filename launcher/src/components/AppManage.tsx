import { useEffect } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { AppManifest } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { useEntryAnim } from "../lib/useEntryAnim";
import { FocusButton } from "./FocusButton";
import { Icon } from "./Icon";

// Everything about ONE installed app, on its own screen: what it is, whether it is
// on the home screen, the actions it declares for a phone, and removing it.
//
// It exists because the list row could not hold it. Each app brings its own phone
// actions (RetroArch alone declares three), so the row grew past the point where the
// app's NAME still fit, and per-app version and update information is on the way.
// A row can hold a name and a way in; the app's own actions belong behind it.
//
// Reordering deliberately stays in the list: moving an app is about its neighbours,
// so it belongs where the neighbours are visible.
export function AppManage({
  app,
  hidden,
  onToggleHidden,
  onUninstall,
  onPairing,
  onExit,
}: {
  app: AppManifest;
  hidden: boolean; // from the home-screen prefs store, not the manifest
  onToggleHidden: () => void;
  onUninstall: () => void;
  onPairing: (kind: string, label: string) => void;
  onExit: () => void;
}) {
  const { t, loc } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "app-manage", isFocusBoundary: true });
  const entryAnim = useEntryAnim();
  const accent = app.accent || "#4152d8";
  const pairing = app.pairing || [];

  // Land on the first phone action when the app has one, since that is what this
  // screen is usually opened for; otherwise on the visibility toggle.
  useEffect(() => {
    const target = pairing.length ? "manage-pair-" + pairing[0].kind : "manage-hide";
    const id = setTimeout(() => setFocus(target), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useBackspace(onExit);

  const btn = "px-[2.4vw] py-[1.5vh] rounded-[1.2vh] text-[2.1vh] font-semibold";

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        style={entryAnim}
        className="fixed inset-0 z-50 bg-bg-0 flex flex-col px-[6vw] py-[5vh] overflow-y-auto no-scrollbar"
      >
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

        <div className="text-[2vh] text-fg-dim mb-[2.4vh]">
          {hidden ? t("appsettings.stateHidden") : t("appsettings.stateShown")}
          {app.running ? " · " + t("appsettings.stateRunning") : ""}
        </div>

        {pairing.length > 0 && (
          <>
            <div className="text-[2.2vh] font-semibold mb-[0.6vh]">{t("appsettings.phoneActions")}</div>
            <div className="text-[1.8vh] text-fg-dim mb-[1.4vh] max-w-[70vw]">{t("appsettings.phoneActionsHint")}</div>
            <div className="flex flex-wrap gap-[1.2vw] mb-[3vh]">
              {pairing.map((p) => (
                <FocusButton
                  key={p.kind}
                  focusKey={"manage-pair-" + p.kind}
                  onEnter={() => onPairing(p.kind, loc(p.label))}
                  className={btn + " bg-white/10"}
                >
                  {loc(p.label)}
                </FocusButton>
              ))}
            </div>
          </>
        )}

        <div className="text-[2.2vh] font-semibold mb-[1.4vh]">{t("appsettings.manageTitle")}</div>
        <div className="flex flex-wrap gap-[1.2vw]">
          <FocusButton focusKey="manage-hide" onEnter={onToggleHidden} className={btn + " bg-white/10"}>
            {hidden ? t("appsettings.show") : t("appsettings.hide")}
          </FocusButton>
          {app.installable && app.installed && (
            <FocusButton focusKey="manage-remove" onEnter={onUninstall} className={btn + " bg-red-500/15 text-red-200"}>
              {t("appsettings.uninstall")}
            </FocusButton>
          )}
          <FocusButton focusKey="manage-back" onEnter={onExit} className={btn + " bg-white/10"}>
            {t("appsettings.back")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
