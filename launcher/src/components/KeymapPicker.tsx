import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, type I18n } from "../lib/i18n";
import { fetchRegion, setKeymap } from "../lib/region";
import { FocusButton } from "./FocusButton";

// Scrollable list of the ~99 console/X keymap codes. The common layouts have a
// localized display name under the `keymap` namespace (raw code kept visible
// too); everything else falls back to the raw code. Self-fetching + self-posting.
// On a box whose image predates the polkit grant the POST returns false - we
// still mark the pick and show a short "applies after the next update" note, so
// the wizard never stalls.
//
// Layout codes that have a translated name at `keymap.<code>` in the locale
// files. Codes not listed here (dvorak, colemak, exotic X layouts) show raw.
const NAMED_KEYMAPS = new Set<string>([
  "gb",
  "us",
  "hu",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "br",
  "nl",
  "pl",
  "cz",
  "sk",
  "ro",
  "hr",
  "si",
  "rs",
  "ru",
  "ua",
  "bg",
  "gr",
  "tr",
  "se",
  "no",
  "dk",
  "fi",
  "is",
  "ch",
  "at",
  "be",
  "ie",
  "ca",
  "jp",
  "kr",
]);

// Localized display name for a layout code, falling back to the raw code. Shared
// with the Settings control that shows the current layout; takes the caller's
// bound translator so it stays reactive to the active locale.
export const keymapLabel = (t: I18n["t"], code: string): string =>
  NAMED_KEYMAPS.has(code) ? t("keymap." + code) : code;

export function KeymapPicker({ onChange, autoFocus }: { onChange?: (km: string) => void; autoFocus?: boolean }) {
  const { t } = useI18n();
  const [codes, setCodes] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [picked, setPicked] = useState<string | null>(null); // last chosen, even if the POST was refused
  const [deferred, setDeferred] = useState(false); // POST returned false -> "applies later"

  // Fetch exactly once per mount (empty deps); autoFocus is a stable prop.
  useEffect(() => {
    fetchRegion().then((r) => {
      if (!r) return;
      setCodes(r.keymaps);
      setCurrent(r.keymap);
      // Land focus on the current layout once the list arrives (see TimezonePicker).
      if (autoFocus) {
        const target = r.keymaps.includes(r.keymap) ? r.keymap : r.keymaps[0];
        if (target) setTimeout(() => setFocus("km-" + target), 0);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = picked ?? current;

  const pick = async (code: string) => {
    setPicked(code); // reflect the choice immediately
    const ok = await setKeymap(code);
    if (ok) {
      setCurrent(code);
      setDeferred(false);
      onChange?.(code);
    } else {
      setDeferred(true); // still selected, just not applied yet
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-baseline gap-[1.2vw] mb-[0.8vh]">
        <span className="text-[2vh] text-fg-dim">{t("region.current")}</span>
        <span className="text-[2.2vh] font-semibold">
          {active ? keymapLabel(t, active) : "-"}
          {active && NAMED_KEYMAPS.has(active) ? (
            <span className="text-fg-dim text-[1.8vh] ml-[0.8vw]">{active}</span>
          ) : null}
        </span>
      </div>
      {deferred && <div className="text-[1.9vh] text-[#e0b64a] mb-[1vh]">{t("region.keymapLater")}</div>}
      <div className="flex flex-col gap-[0.8vh] flex-1 min-h-0 overflow-y-auto no-scrollbar max-w-[64vw] px-[1.5vw] -mx-[1.5vw]">
        {codes.map((code) => {
          const named = NAMED_KEYMAPS.has(code);
          return (
            <FocusButton
              key={code}
              focusKey={"km-" + code}
              onEnter={() => pick(code)}
              className="px-[2vw] py-[1.4vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
            >
              <span className="text-[2.1vh]">{keymapLabel(t, code)}</span>
              <span className="flex items-center gap-[1.2vw] shrink-0 text-fg-dim">
                {named && <span className="text-[1.8vh] tabular-nums">{code}</span>}
                {code === active && <span className="w-[1.2vh] h-[1.2vh] rounded-full bg-[#39c0d6] shrink-0" />}
              </span>
            </FocusButton>
          );
        })}
        {!codes.length && <div className="text-[1.9vh] text-fg-dim">-</div>}
      </div>
    </div>
  );
}
