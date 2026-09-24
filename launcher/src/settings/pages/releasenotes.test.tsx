import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ReleaseNotes } from "./system";

describe("release notes", () => {
  it("draws bold headlines and bullets instead of the markdown for them", () => {
    const { container } = render(
      <p>
        <ReleaseNotes text={"- **Faster start.** The box boots quicker.\n- Plain line <b>x</b>"} />
      </p>,
    );
    expect(container.textContent).toBe("• Faster start. The box boots quicker.\n• Plain line <b>x</b>");
    expect(container.querySelectorAll("strong").length).toBe(1);
    expect(container.querySelector("strong")?.textContent).toBe("Faster start.");
    expect(container.querySelector("b")).toBeNull();
  });

  it("keeps a headline bold when the changelog wraps it onto a second line", () => {
    // The 3.11.5 entry as the changelog carries it, hard-wrapped.
    const hu = [
      "- **Frissen telepített dobozon megszólal a távirányító mikrofonja, és működnek a",
      "  Netflix/Prime gombjai.** Aki SD-kártyáról telepítette a dobozt, annál ez a",
      "  kettő eddig néma volt.",
      "- **Második.** Egy sor.",
    ].join("\n");
    const { container } = render(
      <p>
        <ReleaseNotes text={hu} />
      </p>,
    );
    const strong = [...container.querySelectorAll("strong")].map((e) => e.textContent);
    expect(strong).toEqual([
      "Frissen telepített dobozon megszólal a távirányító mikrofonja, és működnek a Netflix/Prime gombjai.",
      "Második.",
    ]);
    expect(container.textContent).toBe(
      "• Frissen telepített dobozon megszólal a távirányító mikrofonja, és működnek a Netflix/Prime gombjai." +
        " Aki SD-kártyáról telepítette a dobozt, annál ez a kettő eddig néma volt.\n• Második. Egy sor.",
    );
  });
});
