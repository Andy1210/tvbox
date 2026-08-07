import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { stopMirroring } from "../lib/api";

// What is on screen while a phone is mirroring: as close to nothing as possible.
//
// mpv plays behind the launcher's transparent window, so anything drawn here
// sits ON the phone's screen. The Settings page that started mirroring did
// exactly that and covered it. The shell pushes "mirroring" when the first
// frames arrive and something else when they stop, the same contract the typing
// screen uses - the screen follows the shell rather than guessing, because the
// shell is the one that knows whether frames are still coming.
//
// Back stops mirroring. That is the only control here on purpose: there is
// nothing to configure mid-session, and a viewer holding a remote in front of
// their own phone screen needs exactly one thing - the way out.
const HINT_MS = 4000;

export function MirrorOverlay({ onActiveChange }: { onActiveChange?: (on: boolean) => void }) {
  const { t } = useI18n();
  const [active, setActive] = useState(false);
  const [hint, setHint] = useState(true);
  const activeRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    return window.tvbox?.onNav?.((n) => {
      if (n.dest === "mirroring") {
        setActive(true);
        setHint(true);
      } else if (activeRef.current) {
        // Any other destination means the session is over - the shell pushes one
        // when the phone goes away as well as when the viewer stops it.
        setActive(false);
      }
    });
  }, []);

  // The hint says which button ends this, then gets out of the way. It is drawn
  // over someone's phone screen, so it earns its place for a few seconds only.
  useEffect(() => {
    if (!active || !hint) return;
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [active, hint]);

  // Back ends the session, through the shared handler stack rather than a
  // listener of this component's own: it already knows every key a remote calls
  // Back (a CEC bridge sends Backspace, a Bluetooth remote BrowserBack/GoBack,
  // some send Escape), and it fires only the top handler - so nothing else
  // reacts to the same press while a phone is on screen.
  useBackspace(() => {
    void stopMirroring();
  }, active);

  if (!active) return null;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none" data-testid="mirror-overlay">
      {hint ? (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 rounded-2xl bg-black/70 px-8 py-4 text-2xl text-white">
          {t("mirroring.overlayHint")}
        </div>
      ) : null}
    </div>
  );
}
