import { beforeAll, afterAll, afterEach } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { init, destroy, setFocus, getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";

// D-pad remote harness. On the box the CEC bridge turns TV-remote presses into
// arrow keys + Enter, which norigin-spatial-navigation maps to directional focus
// moves. norigin resolves the direction geometrically from getBoundingClientRect
// - but happy-dom has no layout engine and returns an all-zero rect for every
// element, so real navigation is impossible out of the box. We give each element
// a fake rect (assigned by the test via place()/placeGrid()) and point norigin at
// getBoundingClientRect, so a test lays its focusables out on a synthetic 2D plane
// and the arrow keys walk them exactly as they would on a TV.

type Rect = { x: number; y: number; w: number; h: number };
const rects = new WeakMap<Element, Rect>();
const ZERO: Rect = { x: 0, y: 0, w: 0, h: 0 };

// Place one focusable element at (x,y) with a size. The element is the node that
// carries the `ref` from useFocusable - for a FocusButton that is the button div
// itself, which Testing Library's getByText/getByRole hands you directly.
export function place(el: Element, x: number, y: number, w = 80, h = 40): void {
  rects.set(el, { x, y, w, h });
}

export interface GridOpts {
  cellW?: number;
  cellH?: number;
  gapX?: number;
  gapY?: number;
  originX?: number;
  originY?: number;
}

// Lay elements out row-major on a grid: rows[r][c] goes to cell (r,c). null holes
// are skipped (e.g. the PIN pad's empty bottom-right cell). Gaps keep cells from
// touching so the geometric midpoints are unambiguous.
export function placeGrid(rows: (Element | null)[][], opts: GridOpts = {}): void {
  const { cellW = 80, cellH = 40, gapX = 24, gapY = 24, originX = 0, originY = 0 } = opts;
  rows.forEach((row, r) =>
    row.forEach((el, c) => {
      if (el) place(el, originX + c * (cellW + gapX), originY + r * (cellH + gapY), cellW, cellH);
    }),
  );
}

export const placeRow = (els: (Element | null)[], opts: GridOpts = {}): void => placeGrid([els], opts);
export const placeCol = (els: (Element | null)[], opts: GridOpts = {}): void =>
  placeGrid(
    els.map((e) => [e]),
    opts,
  );

function fire(key: string, capture = false): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    if (!capture) window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  });
}

// The remote as the shell delivers it. Arrows + OK(Enter) go through norigin;
// Back is a plain Backspace that the shell preload synthesizes and useBackspace
// (a capture-phase listener) handles - norigin ignores it.
export const remote = {
  up: () => fire("ArrowUp"),
  down: () => fire("ArrowDown"),
  left: () => fire("ArrowLeft"),
  right: () => fire("ArrowRight"),
  ok: () => fire("Enter"),
  back: () => fire("Backspace"),
};

// Register the getBoundingClientRect stub + norigin init/teardown for a suite.
// Call once at the top of a test file (before describe). Focusables from an
// unmounted render are dropped by Testing Library's cleanup between tests.
export function setupRemote(): void {
  const proto = window.HTMLElement.prototype;
  const orig = proto.getBoundingClientRect;
  beforeAll(() => {
    proto.getBoundingClientRect = function (this: Element): DOMRect {
      const b = rects.get(this) ?? ZERO;
      return {
        x: b.x,
        y: b.y,
        width: b.w,
        height: b.h,
        left: b.x,
        top: b.y,
        right: b.x + b.w,
        bottom: b.y + b.h,
        toJSON: () => ({}),
      } as DOMRect;
    };
    init({ useGetBoundingClientRect: true });
  });
  afterEach(() => cleanup());
  afterAll(() => {
    destroy();
    proto.getBoundingClientRect = orig;
  });
}

export { setFocus, getCurrentFocusKey };
