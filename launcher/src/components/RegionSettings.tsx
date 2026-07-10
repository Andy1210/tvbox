import { useEffect, useState, type ReactNode } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { fetchRegion } from "../lib/region";
import { FocusButton } from "./FocusButton";
import { TimezonePicker } from "./TimezonePicker";
import { KeymapPicker, keymapLabel } from "./KeymapPicker";

// Settings -> General: Timezone + Keyboard-layout controls. Each is a compact
// row (like DisplaySettings' resolution row) that opens the matching picker as a
// full-screen focus-boundary overlay, so the long zone/layout lists don't push
// the General panel around. Renders inside the parent Settings FocusContext.
type Panel = "tz" | "km";

// Full-screen overlay wrapping a picker. isFocusBoundary keeps D-pad focus
// inside; Backspace closes it (the Timezone city list re-enables its own
// Backspace to step back to its region list first). A Cancel row is the
// keyboardless fallback and the initial focus target until the picker's data
// loads and pulls focus into its list.
function PickerOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "region-overlay", isFocusBoundary: true });
  useBackspace(onClose);
  useEffect(() => {
    setTimeout(() => setFocus("region-overlay-close"), 0);
  }, []);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="fixed inset-0 z-[55] bg-black/90 flex flex-col px-[6vw] py-[5vh]">
        <div className="text-[2.8vh] font-bold mb-[2vh]">{title}</div>
        <div className="flex-1 min-h-0">{children}</div>
        <FocusButton
          focusKey="region-overlay-close"
          onEnter={onClose}
          className="mt-[2vh] self-start px-[2.6vw] py-[1.4vh] rounded-[1.2vh] bg-white/10 text-[2.1vh] font-semibold"
        >
          {t("power.cancel")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}

export function RegionSettings() {
  const { t } = useI18n();
  const [tz, setTz] = useState("");
  const [km, setKm] = useState("");
  const [panel, setPanel] = useState<Panel | null>(null);

  useEffect(() => {
    fetchRegion().then((r) => {
      if (r) {
        setTz(r.timezone);
        setKm(r.keymap);
      }
    });
  }, []);

  const close = (which: Panel) => {
    setPanel(null);
    setTimeout(() => setFocus(which === "tz" ? "region-tz-open" : "region-km-open"), 0);
  };

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">{t("region.timezone")}</div>
      <div className="flex flex-col gap-[1vh] max-w-[70vw]">
        <FocusButton
          focusKey="region-tz-open"
          onEnter={() => setPanel("tz")}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="text-[2.1vh]">{t("region.timezone")}</span>
          <span className="text-[1.9vh] text-fg-dim tabular-nums">{tz || "-"}</span>
        </FocusButton>
        <FocusButton
          focusKey="region-km-open"
          onEnter={() => setPanel("km")}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="text-[2.1vh]">{t("region.keyboard")}</span>
          <span className="text-[1.9vh] text-fg-dim">{km ? keymapLabel(t, km) : "-"}</span>
        </FocusButton>
      </div>

      {panel === "tz" && (
        <PickerOverlay title={t("region.timezone")} onClose={() => close("tz")}>
          <TimezonePicker autoFocus onChange={setTz} />
        </PickerOverlay>
      )}
      {panel === "km" && (
        <PickerOverlay title={t("region.keyboard")} onClose={() => close("km")}>
          <KeymapPicker autoFocus onChange={setKm} />
        </PickerOverlay>
      )}
    </div>
  );
}
