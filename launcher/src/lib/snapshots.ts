// Kept copies of the box's settings (shell/configsnap.js). Only dates cross to
// the launcher; the copies stay on the box.
export interface ConfigSnapshot {
  id: string;
  at: number;
}

export async function fetchSnapshots(): Promise<ConfigSnapshot[] | null> {
  try {
    const res = await fetch("/tvbox/api/backup/snapshots", { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { snapshots?: ConfigSnapshot[] };
    return Array.isArray(j.snapshots) ? j.snapshots : [];
  } catch {
    return null;
  }
}

// On success the shell restarts a few seconds later, like after a backup restore.
export async function restoreSnapshot(id: string): Promise<boolean> {
  try {
    const res = await fetch("/tvbox/api/backup/snapshots/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const j = (await res.json()) as { ok?: boolean };
    return !!j.ok;
  } catch {
    return false;
  }
}
