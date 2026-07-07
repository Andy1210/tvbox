// Settings backup/restore glue (shell routes /tvbox/api/backup/*). The heavy
// lifting is shell-side + on the phone (pairing page); the launcher has two
// jobs: hand its localStorage over before the QR session starts (locale, app
// order, onboarding state live here, invisible to the shell), and re-apply a
// restored snapshot on boot, then reload once.
export async function sendBackupContext(): Promise<boolean> {
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k != null) snapshot[k] = localStorage.getItem(k) ?? "";
  }
  try {
    const res = await fetch("/tvbox/api/backup/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localStorage: JSON.stringify(snapshot) }),
    });
    return (await res.json()).ok === true;
  } catch {
    return false;
  }
}

export async function fetchBackupStatus(): Promise<{ restoredAt: number | null } | null> {
  try {
    return await (await fetch("/tvbox/api/backup/status", { cache: "no-store" })).json();
  } catch {
    return null;
  }
}

// Boot path: a restore parked the old box's launcher storage shell-side -
// apply it to OUR localStorage, clear it (so this runs exactly once), reload.
// Returns true when a reload was triggered (the caller should render nothing).
export async function applyPendingRestore(): Promise<boolean> {
  try {
    const res = await fetch("/tvbox/api/backup/pending-localstorage", { cache: "no-store" });
    const d = await res.json();
    if (!d || typeof d.data !== "string" || !d.data) return false;
    const snapshot = JSON.parse(d.data) as Record<string, unknown>;
    for (const [k, v] of Object.entries(snapshot)) {
      if (typeof v === "string") localStorage.setItem(k, v);
    }
    await fetch("/tvbox/api/backup/pending-localstorage/clear", { method: "POST" });
    location.reload();
    return true;
  } catch {
    return false;
  }
}
