import { useI18n } from "../lib/i18n";
import { LanguagePicker } from "./LanguagePicker";

// Language section: the shared scalable picker (a wrapping grid), so it stays
// usable as more locales are added instead of overflowing a fixed flex-row.
// Renders inside the parent panel FocusContext.
export function LanguageSettings() {
  const { t } = useI18n();
  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">{t("settings.language")}</div>
      <LanguagePicker />
    </div>
  );
}
