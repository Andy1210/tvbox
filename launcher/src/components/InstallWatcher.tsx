import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStore } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useInstalls } from "../stores/installs";

// Global "app installed" toast. Store installs run in the background on the box,
// so if the user leaves the App Store mid-install they'd otherwise never learn
// it finished. This watcher lives at the app root (alongside NotificationToast),
// polls the store list while any kicked-off install is still pending, and shows
// a self-dismissing bottom-center card when each one completes - on whatever
// screen the user is on. It renders no focusable element, so it never steals
// spatial-nav focus. A double toast with the store's own status line (when the
// user is still in the store) is acceptable.
export function InstallWatcher() {
  const { t, loc } = useI18n();
  const pending = useInstalls((s) => s.pending);
  const remove = useInstalls((s) => s.remove);
  const [toast, setToast] = useState<string | null>(null);
  const [visible, setVisible] = useState(false); // drives the HOME-toast-style slide/fade
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((msg: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setToast(msg);
    // after the dwell: slide out, then unmount once the transition has run
    timer.current = setTimeout(() => {
      setVisible(false);
      hideTimer.current = setTimeout(() => setToast(null), 250);
    }, 4000);
  }, []);

  // Entry: the card mounts hidden (translated + transparent); flip `visible` on
  // the next frame so the transition animates it in - same pattern as the HOME
  // status toast, replicated locally because this one must still unmount.
  useEffect(() => {
    if (!toast) return;
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [toast]);

  // Poll only while something is pending; the interval stops the moment the last
  // pending install resolves. An id is DONE once its entry exists and is no
  // longer installing: installed -> success, present-but-not-installed -> failed.
  useEffect(() => {
    if (!pending.length) return;
    let alive = true;
    const iv = setInterval(async () => {
      const d = await fetchStore();
      if (!alive || !d) return;
      for (const id of pending) {
        const e = d.apps.find((x) => x.id === id);
        if (e && !e.installing) {
          remove(id);
          show(t(e.installed ? "install.done" : "install.failed", { name: loc(e.name) }));
        }
      }
    }, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [pending, remove, show, t, loc]);

  useEffect(
    () => () => {
      clearTimeout(timer.current ?? undefined);
      clearTimeout(hideTimer.current ?? undefined);
    },
    [],
  );

  if (!toast) return null;
  return (
    <div
      className={[
        "fixed left-1/2 -translate-x-1/2 bottom-[6vh] z-[60] max-w-[64vw] px-[3vw] py-[1.6vh] rounded-[1.2vh]",
        "bg-[rgba(20,26,36,0.96)] text-[2vh] font-semibold shadow-[0_1vh_3vh_rgba(0,0,0,0.5)]",
        "transition-[opacity,translate] duration-200",
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-[2vh] pointer-events-none",
      ].join(" ")}
      role="status"
      aria-live="polite"
    >
      {toast}
    </div>
  );
}
