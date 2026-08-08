// Developer tools: the box's own debugging surfaces.
//
// Everything here does something a person working ON the box needs and a person
// watching TV does not, which is why it lives behind one door rather than
// scattered through Settings.

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

// Chromium's DevTools endpoint, for ONE boot: the shell's start script consumes
// the marker and deletes it. Writing it restarts the shell, because until it does
// the marker has done nothing. A port of 0 clears it instead.
export const setDebugPort = (port: number) =>
  post<{ ok: boolean; port?: number; restarting?: boolean; error?: string }>(
    "/tvbox/api/devtools/debugport",
    { port },
    { ok: false },
  );

// Letting a paired phone SEE the TV, for a while. Minutes of 0 stops it now.
export const shareScreen = (minutes: number) =>
  post<{ ok: boolean; until?: number; on?: boolean }>("/tvbox/api/phoneremote/screen", { minutes }, { ok: false });
