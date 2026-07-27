// Typing for an app that has no keyboard. The shell reports a focused field in a
// remote app (xbox.com's sign-in, a YouTube search box), the launcher shows the
// typing screen, and whatever is submitted here is delivered to the app as real
// keystrokes. Session state lives in the shell (shell/textinput.js).
//
// This goes over the shell BRIDGE, not /tvbox/api: the API is same-origin with every
// local app bundle, and reading the pairing code or injecting keystrokes into another
// app's focused field must not be reachable from an app page.
export interface TypingStatus {
  active: boolean;
  app?: string;
  appName?: string; // who is asking, from the manifest - NOT page-authored
  kind?: string; // the field's input type ("text", "email", "password", …)
  password?: boolean;
  label?: string; // what the app calls the field (its placeholder/aria-label)
  url?: string; // phone typing: the pairing URL behind the QR (only once armed)
  code?: string; // …and the 4-digit code that gates it
}

interface TypingBridge {
  status(): Promise<TypingStatus>;
  submit(text: string): Promise<{ ok: boolean; error?: string }>;
  cancel(): Promise<unknown>;
  phone(): Promise<{ ok: boolean; url?: string; code?: string; error?: string }>;
}
const bridge = (): TypingBridge | undefined =>
  (window as unknown as { tvbox?: { typing?: TypingBridge } }).tvbox?.typing;

export async function fetchTypingStatus(): Promise<TypingStatus | null> {
  try {
    return (await bridge()?.status()) ?? null;
  } catch {
    return null;
  }
}

export async function submitTyping(text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return (await bridge()?.submit(text)) ?? { ok: false, error: "no bridge" };
  } catch {
    return { ok: false, error: "bridge" };
  }
}

export async function cancelTyping(): Promise<void> {
  try {
    await bridge()?.cancel();
  } catch {
    /* the shell drops the session on its own when the app leaves the foreground */
  }
}

// The QR is armed only on request: starting a pairing session opens a LAN server and
// mints a code, which must be a user's decision, not a side effect of a page focusing
// a field.
export async function armPhoneTyping(): Promise<{ url?: string; code?: string }> {
  try {
    const r = await bridge()?.phone();
    return r?.ok ? { url: r.url, code: r.code } : {};
  } catch {
    return {};
  }
}
