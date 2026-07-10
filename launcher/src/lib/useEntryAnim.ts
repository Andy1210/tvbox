import { useEffect, useState, type CSSProperties } from "react";

// Shared ~150ms entry animation for screen swaps and full-screen overlays:
// opacity 0 -> 1 + scale 0.99 -> 1, ease-out. Opacity/transform only, so it
// stays on the Pi's compositor fast path. It runs once per MOUNT: the state
// starts hidden and a double rAF flips it after the first frame committed
// (same trick as Ambient's crossfade - without the committed opacity-0 frame
// the CSS transition never plays and the swap stays hard). Re-renders after
// that just keep returning the settled style, so the animation never replays.
//
// Deliberately NO exit animation - unmounts stay instant so overlay close /
// focus-restore semantics are untouched.
//
// Once entered, transform is "none" (not "scale(1)"): a transformed ancestor
// becomes the containing block for position:fixed descendants, and overlays
// (PowerMenu, pickers, Ambient) opened later from inside an animated screen
// must keep the viewport as their containing block. The transient 0.99 scale
// is uniform over the whole subtree, so relative focusable geometry (what
// norigin's spatial nav measures during the initial setFocus) is preserved.
export function useEntryAnim(): CSSProperties {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);
  return {
    opacity: entered ? 1 : 0,
    transform: entered ? "none" : "scale(0.99)",
    transition: "opacity 150ms ease-out, transform 150ms ease-out",
  };
}
