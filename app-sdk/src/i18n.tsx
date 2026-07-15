// Configurable i18n for tvbox: JSON locale dictionaries + a Zustand store for the
// chosen locale (persisted). Unlike the launcher's original, this module hardcodes
// no languages - the host (launcher or a standalone app) injects its dictionaries
// via configureI18n(). useI18n() keeps the same shape components already use
// (locale/tag/t/loc/setLocale); the store is the source of truth, so there's no
// provider and no ad-hoc localStorage reads.
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

// A localizable value: either a plain string (e.g. a brand name like "Plex")
// or a per-locale map (e.g. { hu: "Élő TV", en: "Live TV" }).
export type LocaleString = string | Record<string, string>;

// Each locale dict must carry a `_meta` { name, tag }: the display name (shown in
// its own script) and the BCP-47 tag used for Intl date/number formatting.
export type LocaleDict = Record<string, unknown> & { _meta: { name: string; tag: string } };

export interface LocaleInfo {
  id: string;
  name: string;
  tag: string;
}

// Module-level config, populated by configureI18n(). Empty until then.
let LOCALES: Record<string, LocaleDict> = {};
let FALLBACK = "en";
let LOCALE_INFO: LocaleInfo[] = [];

// Register the locale dictionaries + fallback and derive each locale's {name, tag}
// from its `_meta`. Call once at startup, before rendering. Replaces the old
// hardcoded `import hu/en` + `AVAILABLE_LOCALES` const.
export function configureI18n(locales: Record<string, LocaleDict>, opts?: { fallback?: string }): void {
  LOCALES = locales;
  FALLBACK = opts?.fallback ?? Object.keys(locales)[0] ?? "en";
  LOCALE_INFO = Object.entries(LOCALES).map(([id, d]) => ({
    id,
    name: d._meta.name,
    tag: d._meta.tag,
  }));
  // Re-apply the legacy migration now that the locales are known: at module load
  // (before this call) LOCALES was empty, so a stored legacy "tvbox.locale" could
  // not be validated. If nothing has been persisted/chosen yet (locale still
  // null), adopt the legacy value.
  if (useLocaleStore.getState().locale == null) {
    const legacy = legacyLocale();
    if (legacy) useLocaleStore.setState({ locale: legacy });
  }
}

// The registered locales as display rows (id + name + tag). Computed from the
// configured dictionaries; replaces the old `AVAILABLE_LOCALES` const.
export function availableLocales(): LocaleInfo[] {
  return LOCALE_INFO;
}

function lookup(dict: LocaleDict | undefined, path: string): string | undefined {
  if (!dict) return undefined;
  let node: unknown = dict;
  for (const part of path.split(".")) {
    if (node && typeof node === "object" && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function translate(locale: string, key: string, vars?: Record<string, string | number>): string {
  const hit = lookup(LOCALES[locale], key) ?? lookup(LOCALES[FALLBACK], key) ?? key;
  return interpolate(hit, vars);
}

// Resolve a manifest LocaleString to the active locale, with sensible fallback.
export function localize(value: LocaleString | undefined, locale: string): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return value[locale] ?? value[FALLBACK] ?? Object.values(value)[0] ?? "";
}

// migrate the pre-store raw value ("tvbox.locale" = "hu") so we don't re-prompt
function legacyLocale(): string | null {
  try {
    const v = localStorage.getItem("tvbox.locale");
    return v && LOCALES[v] ? v : null;
  } catch {
    return null;
  }
}

interface LocaleState {
  locale: string | null; // null until chosen (first launch)
  setLocale: (id: string) => void;
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      locale: legacyLocale(),
      setLocale: (id) => {
        if (!LOCALES[id]) return;
        try {
          document.documentElement.lang = id;
        } catch {
          /* ssr/no-dom */
        }
        set({ locale: id });
      },
    }),
    { name: "tvbox.i18n", partialize: (s) => ({ locale: s.locale }) },
  ),
);

export interface I18n {
  locale: string | null;
  tag: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  loc: (value: LocaleString | undefined) => string;
  setLocale: (id: string) => void;
}

export function useI18n(): I18n {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const active = locale ?? FALLBACK;
  return useMemo<I18n>(
    () => ({
      locale,
      tag: LOCALES[active]?._meta.tag ?? active,
      t: (key, vars) => translate(active, key, vars),
      loc: (v) => localize(v, active),
      setLocale,
    }),
    [locale, active, setLocale],
  );
}
