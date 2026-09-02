import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import type { TvNotification } from "../lib/shell";

// On-screen notification pushed from the shell over MQTT (HA alerts, a doorbell
// camera snapshot, …). A top-center card above everything (including app views
// and the ambient screen); auto-dismisses after `duration` (default 8s, 0 =
// sticky), and Back/Home dismisses it (swallowed so it doesn't also navigate).
// Every cause shell/ir.js can classify. A value outside it is not a cause this build
// can say anything about, so it reads as the generic one.
const IR_CAUSES = new Set([
  "noBlaster",
  "unmapped",
  "noService",
  "badCode",
  "badSpec",
  "held",
  "busy",
  "linkLost",
  "notFired",
  "serviceSlow",
  "timeout",
  "blasterUnreachable",
  "blasterKey",
  "blasterEntities",
  "haUrl",
  "haCall",
  "asleep",
  "other",
]);
const irCause = (c: unknown) => (typeof c === "string" && IR_CAUSES.has(c) ? c : "other");

// Causes whose body would be contradicted by "the command did not go out".
const IR_TITLE: Record<string, string> = {
  linkLost: "ir.failedTitleUnknown",
  notFired: "ir.failedTitleRemote",
  held: "ir.failedTitleWait",
  busy: "ir.failedTitleWait",
};

export function NotificationToast() {
  const { t } = useI18n();
  const [note, setNote] = useState<TvNotification | null>(null);
  const [visible, setVisible] = useState(false); // drives the HOME-toast-style slide/fade
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Slide out first, then unmount once the transition has run - the keydown
  // swallow and MQTT cleanup semantics stay exactly as before.
  const dismiss = () => {
    setVisible(false);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setNote(null);
      hideTimer.current = null;
    }, 250);
  };

  useEffect(() => {
    if (!window.tvbox?.onNotify) return;
    return window.tvbox.onNotify((n) => {
      if (hideTimer.current) {
        // a new note arrived mid-exit-animation: keep it mounted
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setNote(n || {});
      if (timer.current) clearTimeout(timer.current);
      const dur = n && typeof n.duration === "number" ? n.duration : 8000;
      timer.current = dur > 0 ? setTimeout(dismiss, dur) : null;
    });
  }, []);

  // Entry: the card mounts hidden (translated + transparent); flip `visible` on
  // the next frame so the transition animates it in - same pattern as the HOME
  // status toast, replicated locally because this one must still unmount.
  // shell-originated structured notes carry a `kind` instead of display strings
  // (the shell has no i18n); map them to localized copy here
  const kindTitle =
    note?.kind === "lowBattery"
      ? t("bt.lowBattery")
      : note?.kind === "crashRestart"
        ? t("crash.restarted")
        : note?.kind === "irFailed"
          ? // The generic title asserts the command did not go out, which two of the
            // causes deliberately do not claim: a link lost mid-send may have fired,
            // and a remote that took the code and did not fire is a different fault.
            t(IR_TITLE[irCause(note.cause)] || "ir.failedTitle")
          : "";
  const kindMessage =
    note?.kind === "irFailed"
      ? // Per cause: telling somebody to wake the remote when nothing is mapped to the
        // action sends them to press buttons forever.
        // Held to the known set, not just to "is a string": a cause this build does
        // not know (a newer shell, a squatted socket) would otherwise render its own
        // key - "ir.failed.somethingelse" - on the television.
        t("ir.failed." + irCause(note.cause))
      : note?.kind === "lowBattery"
        ? t("bt.lowBatteryMsg", { name: note.name || "?", pct: String(note.battery ?? 0) })
        : note?.kind === "crashRestart"
          ? t("crash.restartedMsg")
          : "";
  const title = note?.title || kindTitle;
  const message = note?.message || kindMessage;
  const hasContent = !!note && !!(title || message || note.image);
  useEffect(() => {
    if (!hasContent) return;
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [note, hasContent]);

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

  if (!hasContent) return null;
  return (
    <div
      className={[
        "fixed top-[4vh] left-1/2 -translate-x-1/2 z-[70] w-auto max-w-[64vw] rounded-[1.6vh]",
        "bg-[rgba(12,16,22,0.97)] shadow-[0_1.2vh_4vh_rgba(0,0,0,0.6)] ring-[0.2vh] ring-white/10 overflow-hidden",
        "transition-[opacity,translate] duration-200",
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-[2vh] pointer-events-none",
      ].join(" ")}
    >
      {note.image && <img src={note.image} alt="" className="w-full max-h-[46vh] object-cover" />}
      <div className="px-[2.4vw] py-[2vh]">
        {title && <div className="text-[2.6vh] font-bold">{title}</div>}
        {message && <div className="text-[2.1vh] text-white/80 mt-[0.6vh] whitespace-pre-line">{message}</div>}
        <div className="text-[1.6vh] text-white/40 mt-[1.2vh]">{t("notify.dismiss")}</div>
      </div>
    </div>
  );
}
