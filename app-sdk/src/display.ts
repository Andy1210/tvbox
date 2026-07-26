// Adaptive display mode for apps that play video THEMSELVES (a <video> element,
// their own WASM/JS player) rather than handing a URL to the shell's mpv - that
// path already matches the output on its own.
//
// The shell draws the UI at up to 1080p and switches the output to suit the
// content while it plays: refresh first (a 23.976 film on a 60Hz output judders
// even though no frame is dropped), then the smallest resolution that still covers
// the video, never below 720p.
//
// Without the `display` capability every call is a benign no-op
// (`{ ok: true, changed: false, reason: "no-capability" }`), so an app can call
// these unconditionally - not holding the capability is a manifest decision, not a
// runtime error.
import { useEffect } from "react";
import { tvbox } from "./capability";

// What the app is about to show. `fps` is the CONTENT's own framerate (24000/1001
// = 23.976, not a rounded 24) - the app knows it from its own metadata; a
// <video> element does not expose it.
export interface VideoMode {
  width: number;
  height: number;
  fps: number;
}

// What the shell did. `changed: false` with no error is the normal "this panel has
// nothing better to offer" answer - the app should just keep playing.
export interface DisplayClaim {
  ok: boolean;
  changed?: boolean; // a switch really happened (false = the output was already right)
  reason?: string; // "no-matching-mode" | "no-capability" | "superseded" | …
  mode?: { width: number; height: number; refresh: number };
  error?: string; // only for a broken bridge, never for a missing capability
}

export interface DisplayBridge {
  claimForVideo(v: VideoMode): Promise<DisplayClaim>;
  release(): Promise<DisplayClaim>;
}

const bridge = (): DisplayBridge | undefined => tvbox().display;

const NO_CAP: DisplayClaim = { ok: true, changed: false, reason: "no-capability" };

export async function claimForVideo(v: VideoMode): Promise<DisplayClaim> {
  const d = bridge();
  if (!d) return NO_CAP;
  try {
    return await d.claimForVideo(v);
  } catch {
    return { ok: false, error: "bridge error" };
  }
}

export async function releaseVideoMode(): Promise<DisplayClaim> {
  const d = bridge();
  if (!d) return NO_CAP;
  try {
    return await d.release();
  } catch {
    return { ok: false, error: "bridge error" };
  }
}

// Claim while `video` is set, release when it clears or the component unmounts -
// the release is the part apps forget, which is why this hook exists. Pass null
// while nothing plays (paused is fine to keep claimed; stopped is not).
export function useVideoDisplayMode(video: VideoMode | null): void {
  const w = video?.width ?? 0;
  const h = video?.height ?? 0;
  const fps = video?.fps ?? 0;
  useEffect(() => {
    if (!(fps > 0)) return;
    claimForVideo({ width: w, height: h, fps });
    return () => {
      releaseVideoMode();
    };
  }, [w, h, fps]);
}
