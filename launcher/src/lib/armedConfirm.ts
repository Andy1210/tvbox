import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";
import { HEALED_KEY_EVENT } from "@sdk/focusGuard";

// "Press once to arm, press again to do it" for an action that cannot be taken back.
//
// On a remote the second press has to be a second press. Chromium repeats a held
// key, so without these rules one long OK both arms and confirms: a confirm must
// come from a fresh keydown (not a repeat) and at least `minGapMs` after the arm.
// An armed action also lets go by itself after `timeoutMs`, and as soon as the
// cursor moves (by key, or by a pointer pressing a different row), so a press
// minutes later on the same row starts over.

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Escape"]);

export function useArmedConfirm(opts: { timeoutMs?: number; minGapMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const minGapMs = opts.minGapMs ?? 500;
  const [armed, setArmed] = useState<string | null>(null);
  const armedAt = useRef(0);
  const lastWasRepeat = useRef(false);
  // The row the action was armed on, and the row the last pointer press landed on
  // (null after a key press). Rows carry their focus key as data-sfocus.
  const armedRow = useRef<string | null>(null);
  const pointerRow = useRef<string | null>(null);
  const armedKey = useRef<string | null>(null);
  armedKey.current = armed;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        lastWasRepeat.current = ev.repeat;
        pointerRow.current = null;
      } else if (NAV_KEYS.has(ev.key)) setArmed(null);
    };
    const onPointer = (ev: Event) => {
      lastWasRepeat.current = false;
      const target = ev.target instanceof Element ? ev.target : null;
      const row = target?.closest("[data-sfocus]")?.getAttribute("data-sfocus") ?? null;
      pointerRow.current = row;
      if (armedKey.current !== null && row !== armedRow.current) setArmed(null);
    };
    // The cursor moved to heal a lost focus: whatever was armed is not where it is now.
    const onHealed = () => setArmed(null);
    // Capture phase: the flag has to be set before spatial navigation runs the
    // row's handler for the same keydown.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener(HEALED_KEY_EVENT, onHealed);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener(HEALED_KEY_EVENT, onHealed);
    };
  }, []);

  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), timeoutMs);
    return () => clearTimeout(t);
  }, [armed, timeoutMs]);

  /** One press on `key`. True when this press confirms an action armed before it. */
  const press = useCallback(
    (key: string): boolean => {
      const now = Date.now();
      if (armed !== key) {
        if (lastWasRepeat.current) return false; // a held key does not arm either
        armedAt.current = now;
        armedRow.current = pointerRow.current ?? getCurrentFocusKey() ?? null;
        armedKey.current = key;
        setArmed(key);
        return false;
      }
      if (lastWasRepeat.current || now - armedAt.current < minGapMs) return false;
      setArmed(null);
      return true;
    },
    [armed, minGapMs],
  );

  const disarm = useCallback(() => setArmed(null), []);
  return { armed, press, disarm };
}
