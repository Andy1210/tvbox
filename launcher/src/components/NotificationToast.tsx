import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { TvNotification } from "../lib/shell";

// On-screen notification pushed from the shell over MQTT (HA alerts, a doorbell
// camera snapshot, …). A top-center card above everything (including app views
// and the ambient screen); auto-dismisses after `duration` (default 8s, 0 =
// sticky), and Back/Home dismisses it (swallowed so it doesn't also navigate).
export function NotificationToast() {
  const { t } = useI18n();
  const [note, setNote] = useState<TvNotification | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = () => {
    setNote(null);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => {
    if (!window.tvbox?.onNotify) return;
    return window.tvbox.onNotify((n) => {
      setNote(n || {});
      if (timer.current) clearTimeout(timer.current);
      const dur = n && typeof n.duration === "number" ? n.duration : 8000;
      timer.current = dur > 0 ? setTimeout(() => setNote(null), dur) : null;
    });
  }, []);

  useEffect(() => {
    if (!note) return;
    const onKey = (e: KeyboardEvent) => {
      if (["Backspace", "BrowserBack", "GoBack", "Cancel", "Escape", "BrowserHome"].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [note]);

  if (!note || (!note.title && !note.message && !note.image)) return null;
  return (
    <div className="fixed top-[4vh] left-1/2 -translate-x-1/2 z-[70] w-auto max-w-[64vw] rounded-[1.6vh] bg-[rgba(12,16,22,0.97)] shadow-[0_1.2vh_4vh_rgba(0,0,0,0.6)] ring-[0.2vh] ring-white/10 overflow-hidden">
      {note.image && <img src={note.image} alt="" className="w-full max-h-[46vh] object-cover" />}
      <div className="px-[2.4vw] py-[2vh]">
        {note.title && <div className="text-[2.6vh] font-bold">{note.title}</div>}
        {note.message && (
          <div className="text-[2.1vh] text-white/80 mt-[0.6vh] whitespace-pre-line">{note.message}</div>
        )}
        <div className="text-[1.6vh] text-white/40 mt-[1.2vh]">{t("notify.dismiss")}</div>
      </div>
    </div>
  );
}
