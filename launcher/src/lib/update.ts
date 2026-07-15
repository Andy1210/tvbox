// OTA update status/actions (shell routes /tvbox/api/update/*). The shell owns
// the whole flow (feed check, download, verify, symlink flip, restart); the
// launcher only renders status and pokes check/apply. While an install runs
// the shell keeps serving - poll status; the restart at the end drops the
// connection and the standard shell-unreachable retry screen bridges it.
export interface UpdateStatus {
  current: string;
  release: string | null; // versions/<v> when OTA-installed, null = dev tree
  state: "idle" | "checking" | "downloading" | "installing" | "restarting" | "error";
  error: string | null;
  latest: { version: string; notes: { en?: string; hu?: string } | null } | null;
  available: boolean;
  lastCheckAt: number | null;
  auto: boolean;
  failed: { from: string; to: string } | null; // an update rolled back
  last: { from: string; to: string; at: number } | null; // last successful update
  os: { rebootRequired: boolean; packages: string[] };
}

export async function fetchUpdateStatus(): Promise<UpdateStatus | null> {
  try {
    const res = await fetch("/tvbox/api/update/status", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()) as UpdateStatus;
  } catch {
    return null;
  }
}

async function post(action: string): Promise<UpdateStatus | null> {
  try {
    const res = await fetch("/tvbox/api/update/" + action, { method: "POST" });
    return (await res.json()) as UpdateStatus;
  } catch {
    return null; // apply's restart can kill the response mid-flight - expected
  }
}

export const checkUpdate = () => post("check");
export const applyUpdate = () => post("apply");
