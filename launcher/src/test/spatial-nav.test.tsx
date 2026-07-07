import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton } from "../components/FocusButton";
import { setupRemote, place, placeRow, placeCol, remote, setFocus, getCurrentFocusKey } from "./remote";

// Exercises the D-pad navigation the whole launcher is built on: arrow keys move
// focus between real FocusButtons the way the CEC remote drives them, Enter fires
// the focused item, focus stops at edges, a modal traps focus, and focus crosses
// between grouped panes (the Settings sidebar/content shape). Uses the real
// spatial-nav primitives (FocusContext + useFocusable + FocusButton), so a
// regression in any of them surfaces here.

setupRemote();

function Group({ focusKey, children }: { focusKey: string; children: React.ReactNode }) {
  const { ref, focusKey: fk } = useFocusable({ focusKey });
  return (
    <FocusContext.Provider value={fk}>
      <div ref={ref}>{children}</div>
    </FocusContext.Provider>
  );
}

describe("horizontal menu", () => {
  const onC = vi.fn();
  beforeEach(() => {
    onC.mockClear();
    const { getByText } = render(
      <Group focusKey="menu">
        <FocusButton focusKey="a" onEnter={() => {}}>
          A
        </FocusButton>
        <FocusButton focusKey="b" onEnter={() => {}}>
          B
        </FocusButton>
        <FocusButton focusKey="c" onEnter={onC}>
          C
        </FocusButton>
      </Group>,
    );
    placeRow([getByText("A"), getByText("B"), getByText("C")]);
    act(() => setFocus("a"));
  });

  it("right/left walk the row", () => {
    expect(getCurrentFocusKey()).toBe("a");
    remote.right();
    expect(getCurrentFocusKey()).toBe("b");
    remote.right();
    expect(getCurrentFocusKey()).toBe("c");
    remote.left();
    expect(getCurrentFocusKey()).toBe("b");
  });

  it("stops at the edges instead of wrapping", () => {
    remote.left(); // already leftmost
    expect(getCurrentFocusKey()).toBe("a");
    remote.right();
    remote.right();
    remote.right(); // past the rightmost
    expect(getCurrentFocusKey()).toBe("c");
  });

  it("up/down do nothing in a single row", () => {
    remote.down();
    remote.up();
    expect(getCurrentFocusKey()).toBe("a");
  });

  it("OK fires the focused item only", () => {
    remote.right();
    remote.right();
    remote.ok();
    expect(onC).toHaveBeenCalledTimes(1);
    remote.left();
    remote.ok(); // B has no handler; C must not fire again
    expect(onC).toHaveBeenCalledTimes(1);
  });
});

describe("vertical menu", () => {
  it("down/up walk the column", () => {
    const { getByText } = render(
      <Group focusKey="col">
        <FocusButton focusKey="v0" onEnter={() => {}}>
          Wifi
        </FocusButton>
        <FocusButton focusKey="v1" onEnter={() => {}}>
          Display
        </FocusButton>
        <FocusButton focusKey="v2" onEnter={() => {}}>
          Audio
        </FocusButton>
      </Group>,
    );
    placeCol([getByText("Wifi"), getByText("Display"), getByText("Audio")]);
    act(() => setFocus("v0"));
    remote.down();
    expect(getCurrentFocusKey()).toBe("v1");
    remote.down();
    expect(getCurrentFocusKey()).toBe("v2");
    remote.down();
    expect(getCurrentFocusKey()).toBe("v2"); // bottom edge
    remote.up();
    expect(getCurrentFocusKey()).toBe("v1");
  });
});

