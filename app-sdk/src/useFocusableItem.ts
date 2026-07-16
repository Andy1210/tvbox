import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { useFocusable } from "@noriginmedia/norigin-spatial-navigation";

// D-pad focusable list/grid item. Owns the two things every focusable element
// otherwise repeats by hand: (1) merging the DOM ref with the spatial-nav ref
// (the fragile `as React.MutableRefObject` cast), and (2) scrolling into view when
// focused. Pass the same config you'd give `useFocusable`, plus optional
// scrollIntoView options - omit them for an always-visible control (e.g. a picker
// button) that shouldn't scroll. Returns a callback `ref` (no cast at call sites).
export function useFocusableItem<T extends HTMLElement = HTMLDivElement>(
  config?: Parameters<typeof useFocusable>[0],
  scroll?: ScrollIntoViewOptions,
) {
  const domRef = useRef<T | null>(null);
  const { ref: focusRef, focused, focusKey } = useFocusable(config);
  useEffect(() => {
    if (focused && scroll) domRef.current?.scrollIntoView(scroll);
    // only re-run on focus change; `scroll` is a per-call-site constant
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = useCallback(
    (el: T | null) => {
      domRef.current = el;
      (focusRef as MutableRefObject<T | null>).current = el;
    },
    [focusRef],
  );
  return { ref, focused, focusKey };
}
