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
  total: number;
  done: number;
  current: { id: string; name: string | Record<string, string> | null; kind: ReconcileStep["kind"] } | null;
  failed: { id: string; kind: ReconcileStep["kind"]; error: string }[];
  // Optional because this is a wire format, not a local object: a launcher run
  // against a shell that predates it (vite dev, a half-finished deploy) gets no
  // such field, and a render that reads it unguarded takes the whole UI down.
  gone?: { id: string; name: string | Record<string, string> | null }[];
  steps: ReconcileStep[];
}

export async function fetchReconcileStatus(): Promise<ReconcileStatus | null> {
  try {
    return await (await fetch("/tvbox/api/reconcile/status", { cache: "no-store" })).json();
  } catch {
    return null;
  }
}
