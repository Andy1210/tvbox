// Restore reconciliation status (shell route /tvbox/api/reconcile/status). After
// a settings restore the box re-acquires everything the backup file could not
// carry - app packages, flatpaks, downloaded binaries, extracted bundles - and
// this is how the launcher can say so instead of showing an empty HOME.
export interface ReconcileStep {
  id: string;
  name: string | Record<string, string> | null;
  kind: "app" | "deps" | "bundle";
  // "gone": no configured registry offers the app any more, so the box stopped
  // asking for it. Settled like "failed", but nothing went wrong.
  state: "pending" | "running" | "done" | "failed" | "skipped" | "gone";
}
export interface ReconcileStatus {
  active: boolean;
  pending: boolean; // recorded, not finished - the run may not have started yet
  reason: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  // Plan steps, for the progress bar. One app can owe two of them and an app the
  // backup restored whole owes none, so this is not a count of apps.
  total: number;
  done: number;
  // Apps this restore is about, across all of its passes. Optional: a shell that
  // predates it sends nothing, and the caller falls back to the step total.
  wanted?: number;
  current: { id: string; name: string | Record<string, string> | null; kind: ReconcileStep["kind"] } | null;
  failed: { id: string; kind: ReconcileStep["kind"]; error: string }[];
  // Steps that stood down because the box was claimed mid-run: neither a failure
  // nor an arrival. Optional like `wanted`, for a shell that predates it.
  skipped?: string[];
  // App ids, not names: a step only reaches `gone` when its app is absent from
  // the box, and nothing then knows what it is called - not the box, which never
  // had it, and not the registries, which no longer offer it.
  //
  // Optional because this is a wire format, not a local object: a launcher run
  // against a shell that predates it (vite dev, a half-finished deploy) gets no
  // such field, and a render that reads it unguarded takes the whole UI down.
  gone?: string[];
  steps: ReconcileStep[];
}

export async function fetchReconcileStatus(): Promise<ReconcileStatus | null> {
  try {
    return await (await fetch("/tvbox/api/reconcile/status", { cache: "no-store" })).json();
  } catch {
    return null;
  }
}
