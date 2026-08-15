// Typed access to the shell bridge for apps. The Electron preloads expose a
// `window.tvbox` object gated by the app's runtime.capabilities (nav/player/
// config/fetch/storage). This module is the single typed entry point apps use
// instead of reaching for `window.tvbox` untyped.

// ---- player capability ----
// Events the shell pushes to onPlayer(cb) as mpv changes state (emitted by
// shell/main.js `emit(...)`). `ms` carries position/duration in milliseconds.
export interface PlayerEvent {
  type: "playing" | "buffering" | "finished" | "error" | "position" | "duration";
  on?: boolean; // buffering on/off
  ms?: number; // position / duration, in milliseconds
  /** Why playback ended, when it did not simply run out: "tv-standby", "stopped".
   * An app that auto-advances on `finished` should not do so when this is set. */
  reason?: string;
}

// Device-pixel rectangle for pip() (shrink the current channel to a PiP box).
export interface PipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---- nav capability (main window only) ----
// On-screen notification forwarded from the shell (from MQTT: HA alerts,
// doorbell camera, …). Receive-only.
export interface TvNotification {
  title?: string;
  message?: string;
  image?: string; // e.g. a doorbell camera snapshot URL
  duration?: number; // ms before auto-dismiss (0 = sticky)
  raise?: boolean; // bring the launcher window forward (over a remote app)
}

// A media command forwarded from the shell (MQTT tv_control) so the active app
// can drive its own player (e.g. Spotify transport: pause/play/next/previous).
export interface TvCommand {
  action: string;
  app?: string;
}

// Launcher navigation pushed by the shell while the launcher is already up (a
// remapped Settings/Home button on the remote → /tvbox/api/nav). `dest` is the
// target surface, e.g. "settings" or "home".
export interface NavEvent {
  dest: string;
}

// ---- fetch capability: scoped server-side data proxy ----
// Request options an app may pass to fetch(). Only GET/POST/HEAD are allowed and
// the header set is allowlisted shell-side (see shell/appfetch.js).
export interface FetchRequest {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
}

// What the shell returns from fetch(). A discriminated union on `ok`: a success
// carries the response, a failure carries a reason string (see docs/capabilities.md
// and shell/appfetch.js `proxy(...)`). Response headers are lowercased + allowlisted.
export type FetchResponse =
  { ok: true; status: number; headers: Record<string, string>; body: string } | { ok: false; error: string };

// ---- display capability: adaptive output mode ----
// Type-only import (erased at build time, so no runtime cycle): the client and
// its types live in display.ts, but the bridge shape belongs on TvboxBridge.
import type { DisplayBridge } from "./display";

// ---- storage capability: per-app key/value ----
// (Named to avoid shadowing the DOM `Storage` lib type.)
export interface StorageBridge {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  remove(key: string): Promise<unknown>;
}

// One audio or subtitle track of what is playing (window.tvbox.tracks()).
export interface PlayerTrack {
  type: "audio" | "sub";
  id: number;
  lang: string;
  title: string;
  selected: boolean;
}

export interface TvboxBridge {
  launch(id: string): void;
  home(): void;
  /** `streams` is the app's own track decision in 0-based ordinals per type;
   * `startPos` (seconds) is where to begin, e.g. a film being resumed. */
  play?(url: string, streams?: { audio?: number; sub?: number; subFile?: string }, startPos?: number): void;
  stop?(): void;
  pause?(): void;
  resume?(): void;
  /** Absolute position, in seconds. */
  seek?(posSec: number): void;
  tracks?(): Promise<PlayerTrack[]>;
  /** `id` is a track id from tracks(), or "no" / "auto" - the shell ignores
   * anything else, so the type says so rather than letting it look accepted. */
  setTrack?(type: "audio" | "sub", id: number | "no" | "auto"): void;
  pip?(on: boolean, rect?: PipRect): void;
  onPlayer?(cb: (ev: PlayerEvent) => void): () => void;
  onCommand?(cb: (c: TvCommand) => void): () => void;
  onNotify?(cb: (n: TvNotification) => void): () => void;
  onNav?(cb: (n: NavEvent) => void): () => void;
  /** The box's screensaver. `request()` asks for it over this app: the ambient
   * screen belongs to the launcher, whose window is hidden while an app is in
   * front, so an app whose own screen has nothing to show has to ask rather than
   * wait. Any key on the screensaver returns here. Ignored unless this app is the
   * one on screen and the owner has the screensaver on. */
  ambient?: { request(): void; done(): void };
  fetch?(url: string, opts?: FetchRequest): Promise<FetchResponse>;
  storage?: StorageBridge;
  display?: DisplayBridge;
}

// The shell bridge, or a no-op stub when running outside the shell (vite dev,
// tests). The optional methods are absent (so `?.()` call sites no-op), but the
// REQUIRED ones (launch/home) get no-op defaults here so a direct `tvbox().home()`
// doesn't throw off-shell; the real bridge, when present, overrides them.
export function tvbox(): TvboxBridge {
  const bridge = (globalThis as { window?: { tvbox?: Partial<TvboxBridge> } }).window?.tvbox;
  // Spread the real bridge FIRST, then fill the required methods only when absent
  // or explicitly undefined - a bridge carrying `home: undefined` must not defeat
  // the no-op default. Signatures mirror TvboxBridge (launch takes an id).
  return {
    ...bridge,
    launch: bridge?.launch ?? ((_id: string) => {}),
    home: bridge?.home ?? (() => {}),
  } as TvboxBridge;
}

// Same-origin helper for the shell's /tvbox/api endpoints (thin wrapper over
// fetch so app code has one call site to point at the shell).
export async function api(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(path, opts);
}
