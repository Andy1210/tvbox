import { describe, expect, it } from "vitest";
import { translate, localize, AVAILABLE_LOCALES } from "./i18n";

describe("translate", () => {
  it("resolves dotted keys per locale", () => {
    expect(translate("hu", "home.apps")).toBe("Alkalmazások");
    expect(translate("en", "home.apps")).toBe("Apps");
  });

  it("interpolates variables", () => {
    expect(translate("en", "home.comingSoon", { name: "Live TV" })).toBe("Live TV - coming soon");
    expect(translate("hu", "home.comingSoon", { name: "Élő TV" })).toBe("Élő TV - hamarosan elérhető");
  });

  it("falls back to English then to the key itself", () => {
    expect(translate("hu", "nope.missing")).toBe("nope.missing");
  });
});

describe("localize", () => {
  it("returns plain strings unchanged", () => {
    expect(localize("Plex", "hu")).toBe("Plex");
  });

  it("picks the locale entry with English fallback", () => {
    expect(localize({ hu: "Élő TV", en: "Live TV" }, "hu")).toBe("Élő TV");
    expect(localize({ hu: "Élő TV", en: "Live TV" }, "de")).toBe("Live TV");
    expect(localize(undefined, "hu")).toBe("");
  });
});

describe("AVAILABLE_LOCALES", () => {
  it("exposes hu and en with display names", () => {
    const ids = AVAILABLE_LOCALES.map((l) => l.id).sort();
    expect(ids).toEqual(["en", "hu"]);
    expect(AVAILABLE_LOCALES.find((l) => l.id === "hu")?.name).toBe("Magyar");
  });
});
