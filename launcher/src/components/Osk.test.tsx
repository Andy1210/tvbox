import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { Osk, OSK_LAYOUTS, oskLayers, layoutKey } from "./Osk";
import { setupRemote, placeRow, remote, setFocus } from "../test/remote";

// The on-screen keyboard modal (IPTV URLs, credentials). Driven by the D-pad:
// arrow to a key, OK to type it. Covers arrow typing, Shift case-toggle, the
// movable caret with mid-string delete, ✓ done, and remote-Back cancel.

setupRemote();

describe("Osk", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("types by arrowing across the keyboard and confirms with done", async () => {
    const onDone = vi.fn();
    const { getByText } = render(<Osk title="URL" layout="" onDone={onDone} onCancel={() => {}} />);
    // The home row a-s-d; caret/typing needs geometry only for the arrow moves.
    placeRow([getByText("a"), getByText("s"), getByText("d")]);
    await setFocus("osk-2-0"); // 'a'
    await remote.ok();
    await remote.right();
    await remote.ok(); // 's'
    await remote.right();
    await remote.ok(); // 'd'
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("asd");
  });

  it("Shift toggles the next letter to uppercase", async () => {
    const onDone = vi.fn();
    render(<Osk title="URL" layout="" onDone={onDone} onCancel={() => {}} />);
    await setFocus("osk-2-0");
    await remote.ok(); // 'a'
    await setFocus("osk-shift");
    await remote.ok(); // caps on
    await setFocus("osk-2-0");
    await remote.ok(); // 'A'
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("aA");
  });

  it("moves the caret and deletes mid-string", async () => {
    const onDone = vi.fn();
    render(<Osk title="URL" layout="" initial="asd" onDone={onDone} onCancel={() => {}} />);
    await setFocus("osk-left");
    await remote.ok();
    await remote.ok(); // caret: end(3) -> 1, i.e. between 'a' and 's'
    await setFocus("osk-del");
    await remote.ok(); // deletes the char before the caret ('a')
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("sd");
  });

  it("caret right then delete removes a later character", async () => {
    const onDone = vi.fn();
    render(<Osk title="URL" layout="" initial="ab" onDone={onDone} onCancel={() => {}} />);
    // Caret starts at end (2). Move left twice to the very start, right once to
    // sit between 'a' and 'b', then delete removes 'a'.
    await setFocus("osk-left");
    await remote.ok();
    await remote.ok(); // caret 0
    await setFocus("osk-right");
    await remote.ok(); // caret 1
    await setFocus("osk-del");
    await remote.ok(); // removes 'a' -> "b"
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("b");
  });

  it("the symbol layer types what no amount of Shift on QWERTY can", async () => {
    // There was no comma anywhere on this keyboard, and no accented letter - so
    // a search box was unusable in Hungarian and a sentence could not be typed.
    const onDone = vi.fn();
    const { getByText } = render(<Osk title="Search" layout="hu" onDone={onDone} onCancel={() => {}} />);
    await setFocus("osk-layer");
    await remote.ok(); // -> symbols
    await setFocus("osk-1-0");
    await remote.ok(); // 'á'
    await setFocus("osk-1-9");
    await remote.ok(); // ','
    await setFocus("osk-2-0");
    await remote.ok(); // ';'
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("á,;");
    expect(getByText("abc")).toBeTruthy(); // the key now says where it goes back to
  });

  it("Shift on the symbol layer gives the accents a capital", async () => {
    const onDone = vi.fn();
    render(<Osk title="Search" layout="hu" onDone={onDone} onCancel={() => {}} />);
    await setFocus("osk-layer");
    await remote.ok();
    await setFocus("osk-shift");
    await remote.ok();
    await setFocus("osk-1-4");
    await remote.ok(); // 'Ö'
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("Ö");
  });

  it("every layer of every keyboard layout has the same shape", () => {
    // Keys are focused BY POSITION (`osk-<row>-<col>`), so a layer with a shorter
    // row would drop the focused key and leave the D-pad with nowhere to be - the
    // one state a remote cannot get out of. Asserted on the layouts themselves:
    // the focus keys are not in the DOM, so there is nothing to count there.
    const shape = (rows: string[]) => rows.map((r) => [...r].length);
    const base = shape(oskLayers("hu").ROWS_LOWER);
    // Every shipped layout, plus the fallback an unknown one gets.
    for (const layout of [...OSK_LAYOUTS, "us", "", "zz"]) {
      const layers = oskLayers(layout);
      for (const [name, rows] of Object.entries(layers)) {
        expect(shape(rows), `${layout}/${name}`).toEqual(base);
        for (const row of rows) {
          expect(new Set([...row]).size, `${layout}/${name}: duplicate in "${row}"`).toBe([...row].length);
        }
      }
    }
  });

  it("the letters come from the box's keyboard layout, not from a guess", () => {
    // Baking one language into a keyboard every app shares would be choosing a
    // country for everyone who runs this; the setting already exists.
    expect(oskLayers("hu").ROWS_SYM[1]).toContain("ő");
    expect(oskLayers("fr").ROWS_SYM[1]).toContain("ç");
    expect(oskLayers("pl").ROWS_SYM[1]).toContain("ł");
    expect(oskLayers("hu").ROWS_SYM[1]).not.toContain("ç");
    // An unknown layout still gains the punctuation it never had.
    expect(oskLayers("us").ROWS_SYM[1]).toContain(",");
    expect(oskLayers("us").ROWS_SYM[1]).not.toContain("á");
  });

  it("a layout string with a variant or a list still resolves", () => {
    // localectl reports things like "hu(101_qwertz_comma_dead)" or "us,hu".
    expect(layoutKey("hu(101_qwertz_comma_dead)")).toBe("hu");
    expect(layoutKey("us,hu")).toBe("us");
    expect(layoutKey("  HU  ")).toBe("hu");
    expect(layoutKey(null)).toBe("");
    expect(oskLayers("hu(101_qwertz_comma_dead)").ROWS_SYM[1]).toContain("ő");
  });

  it("switching layers really swaps the faces", async () => {
    const { getByText, queryByText } = render(<Osk title="URL" layout="hu" onDone={() => {}} onCancel={() => {}} />);
    expect(getByText("q")).toBeTruthy();
    await setFocus("osk-layer");
    await remote.ok();
    expect(queryByText("q")).toBeNull();
    expect(getByText("á")).toBeTruthy();
    await setFocus("osk-layer");
    await remote.ok();
    expect(getByText("q")).toBeTruthy();
    expect(queryByText("á")).toBeNull();
  });

  it("remote Back cancels", async () => {
    const onCancel = vi.fn();
    render(<Osk title="URL" layout="" onDone={() => {}} onCancel={onCancel} />);
    await remote.back();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
