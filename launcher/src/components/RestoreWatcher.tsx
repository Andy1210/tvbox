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
// ...and a count of names is not a bound on their WIDTH. An id may be 40
// characters (shell/reconcile.js), so two of them are 82 on their own - enough to
// push the count itself off the end of the clamp, which is the one thing the
// compression exists to guarantee. Measured: about 74 characters fit on a line
// here, so a list past this length compresses however few names it holds.
const MAX_NAMED_CHARS = 60;

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
  // The sentence counts APPS, so the arithmetic has to as well. `total` is a count
  // of plan steps: one app can owe two of them (its deps and its bundle) and an app
  // the backup restored whole owes none, so a restore of one retired app and one
  // already-whole app has a step total of 1 and said "nothing to bring back" about
  // a box whose app was back. `wanted` is the app count; `failed` is a step list,
  // and an app that failed twice is still one app.
  //
  // `wanted` falls back to the step total for a shell that predates it, which is
  // the old behaviour rather than a crash.
  const failedApps = new Set(status.failed.map((f) => f.id)).size;
  // An app no registry carries any more was never one of the apps this run could
  // bring back, so it is counted out of the total rather than against it: "8 of 9"
  // with one retired, not "8 of 10" with the tenth unexplained.
  const goneApps = status.gone ?? [];
  const wanted = status.wanted ?? status.total;
  const named = goneApps.join(", ");
  const apps =
    goneApps.length > MAX_NAMED + 1 || named.length > MAX_NAMED_CHARS
      ? t("restore.andMore", {
          apps: goneApps.slice(0, MAX_NAMED).join(", "),
          n: String(goneApps.length - MAX_NAMED),
        })
      : named;
  const total = wanted - goneApps.length;
  const restored = total - failedApps;
  const label = running
    ? status.current
      ? t("restore.step." + status.current.kind, { name })
      : t("restore.preparing")
    : failedApps
      ? // The retired ones are named here too. Dropping them left the person with a
        // total smaller than their backup's and nothing accounting for the
        // difference, on the only run that can ever say it: a retired app leaves
        // the desired state, so there is no second showing.
        t(goneApps.length ? "restore.doneWithErrorsAndGone" : "restore.doneWithErrors", {
          n: String(restored),
          total: String(total),
          failed: String(failedApps),
          apps,
        })
      : goneApps.length
        ? // "Your apps are back" is a claim, and with every app in the backup
          // retired it is a false one - there is nothing to have come back.
          //
          // Only said when the shell sent an app count, though: without one the
          // total is a count of STEPS, and one retired app beside one the backup
          // carried whole is exactly a step total of 1 - the shape this arithmetic
          // exists to fix. Claiming nothing came back there would be the old bug
          // wearing the new sentence.
          t(total > 0 || status.wanted == null ? "restore.doneWithGone" : "restore.noneLeft", { apps })
        : t("restore.done");
  // Steps, not apps: this is how much of the plan is behind us, which is what a
  // progress bar is for.
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
            seconds: about 74 characters fit on a line here, and the longest
            sentence it can produce - a failure, a retirement and a "+N more" - is
            94 characters in English and 106 in Hungarian, which is two lines with
            a third of the second one spare. Measured in DejaVu Sans, the sans face
            deploy/provision.sh installs. Truncating that ate the clause this
            banner exists to add; clamped at two so it cannot grow without bound. */}
        <span className={"text-[2vh] font-semibold flex-1 " + (running ? "truncate" : "line-clamp-2")}>{label}</span>
        {/* No numeric counter beside it. It counted plan STEPS while the summary
            counts apps, so the denominator changed between them - "1/4" while
            running, "2 of 3 apps restored" at the end - which reads as a bug from
            the sofa. The bar below is a progress indicator and needs no unit. */}
      </div>
      {running && (
        <div className="mt-[1.1vh] h-[0.6vh] rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-white/70 transition-[width] duration-500" style={{ width: pct + "%" }} />
        </div>
      )}
    </div>
  );
}
