import { useEffect, useRef, type ReactNode } from "react";
import {
  FocusContext,
  ROOT_FOCUS_KEY,
  doesFocusableExist,
  getCurrentFocusKey,
  setFocus,
  useFocusable,
} from "@noriginmedia/norigin-spatial-navigation";
import { useBackspace } from "../lib/useBackspace";
import { PageScope } from "./Rows";
import { useSettingsNav } from "./nav";

// The frame every settings page sits in, and the one place two remote-control
// rules are enforced so no page can forget them:
//
//  1. **Something is always focused, or the page scrolls.** On mount the page
//     focuses its default row (the one marked `autoFocus`, else the first). A page
//     whose content is prose with nothing to press - the credits list - would
//     otherwise be unreachable past the first screenful, so there the arrows
//     scroll the container instead. One or the other, never neither.
//  2. **A row that arrives late still gets the focus.** Most pages read the box
//     over HTTP, so the first render has no rows at all. The default-focus pass
//     therefore watches the subtree until it has something to focus, then stops
//     watching - a settings page mutates rarely, and the observer is gone before
//     anyone navigates.
//
// Focus keys are page-scoped: `SettingsPage` prefixes nothing itself, but every
// row built from Rows.tsx takes its page's id, so the same row id in two pages
// cannot collide (which is what makes Back's focus restore trustworthy).
const SCROLL_STEP = 0.35; // of the viewport height, per arrow press
// How long a page coming back from a Back press waits for the row that opened the
// pushed page to exist again. It normally reappears with the page's own data, but a
// row from a list that has changed underneath (a Wi-Fi network that dropped out of
// the scan) never will - and a page with nothing focused is a dead D-pad, so after
// this the page takes its own default instead.
const RESTORE_WAIT_MS = 1000;
// Retrying is not belt-and-braces, it is the main mechanism. A DOM observer alone
// misses the common case entirely: rows that are present in the FIRST render still
// take a moment to register with spatial navigation (its scheduler is async), so the
// first attempt finds the elements but `doesFocusableExist` says no - and then no
// further mutation ever arrives to trigger a second look. The page sits with nothing
// focused, the previous focus key has unmounted with the level below, and every
// arrow and OK press does nothing at all.
const FOCUS_RETRY_MS = 60;
const FOCUS_RETRY_FOR_MS = 4000; // long enough to cover a slow answer from the box

