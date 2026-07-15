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

// Sleep timer: POST minutes (0 = cancel) or query with no args. Returns the
// epoch-ms the TV will turn off at, or null when no timer is armed.
export async function sleepTimer(minutes?: number): Promise<number | null> {
  try {
    const res =
      minutes === undefined
        ? await fetch("/tvbox/api/power/sleep-timer", { cache: "no-store" })
        : await fetch("/tvbox/api/power/sleep-timer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ minutes }),
          });
    const d = await res.json();
    return d.at || null;
  } catch {
    return null;
  }
}
