import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { StoreSettings } from "./StoreSettings";

// Full-screen app catalog, opened from the HOME "Get more apps" tile - the
// place you install apps from the registry (Kodi's "Get more"). Installing
// writes the app's manifest to ~/.tvbox/apps and its tile then appears on HOME.
// Same panel as Settings → App Store, just standalone with a title + Back to
// HOME. StoreSettings renders its own FocusButtons, so we provide the
// FocusContext (as the Settings category panel does).
export function Catalog({ onExit }: { onExit: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "catalog" });
  useBackspace(onExit);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[5vw] py-[4vh] overflow-y-auto no-scrollbar">
        <div className="text-[3vh] font-bold">{t("catalog.title")}</div>
        <StoreSettings />
      </div>
    </FocusContext.Provider>
  );
}
