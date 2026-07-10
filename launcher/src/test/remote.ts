import { beforeAll, afterAll, afterEach } from "vitest";
import { act, cleanup } from "@testing-library/react";
import {
  init,
  destroy,
  setFocus as noriginSetFocus,
  getCurrentFocusKey,
  updateAllLayouts,
  type FocusableComponent,
  type FocusableComponentLayout,
} from "@noriginmedia/norigin-spatial-navigation";

// D-pad remote harness. On the box the CEC bridge turns TV-remote presses into
// arrow keys + Enter, which norigin-spatial-navigation maps to directional focus
// moves. norigin resolves the direction geometrically from each focusable's
// layout - but happy-dom has no layout engine, so every element measures as an
// all-zero rect and real navigation is impossible out of the box. We give each
// element a fake rect (assigned by the test via place()/placeGrid()) and hand
// norigin a custom layoutAdapter.measureLayout that reads it, so a test lays its
// focusables out on a synthetic 2D plane and the arrow keys walk them exactly as
// they would on a TV.
//
// Since norigin 3.2.1 the geometry hook is the layoutAdapter API (the old
// useGetBoundingClientRect flag is deprecated), measureLayout returns a Promise,
// and every focus mutation (key nav, setFocus, mount registration) runs through
// the library's async Scheduler - focus lands on a later microtask, not
// synchronously. That is why the key-press helpers and setFocus here are async:
// they dispatch, then drain the microtask queue inside act() so the focus (and
// the React state it flips) has settled before the test asserts. The drain is
// pure microtasks - the scheduler never touches timers - so it also works under
// vi.useFakeTimers().

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

// One iteration lets every microtask queued so far run; the scheduler's promise
// chains add a bounded handful of links per turn (measureLayout per sibling,
// smartNavigate recursion up the focus tree), so 200 turns settles any chain
// these tests can produce with a wide margin.
async function drainScheduler(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

// Flush pending focus work outside a key press - e.g. a component's own deferred
// focusSelf()/setFocus() kicked off by a timer or a resolved fetch.
export async function flushFocus(): Promise<void> {
  await act(async () => {
    await drainScheduler();
  });
}

async function fire(key: string): Promise<void> {
  await act(async () => {
    // Focusables get measured when they register at mount - BEFORE the test's
    // place() calls assign rects - and the library skips re-measuring siblings
    // whose layout is younger than its 16ms LAYOUT_STALE_TIME, so a press right
    // after render would navigate against stale all-zero layouts. Re-measure
    // everything against the harness rects before each press.
    updateAllLayouts();
    await drainScheduler();
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    await drainScheduler();
  });
}

// The remote as the shell delivers it. Arrows + OK(Enter) go through norigin;
// Back is a plain Backspace that the shell preload synthesizes and useBackspace
// (a capture-phase listener) handles - norigin ignores it. Await every press:
// focus resolves asynchronously (see the header comment).
export const remote = {
  up: (): Promise<void> => fire("ArrowUp"),
  down: (): Promise<void> => fire("ArrowDown"),
  left: (): Promise<void> => fire("ArrowLeft"),
  right: (): Promise<void> => fire("ArrowRight"),
  ok: (): Promise<void> => fire("Enter"),
  back: (): Promise<void> => fire("Backspace"),
};

// norigin's setFocus is scheduler-bound since 3.2.1 - this wrapper awaits the
// focus actually landing (and keeps the React updates inside act()).
export async function setFocus(focusKey: string): Promise<void> {
  await act(async () => {
    noriginSetFocus(focusKey);
    await drainScheduler();
  });
}

// Register the harness layoutAdapter + norigin init/teardown for a suite. Call
// once at the top of a test file (before describe). Focusables from an unmounted
// render are dropped by Testing Library's cleanup between tests. The partial
// layoutAdapter object is Object.assign-ed over the library's default web
// adapter, so key handling and DOM focus stay stock - only geometry is ours.
export function setupRemote(): void {
  beforeAll(() => {
    init({
      layoutAdapter: {
        measureLayout: async (component: FocusableComponent): Promise<FocusableComponentLayout> => {
          const node = component.node;
          const b = (node && rects.get(node)) ?? ZERO;
          return {
            node,
            x: b.x,
            y: b.y,
            width: b.w,
            height: b.h,
            left: b.x,
            top: b.y,
            right: b.x + b.w,
            bottom: b.y + b.h,
          };
        },
      },
    });
  });
  afterEach(() => cleanup());
  afterAll(() => destroy());
}

export { getCurrentFocusKey };