export function SettingsPage({
  id,
  title,
  subtitle,
  onBack,
  children,
  animate = "none",
  focusPolicy = "own",
  width = "list",
}: {
  // Prefix for every row's focus key on this page. Two pages may reuse a row id,
  // which is what keeps Back's focus restore unambiguous.
  id: string;
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  // Optional: a page whose data has not arrived renders its frame with nothing in
  // it, so the title and Back are there from the first frame instead of the screen
  // going blank while a fetch is in flight.
  children?: ReactNode;
  // "push" is a page entered deliberately (a drill-down): it slides in and its
  // top-level groups arrive one after another. The category pane uses "none" -
  // it re-renders on every move of the rail, and animating that is noise, not
  // polish.
  animate?: "none" | "push";
  // Who places the focus on this page.
  //
  // "own"    - the page's own rows (the default). It focuses one on mount and scrolls
  //            itself if it has none.
  // "rail"   - the category rail owns the D-pad and the user steps right into these
  //            rows. The page must NOT grab focus (it would fight the rail) and must
  //            NOT claim the arrows (its scroll handler would swallow the presses that
  //            move the rail).
  // "legacy" - the page wraps a screen that brings its OWN focusables and does not
  //            mark them (the store, the app-order grid, the remap screen, the
  //            timezone and keymap pickers). Those cannot be found by looking for
  //            marked rows, so the page becomes a focus CONTAINER and the focus is put
  //            on the container - spatial navigation then descends to its first child
  //            by itself. Without this the page opens with nothing focused and only
  //            Back works, which is how Backup, Remote buttons and the pickers were
  //            unreachable with the remote.
  focusPolicy?: "own" | "rail" | "legacy";
  // "list" caps the content at a readable width. A settings row is a label on the
  // left and its value on the right, and across the full pane those two end up so
  // far apart that pairing them takes a moment - which is exactly the moment a
  // 10-foot UI does not have. "full" is for a page that brought its own layout (the
  // store's catalogue, the app-order grid) and needs the width.
  width?: "list" | "full";
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const focusedOnce = useRef(false);
  // Set up by the effect below, called after every commit by the one after it.
  const scheduleRef = useRef<() => void>(() => {});
  // Only a "legacy" page attaches this; the hook runs unconditionally because hooks
  // must, and an unattached non-focusable container is not in anybody's way.
  const paneKey = "pane:" + id;
  const { ref: paneRef, focusKey: paneFocusKey } = useFocusable({
    focusKey: paneKey,
    focusable: focusPolicy === "legacy",
    saveLastFocusedChild: true,
    autoRestoreFocus: true,
  });
  const nav = useSettingsNav();
  // Consumed once, at mount: this page is the one that came back from a Back press,
  // and from here on the restore and the default focus are one decision instead of
  // two racing ones.
  const restoreTo = useRef<string | null>(null);
  const restoreDeadline = useRef(0);
  const takeOnce = useRef(false);
  if (!takeOnce.current) {
    takeOnce.current = true;
    restoreTo.current = nav.takePendingFocus();
    if (restoreTo.current) restoreDeadline.current = performance.now() + RESTORE_WAIT_MS;
  }

  useBackspace(() => onBack?.(), !!onBack);

  // Default focus. Marked rows win over document order, so a page can open on the
  // control that matters (the active network, the PIN entry) rather than its first
  // header button.
  useEffect(() => {
    const root = scrollRef.current;
    // A "rail" page still has to honour Back's target - the category pane is the
    // commonest thing Back returns to - it just must not place a DEFAULT focus,
    // because on first entry the rail owns the D-pad.
    if (!root || (focusPolicy === "rail" && !restoreTo.current)) return;
    let observer: MutationObserver | null = null;

    // Is the focus somewhere real? Three things can make the answer "no", and each
    // one had to be found the hard way:
    //
    //  - ROOT is spatial navigation's "nowhere", and it EXISTS as a focusable, so
    //    asking the registry alone answers yes while the screen has nothing focused.
    //  - **The registry lags the DOM.** A mutation callback runs before the removed
    //    rows have deregistered, so a row that has just been swapped out still reads
    //    as existing - which is exactly the moment this check is being made. Ask the
    //    page whether the element is still there, not just the library.
    //  - A key that is not one of THIS page's rows belongs to someone else - an
    //    on-screen keyboard, a photo tile - and must never be stolen back.
    const rowOnPage = (key: string) =>
      [...root.querySelectorAll<HTMLElement>("[data-sfocus]")].some((n) => n.dataset.sfocus === key);
    const focusIsLive = (): boolean => {
      const cur = getCurrentFocusKey();
      if (!cur || cur === ROOT_FOCUS_KEY || cur === paneKey || !doesFocusableExist(cur)) return false;
      return cur.startsWith(id + ":") ? rowOnPage(cur) : true;
    };

    const tryFocus = (): boolean => {
      // Already placed AND the focus is still somewhere real: nothing to do. That
      // second half is the important one. A page routinely replaces its own rows once
      // the box answers - a file server that turns out to be unreachable swaps a form
      // for a retry row - and the row holding the focus goes with them. What is left
      // is worse than no focus: spatial navigation points at nothing, so every arrow
      // and every OK press is silently swallowed and the screen does not say why.
      //
      // NOT covered by the tests in this directory, and not for want of trying: in
      // happy-dom the spatial-nav library never registers the replacement row after
      // the focused one is removed, so the scenario cannot be expressed there at all.
      // It is verified by driving the real launcher over the DevTools protocol - open
      // Settings -> Network -> File server with the shell's fileserver route absent,
      // which is the case that produced it, and watch the focus land on the retry row.
      if (focusedOnce.current) {
        if (focusIsLive()) return true;
        focusedOnce.current = false; // fall through and place it again
      }
      // Back's target wins while it is still expected: the user was on that row a
      // moment ago and expects to be on it again.
      const wanted = restoreTo.current;
      if (wanted) {
        if (doesFocusableExist(wanted)) {
          focusedOnce.current = true;
          restoreTo.current = null;
          void setFocus(wanted);
          return true;
        }
        if (performance.now() < restoreDeadline.current) return false; // still coming
        restoreTo.current = null; // gone for good - fall back to this page's default
        if (focusPolicy === "rail") return true; // ...which a rail page does not have
      }
      // A legacy page's focusables are not marked, so aim at the container and let
      // spatial navigation pick the first child. It only exists once a child has
      // registered, which is why this goes through the same retry loop.
      if (focusPolicy === "legacy") {
        if (!doesFocusableExist(paneKey)) return false;
        focusedOnce.current = true;
        void setFocus(paneKey);
        return true;
      }
      if (focusPolicy === "rail") return true;
      const marked = root.querySelector<HTMLElement>("[data-sfocus][data-sautofocus]");
      const first = marked || root.querySelector<HTMLElement>("[data-sfocus]");
      const key = first?.dataset.sfocus;
      if (!key || !doesFocusableExist(key)) return false;
      focusedOnce.current = true;
      void setFocus(key);
      return true;
    };

    // Placing the focus is a retry loop, not a single attempt, and every trigger goes
    // through here. A row is not focusable the moment it appears in the DOM - spatial
    // navigation registers it a tick later - so the attempt that runs at the instant a
    // page swaps its rows always fails, and there is no second DOM change to try
    // again on. That is how a page ends up with nothing focused: not because the
    // rows are missing, but because the one look happened too early.
    let retry: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stopRetry = () => {
      clearInterval(retry);
      retry = undefined;
      clearTimeout(deadline);
    };
    const schedule = () => {
      if (tryFocus() || retry) return;
      retry = setInterval(() => tryFocus() && stopRetry(), FOCUS_RETRY_MS);
      deadline = setTimeout(stopRetry, FOCUS_RETRY_FOR_MS);
    };
    scheduleRef.current = schedule;

    // A frame late on purpose: norigin measures layout when a focusable registers,
    // and the first paint of a pushed page is the frame its slide-in starts on.
    const raf = requestAnimationFrame(() => {
      schedule();
      // The observer stays for the page's whole life, and is what makes the focus
      // self-healing: a settings page mutates rarely, so the cost is nil, and any
      // change that takes the focused row away starts the loop again.
      observer = new MutationObserver(schedule);
      observer.observe(root, { childList: true, subtree: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      stopRetry();
      observer?.disconnect();
      scheduleRef.current = () => {};
    };
    // id (and paneKey, which is derived from it) never change for a mounted page, so
    // listing them only satisfies the linter - it cannot re-run this.
  }, [focusPolicy, id, paneKey]);

  // Deliberately no dependency array: the rows are this component's CHILDREN, so a
  // page swapping them re-renders this too, and that is a more reliable signal than
  // watching the DOM for it - React always tells us, and it costs nothing when
  // nothing has changed (the check returns immediately while the focus is live). The
  // observer above stays for changes React does not route through here.
  useEffect(() => {
    scheduleRef.current();
  });

  // The no-focusable fallback. Registered unconditionally but checks at press
  // time, because whether a page has focusables can change after its data loads -
  // deciding once at mount would leave a scroll handler swallowing arrows on a
  // page that has since grown rows.
  useEffect(() => {
    // A legacy page's own screen owns the arrows, and its focusables are unmarked, so
    // the "no focusables" test here would always say yes and swallow every press.
    if (focusPolicy !== "own") return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
      const root = scrollRef.current;
      if (!root || root.querySelector("[data-sfocus]")) return;
      ev.preventDefault();
      ev.stopImmediatePropagation(); // or spatial nav also reacts, and moves focus off-page
      root.scrollBy({ top: (ev.key === "ArrowDown" ? 1 : -1) * window.innerHeight * SCROLL_STEP, behavior: "smooth" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focusPolicy]);

  return (
    <div
      ref={scrollRef}
      className={
        "h-full overflow-y-auto no-scrollbar" +
        (animate === "push" ? " tv-page-push" : "") +
        (width === "list" ? " max-w-[58vw]" : "")
      }
      // Headroom for a focused row that scrolls to the top edge: norigin uses
      // block:"nearest", so without it the topmost row pins to the very top and
      // hides the title above it.
      style={{ scrollPaddingTop: "14vh", scrollPaddingBottom: "8vh" }}
    >
      {title && (
        <div className="pb-[2.4vh]">
          <h2 className="text-[3.1vh] font-bold leading-tight flex items-center gap-[0.8vw]">
            {/* A page you can leave says so. The rail already shows which category
                you are in, so this is the only breadcrumb the screen needs. */}
            {onBack && (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-[2.6vh] h-[2.6vh] shrink-0 opacity-40"
                aria-hidden="true"
              >
                <path d="M15 6l-6 6 6 6" />
              </svg>
            )}
            {title}
          </h2>
          {subtitle && <p className="text-[1.9vh] text-fg-dim mt-[0.6vh] max-w-[52vw]">{subtitle}</p>}
        </div>
      )}
      <PageScope value={id}>
        {focusPolicy === "legacy" ? (
          <FocusContext.Provider value={paneFocusKey}>
            <div ref={paneRef} className={animate === "push" ? "tv-stagger" : undefined}>
              {children}
            </div>
          </FocusContext.Provider>
        ) : (
          <div className={animate === "push" ? "tv-stagger" : undefined}>{children}</div>
        )}
      </PageScope>
      {/* The last row must be able to sit clear of the screen edge when it is the
          focused one, and a scroll container cannot use margin for that. */}
      <div className="h-[8vh]" aria-hidden="true" />
    </div>
  );
}
