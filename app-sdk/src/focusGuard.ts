import { doesFocusableExist, getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";

// A cursor that points at nothing is a dead remote.
//
// Spatial navigation moves FROM the focused component. When that component has
// gone (its row unmounted, a restore aimed at a key that never mounted, a focus
// saved before an overlay and replayed after it), every arrow press resolves
// against nothing and is dropped, and nothing on screen says why. The library only
// recovers when a container is marked force-focusable, and a screen built from
// plain rows has none.
//
// The guard checks on the two occasions that can notice it: a navigation key, and
// the window becoming visible again. When the focused key no longer exists it asks
// the screen on display where the cursor belongs (the provider it registered) and
// puts it there. A key press that heals is spent on healing: the listener runs in
// the capture phase, before spatial navigation's own, and stops the event there.

/** The keys to try, best first. A single key is fine too. */
type Provider = () => string | null | undefined | readonly (string | null | undefined)[];

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]);

/**
 * Dispatched on the window, with the key in `detail.key`, for a press the guard
 * spent on healing. That press never reaches a later keydown listener, so
 * anything that counts presses (an idle timer, a confirm that an arrow disarms)
 * listens for this as well.
 */
export const HEALED_KEY_EVENT = "tvbox:healed-key";

// Innermost last: an overlay mounted over a screen registers after it and wins
// until it unmounts.
const providers: Provider[] = [];

/**
 * Register where the cursor should go when it is found pointing at nothing.
 *
 * Returns the unregister function, for an effect's cleanup. The provider is asked
 * at heal time, so it can answer from state that changes (the tile a row was last
 * left on) without re-registering.
 */
export function setFocusFallback(provider: Provider): () => void {
  providers.push(provider);
  return () => {
    const i = providers.lastIndexOf(provider);
    if (i >= 0) providers.splice(i, 1);
  };
}

/** Is the cursor pointing at a focusable that is not there? */
export function focusIsLost(): boolean {
  const key = getCurrentFocusKey();
  return !key || !doesFocusableExist(key);
}

/**
 * Put a lost cursor somewhere real. Returns true when it did.
 *
 * Providers are asked innermost first, and a key that does not exist either is
 * skipped rather than trusted: handing spatial navigation a key it does not know
 * is exactly how the cursor got lost.
 */
export function healFocus(): boolean {
  if (!focusIsLost()) return false;
  for (let i = providers.length - 1; i >= 0; i--) {
    let answer: ReturnType<Provider>;
    try {
      answer = providers[i]();
    } catch {
      continue;
    }
    const keys = Array.isArray(answer) ? answer : [answer];
    const key = keys.find((k): k is string => !!k && doesFocusableExist(k));
    if (key) {
      void setFocus(key);
      return true;
    }
  }
  return false;
}

/** Start watching. Returns the function that stops it. */
export function installFocusGuard(target: Window = window): () => void {
  const onKey = (ev: KeyboardEvent) => {
    // A press that healed is over: stopped here, so no later listener (spatial
    // navigation's own, a screen's) also acts on it from the key just restored.
    if (NAV_KEYS.has(ev.key) && healFocus()) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      target.dispatchEvent(new CustomEvent(HEALED_KEY_EVENT, { detail: { key: ev.key } }));
    }
  };
  const onShown = () => {
    if (!target.document.hidden) healFocus();
  };
  target.addEventListener("keydown", onKey, true);
  target.addEventListener("focus", onShown);
  target.document.addEventListener("visibilitychange", onShown);
  return () => {
    target.removeEventListener("keydown", onKey, true);
    target.removeEventListener("focus", onShown);
    target.document.removeEventListener("visibilitychange", onShown);
  };
}
