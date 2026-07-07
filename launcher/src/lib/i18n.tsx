// i18n moved to @tvbox/app-sdk (app-sdk/src/i18n.tsx), generalized to accept the
// locale dictionaries from its host. This shim wires the launcher's own locales
// into the shared module and preserves the launcher's original public surface -
// including the `AVAILABLE_LOCALES` const call sites use as a value.
import { configureI18n, availableLocales } from "@sdk/i18n";
import hu from "../locales/hu.json";
import en from "../locales/en.json";

configureI18n({ hu, en }, { fallback: "en" });

export const AVAILABLE_LOCALES = availableLocales();

export { useI18n, translate, localize, useLocaleStore } from "@sdk/i18n";
export type { I18n, LocaleInfo } from "@sdk/i18n";
