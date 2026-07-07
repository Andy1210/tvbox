import { AVAILABLE_LOCALES, useI18n } from "../lib/i18n";
import { FocusButton } from "./FocusButton";

// Language section: option pills sized to match the other settings rows (not the
// oversized first-launch picker). Renders inside the parent panel FocusContext.
export function LanguageSettings() {
  const { t, setLocale, locale } = useI18n();
  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">{t("settings.language")}</div>
      <div className="flex gap-[1.5vw]">
        {AVAILABLE_LOCALES.map((l, i) => (
          <FocusButton
            key={l.id}
            focusKey={"lang-opt-" + i}
            onEnter={() => setLocale(l.id)}
            className={[
              "px-[3vw] py-[1.5vh] rounded-[1.1vh] text-[2.1vh] font-semibold bg-white/5",
              locale === l.id ? "ring-[0.25vh] ring-white/40" : "",
            ].join(" ")}
          >
            {l.name}
          </FocusButton>
        ))}
      </div>
    </div>
  );
}
