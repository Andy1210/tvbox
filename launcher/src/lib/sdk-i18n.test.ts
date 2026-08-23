import { describe, expect, it, beforeEach } from "vitest";
import { configureI18n, useLocaleStore } from "@sdk/i18n";

// `document.documentElement.lang` is set by the SDK, and only `setLocale` used to
// do it - so a page that merely LOADS with a locale already persisted kept whatever
// its index.html declared. Every app here declares "en".
const DICTS = {
  en: { _meta: { name: "English", tag: "en-GB" }, hello: "Hello" },
  hu: { _meta: { name: "Magyar", tag: "hu-HU" }, hello: "Szia" },
};

describe("configureI18n and the document language", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    useLocaleStore.setState({ locale: null });
    try {
      localStorage.clear();
    } catch {
      /* no dom storage */
    }
  });

  it("applies the PERSISTED locale to the document, without anyone picking one", () => {
    useLocaleStore.setState({ locale: "hu" });
    configureI18n(DICTS, { fallback: "en" });
    expect(document.documentElement.lang).toBe("hu-HU");
  });

  it("falls back when nothing is persisted, rather than leaving the page's own guess", () => {
    configureI18n(DICTS, { fallback: "hu" });
    expect(document.documentElement.lang).toBe("hu-HU");
  });

  it("writes the BCP-47 TAG, not our locale id", () => {
    // `lang` is a language tag; the two differ for every locale whose _meta says so,
    // and it is the tag that Intl, :lang() and an Accept-Language header want.
    useLocaleStore.setState({ locale: "en" });
    configureI18n(DICTS, { fallback: "en" });
    expect(document.documentElement.lang).toBe("en-GB");
  });

  it("still follows a locale someone picks afterwards", () => {
    configureI18n(DICTS, { fallback: "en" });
    useLocaleStore.getState().setLocale("hu");
    expect(document.documentElement.lang).toBe("hu-HU");
  });

  it("ignores a pick this host does not ship", () => {
    configureI18n(DICTS, { fallback: "en" });
    useLocaleStore.getState().setLocale("de");
    expect(document.documentElement.lang).toBe("en-GB");
  });
});
