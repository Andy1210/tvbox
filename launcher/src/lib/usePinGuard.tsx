import { useState, type ReactNode } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useConfigStore } from "../stores/config";
import { PinGate } from "@sdk/PinGate";

// Parental gate for sensitive UI actions (installs, uninstalls, …). When a PIN
// is set AND "require PIN" is enabled in Settings > Parental controls, guard()
// detours through a full-screen PinGate before running the action; otherwise it
// runs immediately. This is a UI-level child lock like Fire TV's, not a
// security boundary - the control API stays local-only either way.
//
//   const { guard, gate } = usePinGuard();
//   <FocusButton onEnter={() => guard(doInstall, "my-focus-key")} … />
//   …render {gate} at the end of the component…
//
// `restoreFocus` is re-focused after cancel (the PinGate unmounts and the
// original button must get focus back - a 10-foot UI can't be left focusless).
export function usePinGuard(): { guard: (fn: () => void, restoreFocus?: string) => void; gate: ReactNode } {
  const need = useConfigStore((s) => !!(s.config?.parental.pinSet && s.config?.parental.requirePin));
  const [pending, setPending] = useState<null | { fn: () => void; restoreFocus?: string }>(null);

  const finish = (run: boolean) => {
    const p = pending;
    setPending(null);
    if (p?.restoreFocus) setTimeout(() => setFocus(p.restoreFocus!), 0);
    if (run && p) p.fn();
  };

  const guard = (fn: () => void, restoreFocus?: string) => {
    if (!need) return fn();
    setPending({ fn, restoreFocus });
  };
  const gate = pending ? <PinGate onSuccess={() => finish(true)} onCancel={() => finish(false)} /> : null;
  return { guard, gate };
}
