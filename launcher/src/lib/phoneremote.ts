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
}

// A box whose shell predates this answers 404, which is not the same as "no
// phones": the caller greys the feature out rather than offering one that cannot
// work. null means unsupported or unreachable.
export async function fetchPhoneRemote(): Promise<PhoneRemoteState | null> {
  try {
    const res = await fetch("/tvbox/api/phoneremote", { cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    return { enabled: !!d.enabled, phones: Array.isArray(d.phones) ? d.phones : [], port: Number(d.port) || 0 };
  } catch {
    return null;
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
