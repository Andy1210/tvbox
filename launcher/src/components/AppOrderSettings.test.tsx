import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { Settings } from "./Settings";
import { setupRemote, remote, setFocus, getCurrentFocusKey } from "../test/remote";

setupRemote();

// Regression: the Apps panel has no static focusables - every row comes from
// fetchApps(). Settings focuses the panel before that resolves, so unless the
// load places focus explicitly, the D-pad can never enter the list. Surfaced
// on the demo build (mocked shell adds latency); a race on a real box.
const APPS = [
  { id: "beta", name: "Beta", type: "webclient", status: "ready", icon: "<svg viewBox='0 0 24 24'/>" },
  { id: "alpha", name: "Alpha", type: "webclient", status: "ready", icon: "<svg viewBox='0 0 24 24'/>" },
];

describe("AppOrderSettings focus placement", () => {
  let served: unknown[] = APPS;
  beforeEach(() => {
    served = APPS;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () => resolve(new Response(JSON.stringify(served), { headers: { "Content-Type": "application/json" } })),
            20,
          ),
        ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("focuses the first row once the slow app list arrives", async () => {
    render(<Settings onExit={() => {}} />);
    await setFocus("cat-apps");
    await remote.ok(); // open the Apps panel - fetchApps is still in flight
    await act(() => new Promise((r) => setTimeout(r, 60))); // fetch (20ms) resolves, rows render
    await act(() => new Promise((r) => setTimeout(r, 10))); // the focus-placement timeout flushes
    // first row by name order; focus lands on "move down" (an actionable control),
    // not the first row's disabled "move up"
    expect(getCurrentFocusKey()).toBe("apporder-down-alpha");
  });

  // A single row has no "move down" to land on, so focus falls through to the
  // other control in the row. That used to be a per-row hide button; it is now
  // Manage, and a focus key that no longer exists leaves the D-pad stuck on the
  // toggle above the list with the row unreachable.
  it("focuses the only row's Manage button when one app is installed", async () => {
    served = [APPS[0]];
    render(<Settings onExit={() => {}} />);
    await setFocus("cat-apps");
    await remote.ok();
    await act(() => new Promise((r) => setTimeout(r, 60)));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(getCurrentFocusKey()).toBe("apporder-manage-beta");
  });
});
