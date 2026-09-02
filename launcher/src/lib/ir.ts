// IR blaster helpers (Settings → Peripherals). Test-send + backend health; the
// config itself goes through the shared config store (saveIr in @sdk/config).
export type IrSendResult = { ok: boolean; error?: string };
export interface IrStatus {
  configured: boolean;
  backend: string | null;
  // null = nothing to report: a stateless backend (HA), or a firetv link whose resident
  // service has not answered yet. NOT the same as false, which means the link is down -
  // and a down link is still one button press from working.
  connected: boolean | null;
  actions: string[];
  lastError: string;
  // What lastError MEANS, classified by the shell (ir.js causeOf) so the screen and the
  // TV toast say the same thing in the viewer's language. Null when there is no error.
  cause: string | null;
}

export async function sendIr(action: string): Promise<IrSendResult> {
  try {
    const res = await fetch("/tvbox/api/ir/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `test: true` opts out of the box's on-screen failure note: this row shows its
      // own result on the screen the person is already looking at, and two reports of
      // one press is one too many.
      body: JSON.stringify({ action, test: true }),
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
