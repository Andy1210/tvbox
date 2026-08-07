import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { SettingsPage } from "./SettingsPage";
import { Group, Note, Row } from "./Rows";
import { SettingsNavProvider, useSettingsNav } from "./nav";
import { setupRemote, remote, setFocus, flushFocus, getCurrentFocusKey } from "../test/remote";

// The two rules a remote-driven settings screen cannot be allowed to break, tested
// on the frame that enforces them rather than on any one page: there is always
// something focused, or the page scrolls; and Back puts the focus back where it came
// from. Every page in Settings inherits both from here, so this is the cheapest place
// to keep them honest.
setupRemote();

function Harness({ root }: { root: ReactNode }) {
  return (
    <SettingsNavProvider>
      {(stack) => {
        const top = stack[stack.length - 1];
        return top ? <div key={top.id}>{top.render()}</div> : root;
      }}
    </SettingsNavProvider>
  );
}

function LateRows() {
  const [rows, setRows] = useState<string[]>([]);
  // Most pages read the box over HTTP, so the first render has no rows at all. The
  // timer belongs in an effect, not in the render: rendering is not once, so a timer
  // started there is re-armed by every re-render - including the one its own setState
  // causes - which is both unlike the real pages and a source of flake.
  useEffect(() => {
    const id = setTimeout(() => setRows(["one", "two"]), 20);
    return () => clearTimeout(id);
  }, []);
  return (
    <SettingsPage id="late" title="Late">
      <Group>
        {rows.map((r) => (
          <Row key={r} id={r} label={r} onEnter={() => {}} />
        ))}
      </Group>
    </SettingsPage>
  );
}

function Pusher() {
  const nav = useSettingsNav();
  return (
    <SettingsPage id="root" title="Root">
      <Group>
        <Row id="first" label="First" onEnter={() => {}} />
        <Row
          id="second"
          label="Second"
          onEnter={() =>
            nav.push({
              id: "child",
              title: "Child",
              render: () => <ChildPage />,
            })
          }
        />
      </Group>
    </SettingsPage>
  );
}
function ChildPage() {
  const nav = useSettingsNav();
  return (
    <SettingsPage id="child" title="Child" onBack={nav.pop}>
      <Group>
        <Row id="only" label="Only" onEnter={() => {}} />
      </Group>
    </SettingsPage>
  );
}

describe("a settings page", () => {
  afterEach(() => cleanup());

  it("focuses its first row on entry", async () => {
    render(
      <SettingsPage id="p" title="P">
        <Group>
          <Row id="a" label="A" onEnter={() => {}} />
          <Row id="b" label="B" onEnter={() => {}} />
        </Group>
      </SettingsPage>,
    );
    await flushFocus();
    expect(getCurrentFocusKey()).toBe("p:a");
  });

  it("prefers the row that asked for it over document order", async () => {
    render(
      <SettingsPage id="p" title="P">
        <Group>
          <Row id="a" label="A" onEnter={() => {}} />
          <Row id="b" label="B" autoFocus onEnter={() => {}} />
        </Group>
      </SettingsPage>,
    );
    await flushFocus();
    expect(getCurrentFocusKey()).toBe("p:b");
  });

  it("focuses a row that only arrives once the box answers", async () => {
    render(<LateRows />);
    // The rows appear on a 20ms timer and the page's retry ticks every 60ms, so a
    // single fixed wait can land between the two. Settle in steps instead of picking
    // a number and hoping.
    for (let i = 0; i < 10 && getCurrentFocusKey() !== "late:one"; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
      await flushFocus();
    }
    expect(getCurrentFocusKey()).toBe("late:one");
  });

  it("scrolls itself with the arrows when it has nothing to focus", async () => {
    // The credits page is this: longer than the screen, nothing to press. Without the
    // fallback the D-pad would be dead and the bottom unreachable.
    const { container } = render(
      <SettingsPage id="prose" title="Prose">
        <Note>nothing focusable here</Note>
      </SettingsPage>,
    );
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy;
    await remote.down();
    expect(scrollBy).toHaveBeenCalled();
    expect(scrollBy.mock.calls[0][0].top).toBeGreaterThan(0);
    await remote.up();
    expect(scrollBy.mock.calls[1][0].top).toBeLessThan(0);
  });

  it("does not claim the arrows on a page that has rows", async () => {
    const { container } = render(
      <SettingsPage id="p" title="P">
        <Group>
          <Row id="a" label="A" onEnter={() => {}} />
        </Group>
      </SettingsPage>,
    );
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy;
    await flushFocus();
    await remote.down();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("gives the focus back to the row that opened a page when Back is pressed", async () => {
    render(<Harness root={<Pusher />} />);
    await flushFocus();
    await setFocus("root:second");
    await remote.ok();
    await flushFocus();
    expect(getCurrentFocusKey()).toBe("child:only"); // the pushed page took over
    await remote.back();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    await flushFocus();
    expect(getCurrentFocusKey()).toBe("root:second"); // not "root:first"
  });
});
