// Single import site for spatial-navigation init, so apps don't each depend on
// the norigin package path directly.
import { init, GetBoundingClientRectAdapter } from "@noriginmedia/norigin-spatial-navigation";

type InitOptions = Parameters<typeof init>[0];

// Start spatial navigation, measuring focusables with `getBoundingClientRect`.
//
// The library's default adapter measures with `offsetTop` / `offsetHeight`, which
// are ROUNDED to whole pixels, and its direction filter is strict: going down, a
// sibling only counts if `sibling.top >= current.bottom`. Our rows are sized in
// vh, so their real boxes touch at fractional coordinates - and rounding turns a
// touch into a one-pixel overlap. Measured on the box: a settings row at
// top 312.688 height 71.516 became top 313 + height 72 = bottom 385, while the
// row starting at 384.203 became top 384. 384 >= 385 is false, so that row was
// dropped from every candidate list and could not be reached with the D-pad at
// all - in either direction. Whether a given pair rounds badly depends on where
// the list happens to fall, which is why it read as "sometimes skips a row".
//
// This adapter uses the fractional rect, so touching rows stay touching. Note the
// two are not interchangeable in general: rects are viewport-relative and include
// transforms, where offsets are document-relative and ignore them. That is fine
// here because the library re-measures every sibling that is more than one frame
// old before each move, so a whole navigation is decided on one instant's numbers.
export function initSpatialNavigation(options?: InitOptions): void {
  init({ layoutAdapter: GetBoundingClientRectAdapter, ...options });
}
