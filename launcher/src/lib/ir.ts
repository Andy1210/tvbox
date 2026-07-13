// IR blaster helpers (Settings → Peripherals). Test-send + backend health; the
// config itself goes through the shared config store (saveIr in @sdk/config).
export type IrSendResult = { ok: boolean; error?: string };
export interface IrStatus {
  configured: boolean;
  backend: string | null;
  connected: boolean | null; // null = stateless backend (HA), nothing to report
  actions: string[];
  lastError: string;
}

export async function sendIr(action: string): Promise<IrSendResult> {
  try {
    const res = await fetch("/tvbox/api/ir/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    return (await res.json()) as IrSendResult;
  } catch {
    return { ok: false, error: "shell unreachable" };
  }
}

export async function fetchIrStatus(): Promise<IrStatus | null> {
  try {
    const res = await fetch("/tvbox/api/ir/status", { cache: "no-store" });
    return (await res.json()) as IrStatus;
  } catch {
    return null;
  }
}