describe("2D grid", () => {
  it("navigates in all four directions", () => {
    const { getByText } = render(
      <Group focusKey="grid">
        {["1", "2", "3", "4", "5", "6"].map((n) => (
          <FocusButton key={n} focusKey={"g" + n} onEnter={() => {}}>
            {n}
          </FocusButton>
        ))}
      </Group>,
    );
    // 3 columns x 2 rows: 1 2 3 / 4 5 6
    const cell = (n: string) => getByText(n);
    placeRow(["1", "2", "3"].map(cell), { originY: 0 });
    placeRow(["4", "5", "6"].map(cell), { originY: 64 });
    act(() => setFocus("g1"));
    remote.right();
    expect(getCurrentFocusKey()).toBe("g2"); // 1 -> 2
    remote.down();
    expect(getCurrentFocusKey()).toBe("g5"); // 2 -> 5
    remote.left();
    expect(getCurrentFocusKey()).toBe("g4"); // 5 -> 4
    remote.up();
    expect(getCurrentFocusKey()).toBe("g1"); // 4 -> 1
  });
});

describe("modal focus boundary", () => {
  it("traps focus inside the modal even when a target exists outside", () => {
    function Modal({ focusKey, children }: { focusKey: string; children: React.ReactNode }) {
      const { ref, focusKey: fk } = useFocusable({ focusKey, isFocusBoundary: true });
      return (
        <FocusContext.Provider value={fk}>
          <div ref={ref}>{children}</div>
        </FocusContext.Provider>
      );
    }
    const { getByText } = render(
      <Group focusKey="root">
        <FocusButton focusKey="outside" onEnter={() => {}}>
          Outside
        </FocusButton>
        <Modal focusKey="modal">
          <FocusButton focusKey="m0" onEnter={() => {}}>
            Cancel
          </FocusButton>
          <FocusButton focusKey="m1" onEnter={() => {}}>
            OK
          </FocusButton>
        </Modal>
      </Group>,
    );
    // A reachable button sits far to the right; the modal (and its container)
    // is a boundary at the left, so the geometry unambiguously offers a target
    // to the right and only the boundary can stop the move.
    place(getByText("Outside"), 400, 0);
    place(getByText("Cancel").parentElement!, 0, 0, 200, 40); // modal container
    place(getByText("Cancel"), 0, 0);
    place(getByText("OK"), 100, 0);
    act(() => setFocus("m0"));
    remote.right();
    expect(getCurrentFocusKey()).toBe("m1");
    remote.right(); // would reach "Outside" without the boundary
    expect(getCurrentFocusKey()).toBe("m1");
    expect(getCurrentFocusKey()).not.toBe("outside");
  });
});

describe("grouped panes (Settings sidebar <-> content)", () => {
  it("crosses from the sidebar column into the content pane and back", () => {
    const { getByText } = render(
      <Group focusKey="settings">
        <Group focusKey="sidebar">
          <FocusButton focusKey="cat-net" onEnter={() => {}}>
            Network
          </FocusButton>
          <FocusButton focusKey="cat-disp" onEnter={() => {}}>
            Screen
          </FocusButton>
        </Group>
        <Group focusKey="content">
          <FocusButton focusKey="opt-a" onEnter={() => {}}>
            Toggle
          </FocusButton>
          <FocusButton focusKey="opt-b" onEnter={() => {}}>
            Save
          </FocusButton>
        </Group>
      </Group>,
    );
    // Sidebar column on the left, content pane on the right. The group
    // containers need rects too - cross-pane nav resolves at the parent level.
    place(getByText("Network").parentElement!, 0, 0, 120, 140); // sidebar container
    place(getByText("Toggle").parentElement!, 300, 0, 120, 140); // content container
    place(getByText("Network"), 0, 0);
    place(getByText("Screen"), 0, 64);
    place(getByText("Toggle"), 300, 0);
    place(getByText("Save"), 300, 64);
    act(() => setFocus("cat-net"));

    remote.right(); // sidebar -> content, lands on the closest item
    expect(getCurrentFocusKey()).toBe("opt-a");
    remote.down();
    expect(getCurrentFocusKey()).toBe("opt-b");
    remote.left(); // content -> sidebar
    expect(["cat-net", "cat-disp"]).toContain(getCurrentFocusKey());
  });
});
