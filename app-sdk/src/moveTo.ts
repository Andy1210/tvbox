// Moving a long list without repainting it.
//
// Shared rather than per-app because the measurement behind it is about this BOX,
// not about any one app: a scrolling container whose contents are being rebuilt
// costs the GPU process five times what the same distance costs as a composited
// transform. Written for the media client, then wanted verbatim by the Xbox Cloud
// Gaming app, which is when it moved here.
//
// A native scroll of a virtualised list is expensive on this hardware: measured
// on the box, animating one row of the library cost the GPU process 111-118 ms
// against 18-23 ms for the same distance jumped. That is not what the hardware
// can do - Plex's own client animates its grid on the same box and reads as
// smooth - it is what a scrolling container costs when its contents are being
// rebuilt underneath it.
//
// Plex's technique, read out of its bundle: it does not scroll at all. There is
// no `scrollIntoView` and no `scroll-behavior` anywhere in it. Positions are
// `translateX/translateY`, and movement is a Web Animations API keyframe pair
// on `transform` with an explicit duration:
//
//   keyframes: [{transform:"translate(0vw, 0vh)"}, {transform:"translate(Xvw, Yvh)"}]
//   options:   {delay, duration, fill: "forwards"}
//
// A transform animation runs on the compositor: no layout, no paint, no raster.
// This is the same idea, in pixels rather than viewport units, because the
// distances here come from a measured row height.

/** Long enough to read as movement, short enough not to be a wait. */
export const MOVE_MS = 180;

export interface Mover {
  /** Where the content currently sits, in px (positive scrolls content up). */
  readonly at: number;
  /** Move there. `animate: false` for a destination somebody already chose. */
  to(px: number, animate: boolean): void;
}

/**
 * Drive one element's translation.
 *
 * The offset is kept here rather than in React state on purpose: it changes on
 * every press and nothing renders differently because of it, so putting it in
 * state would re-render the whole grid to move a layer the compositor is
 * already moving.
 */
export function createMover(axis: "x" | "y"): Mover & { attach(el: HTMLElement | null): void } {
  let node: HTMLElement | null = null;
  let current = 0;
  let animation: Animation | null = null;

  const transform = (px: number): string => (axis === "y" ? `translateY(${-px}px)` : `translateX(${-px}px)`);

  return {
    get at() {
      return current;
    },
    attach(el) {
      node = el;
      if (el) {
        el.style.transform = transform(current);
        // Where the layer sits, in the DOM. Same reason a focusable carries
        // `data-sfocus`: a check about movement needs something to read, and the
        // transform string is the thing being tested rather than a witness to it.
        el.dataset.at = String(current);
      }
    },
    to(px, animate) {
      const next = Math.max(0, Math.round(px));
      if (!node || next === current) {
        current = next;
        if (node) node.dataset.at = String(current);
        return;
      }
      const from = current;
      current = next;
      node.dataset.at = String(current);

      // The previous animation is cancelled rather than left to finish: two
      // overlapping transform animations on one element compose, and a held
      // arrow would otherwise send the list somewhere neither press asked for.
      animation?.cancel();
      if (!animate) {
        animation = null;
        node.style.transform = transform(next);
        return;
      }
      // `fill: "forwards"` and then the style, so the element keeps the
      // position after the animation is discarded - an animation that is
      // cancelled later must not snap the list back to where it started.
      animation = node.animate([{ transform: transform(from) }, { transform: transform(next) }], {
        duration: MOVE_MS,
        easing: "ease-out",
        fill: "forwards",
      });
      node.style.transform = transform(next);
    },
  };
}

/**
 * Stop a clipping box from being scrolled behind the mover's back.
 *
 * `overflow: hidden` clips but stays SCROLLABLE programmatically, and the browser
 * scrolls the nearest such ancestor whenever focus lands on something outside it -
 * as does any `scrollIntoView`, which the SDK's own FocusButton calls on focus. So
 * a page moved by a transform ends up with two offsets: the one the mover knows
 * about and a native one nothing here can see.
 *
 * Measured: the transform read `matrix(1, 0, 0, 1, 0, 0)` while the column sat
 * 238 px above its window, and the row looked cropped at the top for no reason the
 * transform could explain.
 *
 * Returns a ref callback to put on the clipping element.
 */
export function pinScroll(): (el: HTMLElement | null) => void {
  let node: HTMLElement | null = null;
  const reset = () => {
    if (!node) return;
    if (node.scrollTop !== 0) node.scrollTop = 0;
    if (node.scrollLeft !== 0) node.scrollLeft = 0;
  };
  return (el) => {
    if (node) node.removeEventListener("scroll", reset);
    node = el;
    if (el) {
      el.addEventListener("scroll", reset);
      reset();
    }
  };
}

/**
 * Where a window has to sit for a band to be inside it.
 *
 * "Nearest" in the sense `scrollIntoView` means it: already inside, do not
 * move. The padding keeps a row off the very edge, which on a television is
 * inside the overscan of some sets.
 */
export function nearest(opts: {
  at: number;
  viewport: number;
  start: number;
  size: number;
  padStart?: number;
  padEnd?: number;
  max: number;
}): number {
  const { at, viewport, start, size, max } = opts;
  const padStart = opts.padStart ?? 0;
  const padEnd = opts.padEnd ?? 0;
  let next = at;
  if (start - padStart < at) next = start - padStart;
  else if (start + size + padEnd > at + viewport) next = start + size + padEnd - viewport;
  return Math.max(0, Math.min(next, Math.max(0, max - viewport)));
}
