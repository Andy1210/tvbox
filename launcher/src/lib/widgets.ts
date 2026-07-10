// HOME-screen widgets: plugin-pushed cards (e.g. Spotify's now-playing while a
// cast is active). Initial state over HTTP, live updates over the preload
// bridge; pressing a card opens its app. See docs/app-manifest.md (host plugin
// widget API) - the launcher renders whatever the shell sanitized.
export interface HomeWidget {
  id: string; // app id - the card opens this app
  title: string;
  subtitle: string;
}

export async function fetchWidgets(): Promise<HomeWidget[]> {
  try {
    const res = await fetch("/tvbox/api/widgets", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return ((await res.json()).widgets as HomeWidget[]) || [];
  } catch {
    return [];
  }
}

export function subscribeWidgets(cb: (w: HomeWidget[]) => void): () => void {
  return window.tvbox?.onWidgets?.(cb) || (() => {});
}
