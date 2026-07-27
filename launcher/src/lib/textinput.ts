// Typing for an app that has no keyboard. The shell reports a focused field in a
// remote app (xbox.com's sign-in, a YouTube search box), the launcher shows the
// typing screen, and whatever is submitted here is delivered to the app as real
// keystrokes. Session state lives in the shell (lib/textinput.js).
export interface TypingStatus {
  active: boolean;
  app?: string;
  kind?: string; // the field's input type ("text", "email", "password", …)
  password?: boolean;
  label?: string; // what the app calls the field (its placeholder/aria-label)
  url?: string; // phone typing: the pairing URL behind the QR
  code?: string; // …and the 4-digit code that gates it
}

export async function fetchTypingStatus(): Promise<TypingStatus | null> {
  try {
    const r = await fetch("/tvbox/api/textinput/status", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as TypingStatus;
  } catch {
    return null;
  }
}

export async function submitTyping(text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/tvbox/api/textinput/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return await r.json();
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function cancelTyping(): Promise<void> {
  try {
    await fetch("/tvbox/api/textinput/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    /* the shell drops the session on its own when the app leaves the foreground */
  }
}
