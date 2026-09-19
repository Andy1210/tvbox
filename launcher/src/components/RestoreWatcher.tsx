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
// A long list of retired apps is compressed to two names and a count, so it
// cannot run away with the line. Only when at least TWO names would be hidden,
// though: " +1 more" is longer than most app ids here (plex, kodi, emby), so
// hiding exactly one is longer than printing it AND trades a name for a digit -
// measured, "plex, jellyfin +1 more" against "plex, jellyfin, kodi".
const MAX_NAMED = 2;

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
  // An app no registry carries any more was never one of the apps this run could
  // bring back, so it is counted out of the total rather than against it: "8 of 9"
  // with one retired, not "8 of 10" with the tenth unexplained.
  const goneApps = status.gone ?? [];
  const apps =
    goneApps.length > MAX_NAMED + 1
      ? t("restore.andMore", {
          apps: goneApps.slice(0, MAX_NAMED).join(", "),
          n: String(goneApps.length - MAX_NAMED),
        })
      : goneApps.join(", ");
  const total = status.total - goneApps.length;
  const restored = total - failed;
  const label = running
    ? status.current
      ? t("restore.step." + status.current.kind, { name })
      : t("restore.preparing")
    : failed
      ? // The retired ones are named here too. Dropping them left the person with a
        // total smaller than their backup's and nothing accounting for the
        // difference, on the only run that can ever say it: a retired app leaves
        // the desired state, so there is no second showing.
        t(goneApps.length ? "restore.doneWithErrorsAndGone" : "restore.doneWithErrors", {
          n: String(restored),
          total: String(total),
          failed: String(failed),
          apps,
        })
      : goneApps.length
        ? // "Your apps are back" is a claim, and with every app in the backup
          // retired it is a false one - there is nothing to have come back.
          t(restored > 0 ? "restore.doneWithGone" : "restore.noneLeft", { apps })
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
        {/* The running label is replaced every few seconds and must stay one line,
            so it truncates. The summary is written once and stands for eight
            seconds: measured at 1360x768 it has room for ~74 characters, and the
            sentence that names both a failure and a retirement runs to 75 in
            English and 80 in Hungarian - so truncating it ate the clause this
            banner exists to add. Two lines, clamped so nothing can grow without
            bound. */}
        <span className={"text-[2vh] font-semibold flex-1 " + (running ? "truncate" : "line-clamp-2")}>{label}</span>
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
