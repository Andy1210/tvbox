import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { updateAllLayouts, getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";
import { SharesPage } from "./shares";
import { setupRemote, remote, setFocus, place } from "../../test/remote";

// Walking the shares list with the D-pad.
//
// Written while chasing a report that up/down sometimes skips a row here, and it
// cannot reproduce that BY CONSTRUCTION: the cause was whole-pixel measurement on
// the box (see spatial-nav.test.ts), and this harness hands norigin exact rects.
// It is still worth keeping as a guard that the list is walkable at all - every
// row, in order, both ways.
setupRemote();

const SHARES = ["films", "series", "music", "photos", "backup"];

function stubShell() {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          rclone: true,
          max: 8,
          installing: false,
          shares: SHARES.map((name) => ({ name, host: "192.168.1.10", share: name, path: "", mounted: true })),
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
}

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));
const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-sfocus]")];

// Lay the rows out as a column. `shift` moves every row down by that much, which
// is what a group appearing above them - or a hint wrapping to a second line -
// does on a real page.
function layout(nodes: HTMLElement[], shift = 0) {
  let y = shift;
  for (const n of nodes) {
    const tall = (n.textContent || "").includes("192.168.1.10");
    const h = tall ? 96 : 60;
    place(n, 0, y, 900, h);
    y += h + 2;
  }
}

// Walk the whole list one way and report what was actually focused at each step,
// so a skipped row shows up as a gap in the sequence rather than as a count.
async function walk(keys: string[], dir: "down" | "up") {
  const order = dir === "down" ? keys : [...keys].reverse();
  await setFocus(order[0]);
  const seen = [order[0]];
  for (let i = 1; i < order.length; i++) {
    await (dir === "down" ? remote.down() : remote.up());
    seen.push(getCurrentFocusKey() || "(nowhere)");
  }
  return { seen, order };
}

describe("walking the shares list", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("visits every row when the measurements match the page", async () => {
    stubShell();
    const { container } = render(<SharesPage />);
    await settle();
    const nodes = rows(container);
    const keys = nodes.map((n) => n.dataset.sfocus!);
    expect(keys.length).toBeGreaterThan(SHARES.length);
    layout(nodes);
    await act(async () => await updateAllLayouts());

    const down = await walk(keys, "down");
    expect(down.seen, "going down skipped a row").toEqual(down.order);
    const up = await walk(keys, "up");
    expect(up.seen, "going up skipped a row").toEqual(up.order);
  });
});
