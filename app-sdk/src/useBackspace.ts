import { useEffect, useRef } from "react";

// Remote Back (Backspace) handling. Multiple screens mount a handler (Settings,
// and modals opened inside it - the resolution picker, the OSK, …). A single
// capture-phase listener fires only the TOP handler: the most recently mounted
// enabled one. So a modal's Back closes the modal (not the whole Settings), and
// when it unmounts the parent's handler takes over again. `enabled` lets a screen
// register only while its modal is open (otherwise it would swallow Back for the
// parent). Re-renders keep the same slot but always call the latest closure.
let seq = 0;
const handlers = new Map<number, () => void>();
let listening = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== "Backspace" || handlers.size === 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  let top = -1;
  for (const id of handlers.keys()) if (id > top) top = id; // highest id = most recent mount
  const h = handlers.get(top);
  if (h) h();
}

export function useBackspace(handler: () => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const id = ++seq;
    handlers.set(id, () => ref.current());
    if (!listening) {
      window.addEventListener("keydown", onKey, true);
      listening = true;
    }
    return () => {
      handlers.delete(id);
    };
  }, [enabled]);
}
