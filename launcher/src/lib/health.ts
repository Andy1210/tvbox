// The box's own health report (GET /tvbox/api/health, shell/health.js): the
// failures that leave the television looking fine while something has stopped.
export type HealthIssue =
  | "threadpool"
  | "install-stuck"
  | "update-pending"
  | "rolled-back"
  | "infra-sync"
  | "recent-crash"
  | "launcher-not-loaded"
  | "report-failed";

export interface HealthReport {
  at: string;
  status: "ok" | "warn";
  issues: HealthIssue[];
  pool: { ms: number | null; saturated: boolean };
  installAgeSec: number | null;
  nowPlaying: { state: string | null; app: string | null; ageSec: number | null } | null;
  update: { release: string | null; pending: boolean; failed: string | null; synced: string | null };
  lastCrashAt: string | null;
  reachedLauncher: boolean;
}

export async function fetchHealth(): Promise<HealthReport | null> {
  try {
    const res = await fetch("/tvbox/api/health", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as HealthReport;
  } catch {
    return null;
  }
}
