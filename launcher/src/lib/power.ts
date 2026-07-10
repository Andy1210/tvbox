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

// Screensaver auto-sleep: the shell refuses while anything plays (slept: false)
// so background audio (Spotify Connect) survives; the caller just retries later.
export async function sleepIfIdle(): Promise<boolean> {
  try {
    const r = await (
      await fetch("/tvbox/api/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sleep_if_idle" }),
      })
    ).json();
    return !!r.slept;
  } catch {
    return false;
  }
}
