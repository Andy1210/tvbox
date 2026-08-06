import { useEffect, useRef, useState } from "react";

// The values a category pane shows on the right of its rows - the current network,
// whether the file server is up. They exist so the top level answers "what is this
// set to?" without making the user open every page.
//
// They also have to be cheap, and that is the whole reason this file exists:
// selection follows focus on the rail, so a pane mounts on EVERY press of up or
// down, and some of these reads shell out on the box (nmcli takes its time). A
// short shared TTL turns holding the D-pad down the rail into one call per value
// instead of one per press, and a pane that comes back within the window renders
// its value on the first frame rather than flashing a dash.
//
// Deliberately not a store: nothing here is authoritative. The page behind the row
// re-reads on mount and is what the user acts on; this is only the label.
const TTL_MS = 8000;

interface Entry {
  at: number;
  value: unknown;
  inflight?: Promise<unknown>;
}
const cache = new Map<string, Entry>();

/** Invalidate a summary after something changed it, so stepping back out to the
 *  category shows the new state instead of the cached one. */
export function invalidateSummary(key: string): void {
  cache.delete(key);
}

export function useSummary<T>(key: string, load: () => Promise<T>): T | undefined {
  const fresh = cache.get(key);
  const [value, setValue] = useState<T | undefined>(
    fresh && Date.now() - fresh.at < TTL_MS ? (fresh.value as T) : undefined,
  );
  // The loader is keyed by `key`, so it must not also be a dependency: call sites
  // pass an inline closure (`() => fetchIrStatus()`), which would be a new function
  // on every render and re-run the effect forever.
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    let live = true;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setValue(hit.value as T);
      return;
    }
    // Share one request between panes that mount while it is still open - holding
    // the D-pad can mount the same pane again before the first answer lands.
    const p = (hit?.inflight as Promise<T> | undefined) ?? loader.current();
    cache.set(key, { at: hit?.at ?? 0, value: hit?.value, inflight: p });
    void p
      .then((v) => {
        cache.set(key, { at: Date.now(), value: v });
        if (live) setValue(v);
      })
      .catch(() => {
        cache.delete(key);
      });
    return () => {
      live = false;
    };
  }, [key]);

  return value;
}
