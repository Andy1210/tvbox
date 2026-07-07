import { useEffect } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { AVAILABLE_LOCALES, useI18n, type LocaleInfo } from "../lib/i18n";
import { useFocusableItem } from "../lib/useFocusableItem";

function LangButton({ locale, onPick }: { locale: LocaleInfo; onPick: (id: string) => void }) {
  // Always visible in a centered picker, so no scroll - just the focus ref + state.
  const { ref, focused } = useFocusableItem<HTMLButtonElement>({
    focusKey: "lang-" + locale.id,
    onEnterPress: () => onPick(locale.id),
  });
  return (
    <button
      ref={ref}
      onClick={() => onPick(locale.id)}
      className={[
        "min-w-[26vw] px-[3vw] py-[3vh] rounded-[1.6vh] text-[3vh] font-bold",
        "bg-white/5 transition-[transform,background-color,color] duration-150",
        focused ? "!bg-white !text-[#06090d] scale-[1.06]" : "",
      ].join(" ")}
    >
      {locale.name}
    </button>
  );
}

// First-launch language picker. Language names are shown in their own script,
// so this screen needs no chosen locale; only a neutral bilingual header.
export function SetupScreen() {
  const { setLocale } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "setup" });

  useEffect(() => {
    setFocus("lang-" + (AVAILABLE_LOCALES[0]?.id ?? ""));
  }, []);

  const pick = (id: string) => setLocale(id); // store change re-renders App

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col items-center justify-center gap-[5vh]">
        <div className="text-center">
          <div className="text-[2vh] tracking-[0.4vh] uppercase text-fg-dim">Nyelv · Language</div>
          <div className="text-[4vh] font-bold mt-[1vh]">Válassz nyelvet · Choose your language</div>
        </div>
        <div className="flex gap-[3vw]">
          {AVAILABLE_LOCALES.map((l) => (
            <LangButton key={l.id} locale={l} onPick={pick} />
          ))}
        </div>
      </div>
    </FocusContext.Provider>
  );
}
