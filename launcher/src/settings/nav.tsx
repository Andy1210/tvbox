import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";

// The settings screen is a category rail plus a stack of pages. A category's own
// rows are depth 0; every drill-down pushes a page on top.
//
// Two things are deliberately NOT the call site's problem, because getting either
// wrong is invisible until someone is holding a remote:
//
//  - **Where Back returns to.** push() records the focus key that was current at
//    the moment of the push, and pop() puts focus back on it. A row therefore
//    never has to name itself, and a row that has moved (a Wi-Fi list that
//    rescanned underneath) falls back to the page's own default focus rather than
//    focusing nothing.
//  - **Only the top level is focusable.** Levels below a pushed page are
//    UNMOUNTED, not hidden: a display:none subtree stays in the spatial-nav tree,
//    so the D-pad would happily focus rows nobody can see. Unmounting is also one
//    less layer for the Pi to composite.
//
// A pushed page MUST own the state it shows. The level below it is unmounted, so
// the closure inside `render` is frozen at the moment of the push: a page handed
// its parent's data would render that snapshot forever, and a parent handed a
// refresh callback would be setting state on a component that is no longer there.
// Read what you need on mount and write it yourself; the parent re-reads when it
// comes back, because popping remounts it.
//
// A snapshot passed for DISPLAY only is fine (a scan result's signal strength),
// and is the one exception - it cannot go stale in a way that misleads, because
// the page cannot change it either.
export interface PushedPage {
  // Identity for React's key, and the prefix every focus key inside the page
  // carries, so two pages may use the same row ids without colliding.
  id: string;
  title: string;
  // Cover the rail as well. For a page that needs the full width (a grid, the
  // store's screenshots), not as a way to get more room for a list.
  wide?: boolean;
  render: () => ReactNode;
}

interface StackEntry extends PushedPage {
  returnFocus: string;
}

interface SettingsNav {
  push: (page: PushedPage) => void;
  pop: () => void;
  depth: number;
  // Where Back wants the focus to land, handed to the page that mounts after a pop.
  // It is CONSUMED by that page, which is what keeps this a single decision: the
  // page then either restores it or falls back to its own default focus. Two
  // independent things trying to place the focus after a pop is a race, and it
  // resolves differently depending on how fast the box answered.
  takePendingFocus: () => string | null;
}

const NavContext = createContext<SettingsNav>({
  push: () => {},
  pop: () => {},
  depth: 0,
  takePendingFocus: () => null,
});

export const useSettingsNav = (): SettingsNav => useContext(NavContext);

export function SettingsNavProvider({ children }: { children: (stack: StackEntry[]) => ReactNode }): ReactNode {
  const [stack, setStack] = useState<StackEntry[]>([]);
  const pendingFocus = useRef<string | null>(null);
  // Mirrors the stack so pop() can read the top without the state updater having to
  // do it. An updater must stay pure - React may call it twice - and arming the
  // focus restore is a side effect.
  const stackRef = useRef<StackEntry[]>(stack);
  stackRef.current = stack;

  const push = useCallback((page: PushedPage) => {
    setStack((s) => [...s, { ...page, returnFocus: getCurrentFocusKey() }]);
  }, []);

  const pop = useCallback(() => {
    const top = stackRef.current[stackRef.current.length - 1];
    if (top?.returnFocus) pendingFocus.current = top.returnFocus;
    setStack((s) => s.slice(0, -1));
  }, []);

  const takePendingFocus = useCallback(() => {
    const key = pendingFocus.current;
    pendingFocus.current = null;
    return key;
  }, []);

  // depth is read by the rail (to stand down) and by pages, so it belongs in the
  // context rather than being derived at each call site.
  const nav = useMemo(
    () => ({ push, pop, depth: stack.length, takePendingFocus }),
    [push, pop, stack.length, takePendingFocus],
  );

  return <NavContext.Provider value={nav}>{children(stack)}</NavContext.Provider>;
}
