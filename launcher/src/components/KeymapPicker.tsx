import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { fetchRegion, setKeymap } from "../lib/region";
import { FocusButton } from "./FocusButton";

// Scrollable list of the ~99 console/X keymap codes. Friendly names for the
// common ones (raw code kept visible too); everything else falls back to the
// raw code. Self-fetching + self-posting. On a box whose image predates the
// polkit grant the POST returns false - we still mark the pick and show a short
// "applies after the next update" note, so the wizard never stalls.
const KEYMAP_LABELS: Record<string, string> = {
  gb: "English (UK)",
  us: "English (US)",
  hu: "Hungarian",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  br: "Portuguese (Brazil)",
  nl: "Dutch",
  pl: "Polish",
  cz: "Czech",
  sk: "Slovak",
  ro: "Romanian",
  hr: "Croatian",
  si: "Slovenian",
  rs: "Serbian",
  ru: "Russian",
  ua: "Ukrainian",
  bg: "Bulgarian",
  gr: "Greek",
  tr: "Turkish",
  se: "Swedish",
  no: "Norwegian",
  dk: "Danish",
  fi: "Finnish",
  is: "Icelandic",
  ch: "Swiss",
  at: "German (Austria)",
  be: "Belgian",
  ie: "Irish",
  ca: "Canadian",
  jp: "Japanese",
  kr: "Korean",
};

// Friendly name for a layout code, falling back to the raw code. Shared with the
// Settings control that shows the current layout.
export const keymapLabel = (code: string): string => KEYMAP_LABELS[code] ?? code;

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
          {active ? (KEYMAP_LABELS[active] ?? active) : "-"}
          {active && KEYMAP_LABELS[active] ? (
            <span className="text-fg-dim text-[1.8vh] ml-[0.8vw]">{active}</span>
          ) : null}
        </span>
      </div>
      {deferred && <div className="text-[1.9vh] text-[#e0b64a] mb-[1vh]">{t("region.keymapLater")}</div>}
      <div className="flex flex-col gap-[0.8vh] flex-1 min-h-0 overflow-y-auto no-scrollbar max-w-[64vw]">
        {codes.map((code) => {
          const friendly = KEYMAP_LABELS[code];
          return (
            <FocusButton
              key={code}
              focusKey={"km-" + code}
              onEnter={() => pick(code)}
              className="px-[2vw] py-[1.4vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
            >
              <span className="text-[2.1vh]">{friendly ?? code}</span>
              <span className="flex items-center gap-[1.2vw] shrink-0 text-fg-dim">
                {friendly && <span className="text-[1.8vh] tabular-nums">{code}</span>}
                {code === active && <span className="text-[1.7vh] text-[#39c0d6]">●</span>}
              </span>
            </FocusButton>
          );
        })}
        {!codes.length && <div className="text-[1.9vh] text-fg-dim">-</div>}
      </div>
    </div>
  );
}
