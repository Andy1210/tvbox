// Power actions via the shell. sleep = display off over CEC (box stays on);
// reboot/poweroff take the box down.
export type PowerAction = "sleep" | "reboot" | "poweroff";

export async function power(action: PowerAction): Promise<{ ok: boolean; error?: string }> {
  try {
    return await (
      await fetch("/tvbox/api/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
    ).json();
  } catch {
    return { ok: false }; // reboot/poweroff tears down the connection; that's expected
  }
}
