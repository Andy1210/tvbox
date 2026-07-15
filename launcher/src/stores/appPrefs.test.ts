import { describe, expect, it } from "vitest";
import { orderIds } from "./appPrefs";

// byName: plain alphabetical, so the fallback path is easy to assert.
const byName = (a: string, b: string) => a.localeCompare(b);

describe("orderIds", () => {
  it("puts listed ids first, in the saved order", () => {
    expect(orderIds(["a", "b", "c"], ["c", "a"], byName)).toEqual(["c", "a", "b"]);
  });

  it("sorts ids not in the order by name, after the listed ones", () => {
    // 'b' and 'd' are unlisted -> alphabetical, after the explicitly ordered 'c'
    expect(orderIds(["a", "b", "c", "d"], ["c"], byName)).toEqual(["c", "a", "b", "d"]);
  });

  it("falls back to name order when nothing is saved", () => {
    expect(orderIds(["b", "c", "a"], [], byName)).toEqual(["a", "b", "c"]);
  });

  it("ignores saved ids that aren't present", () => {
    expect(orderIds(["a", "b"], ["gone", "b"], byName)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const ids = ["b", "a"];
    orderIds(ids, [], byName);
    expect(ids).toEqual(["b", "a"]);
  });
});
