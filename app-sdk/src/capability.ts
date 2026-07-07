// Typed access to the shell bridge for apps. The Electron preloads expose a
// `window.tvbox` object gated by the app's runtime.capabilities (nav/player/
// config/fetch/storage). This module is the single typed entry point apps use
// instead of reaching for `window.tvbox` untyped.
export interface TvboxBridge {
  launch(id: string): void;
  home(): void;
  play?(url: string): void;
  stop?(): void;
  pip?(on: boolean, rect?: unknown): void;
  onPlayer?(cb: (ev: unknown) => void): () => void;
  onCommand?(cb: (c: unknown) => void): () => void;
  onNotify?(cb: (n: unknown) => void): () => void;
  fetch?(url: string, opts?: unknown): Promise<unknown>;
  storage?: {
    get(k: string): Promise<string | null>;
    set(k: string, v: string): Promise<unknown>;
    remove(k: string): Promise<unknown>;
  };
}

// The shell bridge, or an empty object when running outside the shell (vite dev,
// tests) so optional-method calls simply no-op rather than throw on undefined.
export function tvbox(): TvboxBridge {
  return ((globalThis as any).window?.tvbox ?? {}) as TvboxBridge;
}

// Same-origin helper for the shell's /tvbox/api endpoints (thin wrapper over
// fetch so app code has one call site to point at the shell).
export async function api(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(path, opts);
}
