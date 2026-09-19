// Whether the box can still write to its card. GET /tvbox/api/storage/status,
// one read of /proc/self/mounts on the shell side (shell/storagehealth.js).
//
// `null` is a real answer and means the box cannot tell - an old shell, `vite
// dev`, a host that is not Linux. Only `readOnly === true` may put anything on
// screen: guessing either way is worse than saying nothing.
export interface StorageStatus {
  device: string;
  mountPoint: string;
  fsType: string;
  readOnly: boolean;
}

export async function fetchStorageStatus(): Promise<StorageStatus | null> {
  try {
    const res = await fetch("/tvbox/api/storage/status", { cache: "no-store" });
    const d = (await res.json()) as StorageStatus | null;
    return d && typeof d.readOnly === "boolean" ? d : null;
  } catch {
    return null;
  }
}
