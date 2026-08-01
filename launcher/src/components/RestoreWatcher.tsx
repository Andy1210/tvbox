import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { fetchReconcileStatus, type ReconcileStatus } from "../lib/reconcile";

// "Restoring your apps" banner. A settings restore brings the box's settings
// back in seconds, but the apps behind them - packages, flatpaks, binaries,
// bundles - are re-acquired afterwards and take minutes. Without this the user
// sits in front of an empty HOME with nothing saying why, which is exactly what
// makes a restore feel like it failed.
//
// Polls only while there is something to watch: one fetch at launcher start, then
// every 3s until the run finishes, then a short "done" dwell. A box that never
// restored anything pays a single request. Renders no focusable element, so it
// cannot steal spatial-nav focus (cf. InstallWatcher).
const POLL_MS = 3000;
const DWELL_MS = 8000; // how long the finished summary stays up
const EARLY_RETRIES = 5; // before the first answer, a hiccup gets this many more goes

export function RestoreWatcher() {
  const { t, loc } = useI18n();
  const [status, setStatus] = useState<ReconcileStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A failed fetch is a hiccup, not an answer. Dropping the banner on one - which
    // is what setting the status to null would do - leaves the user back in front of
    // an empty HOME with nothing explaining it, exactly the state this exists to
    // prevent. So the last known status is kept and the poll retries: while a run is
    // in flight, indefinitely; before the first answer, a few times, because a shell
    // that never responds must not leave a poll running forever.
    let lastKnown: ReconcileStatus | null = null;
    let earlyFailures = 0;
    const poll = async () => {
      const s = await fetchReconcileStatus();
      if (!alive) return;
      if (!s) {
        const keepTrying = lastKnown ? lastKnown.active || lastKnown.pending : ++earlyFailures <= EARLY_RETRIES;
        if (keepTrying) timer = setTimeout(poll, POLL_MS);
        return; // leave `status` as it was
      }
      lastKnown = s;
      setStatus(s);
      // Keep polling while the box still owes work. `pending` covers the gap
      // between a recorded restore and the first step actually running.
      if (s.active || s.pending) timer = setTimeout(poll, POLL_MS);
      else if (s.finishedAt) timer = setTimeout(() => alive && setDismissed(true), DWELL_MS);
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (dismissed || !status || (!status.active && !status.pending && !status.finishedAt)) return null;

  const running = status.active || status.pending;
  const name = status.current ? loc(status.current.name ?? status.current.id) : "";
  const failed = status.failed.length;
  const label = running
    ? status.current
      ? t("restore.step." + status.current.kind, { name })
      : t("restore.preparing")
    : failed
      ? t("restore.doneWithErrors", {
          n: String(status.total - failed),
          total: String(status.total),
          failed: String(failed),
        })
      : t("restore.done");
  const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;

  return (
    <div
      className={[
        "fixed left-1/2 -translate-x-1/2 bottom-[6vh] z-[60] w-[52vw] px-[2.4vw] py-[1.6vh] rounded-[1.2vh]",
        "bg-[rgba(20,26,36,0.96)] shadow-[0_1vh_3vh_rgba(0,0,0,0.5)]",
      ].join(" ")}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-[1vw]">
        {running && (
          <span className="w-[2.4vh] h-[2.4vh] shrink-0 rounded-full border-[0.35vh] border-white/20 border-t-white animate-spin" />
        )}
        <span className="text-[2vh] font-semibold truncate flex-1">{label}</span>
        {running && status.total > 0 && (
          <span className="text-[1.8vh] text-fg-dim tabular-nums shrink-0">
            {status.done}/{status.total}
          </span>
        )}
      </div>
      {running && (
        <div className="mt-[1.1vh] h-[0.6vh] rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-white/70 transition-[width] duration-500" style={{ width: pct + "%" }} />
        </div>
      )}
    </div>
  );
}
