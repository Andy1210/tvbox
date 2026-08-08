import { describe, it, expect, vi, beforeEach } from "vitest";

// How focusables get measured, which decides whether the D-pad can reach a row.
//
// The bug this pins was found on the box, not here, and it cannot be reproduced
// here: happy-dom has no layout engine, so the test harness feeds norigin exact
// rects of its own (src/test/remote.ts) and every row is always reachable. On the
// box the library's DEFAULT adapter measures with offsetTop/offsetHeight - whole
// pixels - so two rows whose real boxes merely touch at a fractional coordinate
// round into a one-pixel overlap, and the strict `sibling.top >= current.bottom`
// filter drops the second row from every candidate list. Measured there: a row at
// top 312.688 height 71.516 (bottom 384.204) against the next at top 384.203
// became 385 against 384, and that row could not be focused from either side.
//
// So what is checked here is the wiring: that the app asks for the fractional
// adapter at all, and that a caller's own options still win.
const init = vi.fn();
vi.mock("@noriginmedia/norigin-spatial-navigation", () => ({
  init,
  GetBoundingClientRectAdapter: class Exact {},
}));

const { initSpatialNavigation } = await import("@sdk/spatial-nav");
const { GetBoundingClientRectAdapter } = await import("@noriginmedia/norigin-spatial-navigation");

describe("spatial navigation setup", () => {
  beforeEach(() => init.mockClear());

  it("measures with the fractional rect, not rounded offsets", () => {
    initSpatialNavigation({ debug: false });
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0][0].layoutAdapter).toBe(GetBoundingClientRectAdapter);
  });

  it("still takes it from a caller that wants a different one", () => {
    // The tests' own harness does exactly this - it hands norigin a synthetic
    // plane - so this default must never be the last word.
    const mine = { measureLayout: async () => ({}) };
    initSpatialNavigation({ layoutAdapter: mine } as never);
    expect(init.mock.calls[0][0].layoutAdapter).toBe(mine);
  });
});
