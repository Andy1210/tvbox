// Restore reconciliation status (shell route /tvbox/api/reconcile/status). After
// a settings restore the box re-acquires everything the backup file could not
// carry - app packages, flatpaks, downloaded binaries, extracted bundles - and
// this is how the launcher can say so instead of showing an empty HOME.
export interface ReconcileStep {
  id: string;
  name: string | Record<string, string> | null;
  kind: "app" | "deps" | "bundle";
  state: "pending" | "running" | "done" | "failed" | "skipped";
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
  steps: ReconcileStep[];
}

export async function fetchReconcileStatus(): Promise<ReconcileStatus | null> {
  try {
    return await (await fetch("/tvbox/api/reconcile/status", { cache: "no-store" })).json();
  } catch {
    return null;
  }
}
