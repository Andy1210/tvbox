import { useEffect, useRef, useState } from "react";

// Fires `idle` after idleMs with no key/pointer activity. `suppressed` (e.g.
// playback is on, or we're not on Home) keeps resetting the timer so the ambient
// screen never covers something the user is watching. Returns [idle, wake] -
// wake() dismisses immediately (the ambient overlay calls it on the first key).
//
// A hidden document suppresses it on the same grounds, and it is NOT covered by
// the caller's condition: the shell hides the launcher window whenever another
// app holds the screen (exactly one visible toplevel), while the launcher's own
// view stays on Home the whole time. A hidden window cannot receive the activity
// that would reset this, so counting that time would arm the overlay behind the
// app and hand the user the ambient screen instead of Home when they come back.
export function useIdle(idleMs: number, suppressed: boolean): [boolean, () => void] {
  const [idle, setIdle] = useState(false);
  const last = useRef(Date.now());
  const wake = () => {
    last.current = Date.now();
    setIdle(false);
  };

  useEffect(() => {
    // Clear idle the instant suppression starts, not on the next 5s tick: an
    // already-idle user returning to Home via a brokered nav event would
    // otherwise briefly re-trigger the ambient overlay before the interval
    // catches up.
    if (suppressed || document.hidden) {
      last.current = Date.now();
      setIdle(false);
    }
    const bump = () => {
      last.current = Date.now();
      setIdle((v) => (v ? false : v));
    };
    // Going hidden is the same case, and it can happen with the overlay already
    // up: a launch brokered from voice or MQTT needs no key press here.
    const onVisibility = () => {
      if (document.hidden) {
        last.current = Date.now();
        setIdle(false);
      }
    };
    // capture phase so activity anywhere counts, even inside focused widgets
    window.addEventListener("keydown", bump, true);
    window.addEventListener("pointermove", bump, true);
    document.addEventListener("visibilitychange", onVisibility);
    const iv = setInterval(() => {
      if (suppressed || document.hidden) {
        last.current = Date.now();
        return;
      }
      if (Date.now() - last.current >= idleMs) setIdle(true);
    }, 5000);
    return () => {
      window.removeEventListener("keydown", bump, true);
      window.removeEventListener("pointermove", bump, true);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(iv);
    };
  }, [idleMs, suppressed]);

  return [idle, wake];
}
