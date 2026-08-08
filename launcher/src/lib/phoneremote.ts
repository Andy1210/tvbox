// A phone acting as the remote (shell/phoneremote.js).
//
// The paired phones do NOT come from the config store: their rows carry a token
// hash, so the shell keeps them off publicConfig and answers them here instead,
// as names and times only.

export interface PairedPhone {
  id: string;
  name: string;
  addedAt: number;
  lastSeenAt: number | null;
}

export interface PhoneRemoteState {
  enabled: boolean;
  phones: PairedPhone[];
  port: number;
  // Epoch ms until which a paired phone may see the TV, or 0. Separate from
  // `enabled`: pressing buttons and watching the screen are two permissions.
  screenUntil: number;
  // Where a phone goes - the same address for every paired one, and with no
  // pairing code on it. Empty when there is nothing to point anyone at.
  url: string;
}

// A 404 and a socket that went away are not the same answer, and telling them
// apart is the difference between "your box is too old" and "try again". The
// second is recoverable and must offer a retry rather than a dead end - the same
// rule every other screen here follows.
export type PhoneRemoteResult = { kind: "ok"; state: PhoneRemoteState } | { kind: "unsupported" } | { kind: "error" };

export async function fetchPhoneRemote(): Promise<PhoneRemoteResult> {
  try {
    const res = await fetch("/tvbox/api/phoneremote", { cache: "no-store" });
    if (res.status === 404) return { kind: "unsupported" };
    if (!res.ok) return { kind: "error" };
    const d = await res.json();
    return {
      kind: "ok",
      state: {
        enabled: !!d.enabled,
        phones: Array.isArray(d.phones) ? d.phones : [],
        port: Number(d.port) || 0,
        screenUntil: Number(d.screenUntil) || 0,
        url: typeof d.url === "string" ? d.url : "",
      },
    };
  } catch {
    return { kind: "error" };
  }
}

async function post<T>(path: string, body: unknown, fallback: T): Promise<T> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

// Turning it off also forgets the paired phones - the shell's decision, mirrored
// in what this returns so the list on screen is never stale.
export const setPhoneRemoteEnabled = (enabled: boolean) =>
  post<{ ok: boolean; enabled?: boolean; phones?: PairedPhone[] }>(
    "/tvbox/api/phoneremote/enable",
    { enabled },
    { ok: false },
  );

export const armPhoneRemote = () =>
  post<{ ok: boolean; url?: string; shortUrl?: string; code?: string }>(
    "/tvbox/api/phoneremote/arm",
    {},
    { ok: false },
  );

export const disarmPhoneRemote = () =>
  post<{ ok: boolean; phones?: PairedPhone[] }>("/tvbox/api/phoneremote/disarm", {}, { ok: false });

export const forgetPhone = (id: string) =>
  post<{ ok: boolean; phones?: PairedPhone[] }>("/tvbox/api/phoneremote/forget", { id }, { ok: false });
