// OTA update status/actions (shell routes /tvbox/api/update/*). The shell owns
// the whole flow (feed check, download, verify, symlink flip, restart); the
// launcher only renders status and pokes check/apply. While an install runs
// the shell keeps serving - poll status; the restart at the end drops the
// connection and the standard shell-unreachable retry screen bridges it.
export interface UpdateStatus {
  current: string;
  release: string | null; // versions/<v> when OTA-installed, null = dev tree
  state: "idle" | "checking" | "downloading" | "installing" | "restarting" | "error";
  error: string | null;
  latest: { version: string; notes: { en?: string; hu?: string } | null } | null;
  available: boolean;
  // What this box cannot satisfy for the release it can see: a version may need
  // something an update is not allowed to install (the compositor, an apt
  // package), and then the box has to be re-provisioned or re-flashed first.
  unmet?: string[];
  lastCheckAt: number | null;
  auto: boolean;
  failed: { from: string; to: string } | null; // an update rolled back
  last: { from: string; to: string; at: number } | null; // last successful update
  os: { rebootRequired: boolean; packages: string[] };
  system: SystemUpdate;
}

// The ROOT half of a release - the apt packages, grants and units an OTA cannot
// install. Part of this document rather than its own poller so there is one
// status shape to keep the demo mode and the UI in step with.
//
// Required, not optional: `launcher/src/demo/data.ts` types its fixture as
// UpdateStatus, so a required field is the one thing that makes the typecheck
// fail when the demo drifts from the shell.
export interface SystemUpdate {
  available: boolean; // is the root half installed on this box at all
  revision: number; // highest provision revision ever applied (0 = never)
  needs: number | null; // what the visible release is asking for, if anything
  feedRevision: number | null; // what the feed says it would install
  code: SystemUpdateCode;
  warnings: number;
  rebootRequired: boolean;
  at: number | null;
}

// Closed set, mirrored from shell/sysupdate.js. The applier is a root script and
// its own messages are English; only these codes cross into the UI, so a
// Hungarian TV never shows root-script text.
export type SystemUpdateCode =
  | "idle"
  | "starting"
  | "running"
  | "interrupted"
  | "available"
  | "up-to-date"
  | "ok"
  | "ok-warnings"
  | "timeout"
  | "busy"
  | "cooldown"
  | "unsigned-feed"
  | "no-space"
  | "no-keys"
  | "no-openssl"
  | "bad-config"
  | "bad-feed"
  | "bad-signature"
  | "bad-checksum"
  | "bad-tarball"
  | "stale-feed"
  | "rollback-refused"
  | "revision-mismatch"
  | "feed-unreachable"
  | "download-failed"
  | "provision-failed"
  | "insecure-install"
  | "internal"
  | "start-denied";

// Codes that mean the run is still going, so the screen keeps polling.
export const SYSTEM_UPDATE_BUSY: SystemUpdateCode[] = ["starting", "running"];

export async function fetchUpdateStatus(): Promise<UpdateStatus | null> {
  try {
    const res = await fetch("/tvbox/api/update/status", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()) as UpdateStatus;
  } catch {
    return null;
  }
}

async function post(action: string): Promise<UpdateStatus | null> {
  try {
    const res = await fetch("/tvbox/api/update/" + action, { method: "POST" });
    return (await res.json()) as UpdateStatus;
  } catch {
    return null; // apply's restart can kill the response mid-flight - expected
  }
}

export const checkUpdate = () => post("check");
export const applyUpdate = () => post("apply");
// The root half. Takes no arguments on purpose: the applier reads its own
// root-owned config and verifies the release itself, so nothing chosen here -
// or anywhere else the box user can write - decides what it installs.
export const applySystemUpdate = () => post("apply-system");
