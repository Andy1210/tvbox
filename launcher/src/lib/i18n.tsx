// i18n moved to @tvbox/app-sdk (app-sdk/src/i18n.tsx), generalized to accept the
// locale dictionaries from its host. This shim wires the launcher's own locales
// into the shared module and preserves the launcher's original public surface -
// including the `AVAILABLE_LOCALES` const call sites use as a value.
import { configureI18n, availableLocales, useLocaleStore } from "@sdk/i18n";
import hu from "../locales/hu.json";
import en from "../locales/en.json";

configureI18n({ hu, en }, { fallback: "en" });

export const AVAILABLE_LOCALES = availableLocales();

// The shell needs the chosen language for things the renderer can't do: the phone
// pairing pages' wording, and the language every remote web app is told it runs in
// (Accept-Language + navigator.language). The store stays the source of truth; this
// just mirrors it, best effort - there is no shell in the demo build.
function mirrorLocale(locale: string | null) {
  if (!locale) return;
  fetch("/tvbox/api/ui/locale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale }),
  }).catch(() => {});
}
mirrorLocale(useLocaleStore.getState().locale);
useLocaleStore.subscribe((s, prev) => {
  if (s.locale !== prev.locale) mirrorLocale(s.locale);
});

export { useI18n, translate, localize, useLocaleStore } from "@sdk/i18n";
export type { I18n, LocaleInfo } from "@sdk/i18n";
