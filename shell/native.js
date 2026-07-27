// Native app support: an app whose UI is its OWN fullscreen Wayland window
// instead of a web bundle in a BrowserWindow. RetroArch is the first one.
//
// mpv is the precedent for spawning a native client from the shell, but the two
// are opposites and the difference is the whole design:
//
//   mpv          sits BEHIND a transparent Electron window and is driven over an
//                IPC socket, so the LAUNCHER keeps keyboard focus (D-pad works).
//   native app   owns the screen AND the input. Every Electron window hides
//                while it runs, so the app is the only visible toplevel and the
//                compositor hands it focus.
//
// Because the app holds focus, the renderer never sees a key press, so the
// launcher's usual Home escape cannot work. The uinput bridges (tvbox-cec,
// tvbox-remote) are told "a native app owns the screen" over their control
// FIFOs; while that is on they turn the Home button into a POST to the shell's
// own /tvbox/api/nav instead of a key event. Without it a native app would be a
// dead end on a TV with no keyboard. The mechanism is app-agnostic, so any
// future native app gets its escape hatch for free.
//
// Nothing here knows what RetroArch is. The command comes from the manifest's
// runtime.native block, which is validated as untrusted input (a registry
// manifest never sees CI).
const fs = require("fs");
const { spawn, execFile } = require("child_process");

const TERM_GRACE_MS = 3000; // app SIGTERM -> `flatpak kill`
const KILL_GRACE_MS = 6000; // ... -> SIGKILL the launcher process
const MAX_PROC_DEPTH = 4; // how far down the tree to look for the real app process
// The bridges keep "a native app is in front" in memory, so a bridge that
// restarts or crashes while an app is up comes back without it and swallows the
// Home button, stranding the user in an app they cannot leave. Re-asserting on a
// timer costs one write per bridge and recovers from that on its own.
const REASSERT_MS = 10000;

let deps = {
  childEnv: () => ({ ...process.env }), // spawn env carrying the session's Wayland vars
  bridgeCmd: () => {}, // (cmd) -> write cmd to BOTH uinput bridge FIFOs
  onExit: () => {}, // (id, code, signal) -> the app is gone, bring the launcher back
};
let proc = null; // the live child (`flatpak run ...` or a bare binary)
let appId = null; // manifest id of the running native app
let flatpakRef = null; // its flatpak ref, for the `flatpak kill` fallback
let stopping = false; // a teardown is already in flight (don't double-signal)
let reassert = null; // interval keeping the bridges in native mode

function init(d) {
  deps = { ...deps, ...d };
}

// A flatpak application id: reverse-DNS, letters/digits/dot/dash/underscore.
// Deliberately strict - this string reaches argv.
function refOk(ref) {
  return typeof ref === "string" && ref.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref);
}
// A plain executable name (resolved on PATH, which includes ~/.tvbox/bin) or an
// absolute path. No shell is ever involved (spawn with an argv array), but a
// name with a slash-dot-dot or whitespace is still a manifest bug worth refusing.
function binOk(bin) {
  return typeof bin === "string" && bin.length <= 255 && /^(\/[\w.-]+)+$|^[\w.-]+$/.test(bin);
}
function argsOk(args) {
  if (args === undefined) return true;
  return Array.isArray(args) && args.length <= 32 && args.every((a) => typeof a === "string" && !/[\r\n\0]/.test(a));
}

// Validate a manifest's runtime.native block -> { cmd, args, ref } or null.
// Exported so install.js can reject a bad manifest at load time with the SAME
// rules the launcher path uses; the two must not drift.
function parseSpec(nat) {
  if (!nat || typeof nat !== "object") return null;
  if (!argsOk(nat.args)) return null;
  const args = nat.args ? nat.args.slice() : [];
  if (nat.flatpak !== undefined) {
    if (!refOk(nat.flatpak)) return null;
    // `flatpak run` finds a --user install on its own. --die-with-parent is the
    // safety net that makes the sandbox impossible to orphan: without it the
    // sandbox is only a CHILD of this launcher process, so it survives the
    // launcher and gets reparented to init, leaving a full-screen app on the TV
    // that the shell no longer knows about.
    return { cmd: "flatpak", args: ["run", "--die-with-parent", nat.flatpak, ...args], ref: nat.flatpak };
  }
  if (nat.bin !== undefined) {
    if (!binOk(nat.bin)) return null;
    return { cmd: nat.bin, args, ref: null };
  }
  return null;
}

function running() {
  return !!proc;
}
function id() {
  return appId;
}

// Launch a native app. `extraArgs` lets a plugin add per-launch arguments (e.g.
// a core plus a ROM path) without putting them in the manifest. Returns false
// when the manifest's native block is unusable, so the caller can degrade
// instead of leaving a blank screen.
function start(m, extraArgs) {
  const spec = parseSpec(m && m.runtime && m.runtime.native);
  if (!spec) {
    console.warn("[native] bad or missing runtime.native for", m && m.id);
    return false;
  }
  if (!argsOk(extraArgs)) {
    console.warn("[native] bad extraArgs for", m.id);
    return false;
  }
  stop(); // one native app at a time: it owns the whole screen
  const args = extraArgs && extraArgs.length ? [...spec.args, ...extraArgs] : spec.args;
  let child;
  try {
    child = spawn(spec.cmd, args, { env: deps.childEnv(), detached: true, stdio: "ignore" });
  } catch (e) {
    console.error("[native]", m.id, "spawn threw:", e.message);
    return false;
  }
  proc = child;
  appId = m.id;
  flatpakRef = spec.ref;
  stopping = false;
  console.log("[native] launched", m.id, "pid", child.pid, spec.cmd, args.join(" "));
  // Tell the uinput bridges to route Home to the shell instead of the renderer:
  // from here until exit, nothing of ours has keyboard focus.
  deps.bridgeCmd("native on");
  clearInterval(reassert);
  reassert = setInterval(() => deps.bridgeCmd("native on"), REASSERT_MS);
  if (reassert.unref) reassert.unref(); // never hold the process open on its own
  // ENOENT/EACCES arrive as "error" with no usable "exit". Unhandled this would
  // take the shell down, and it must not leave the bridges in native mode.
  child.on("error", (e) => {
    console.error("[native]", m.id, "spawn failed:", e.message);
    child.removeAllListeners("exit"); // don't report the exit twice
    finish(child, null, null);
  });
  child.on("exit", (code, signal) => {
    console.log("[native]", m.id, "exited code", code, "sig", signal);
    finish(child, code, signal);
  });
  return true;
}

// Common teardown for both the error and the exit path. Guards on identity so a
// dying OLD child can never clear the state of a newer launch.
function finish(child, code, signal) {
  if (proc !== child) return;
  const wasId = appId;
  proc = null;
  appId = null;
  flatpakRef = null;
  stopping = false;
  clearInterval(reassert);
  reassert = null;
  deps.bridgeCmd("native off");
  try {
    deps.onExit(wasId, code, signal);
  } catch (e) {
    console.warn("[native] onExit handler failed:", e.message);
  }
}

// Is a pid still around? (Signal 0 tests existence without delivering anything.)
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}
// Every descendant of a pid, from /proc. A flatpak app is not the process we
// spawned: `flatpak run` is a launcher whose child is the bwrap sandbox, and the
// APP is inside that. Signalling the launcher does not reach the app, so the real
// pids have to be found to shut one down gracefully.
function descendants(pid, depth) {
  let raw;
  try {
    raw = fs.readFileSync("/proc/" + pid + "/task/" + pid + "/children", "utf8");
  } catch (e) {
    return []; // exited, or no procfs
  }
  const kids = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 1);
  if (depth <= 1) return kids;
  return kids.concat(...kids.map((k) => descendants(k, depth - 1)));
}

// Kill the running native app (leaving it, Home, an app switch, shutdown).
// SIGTERM goes to the app processes THEMSELVES so the app can save and exit
// cleanly (RetroArch writes its config and SRAM on a term signal, while a
// `flatpak kill` is a hard stop that loses both). Escalation is by pid liveness,
// deliberately not by "is this still our current child": the launcher process
// exits early on its own signal, which would otherwise look like success while
// the app kept running.
function stop() {
  if (!proc || stopping) return;
  stopping = true;
  const child = proc;
  const ref = flatpakRef;
  const appPids = descendants(child.pid, MAX_PROC_DEPTH);
  for (const p of appPids) {
    try {
      process.kill(p, "SIGTERM");
    } catch (e) {}
  }
  // No descendants means it IS the process we spawned (a plain `bin` app), so
  // signal that instead.
  if (!appPids.length) {
    try {
      child.kill("SIGTERM");
    } catch (e) {}
  }
  const stillUp = () => appPids.some(alive) || alive(child.pid);
  setTimeout(() => {
    if (!stillUp()) return;
    if (ref) {
      console.warn("[native] app ignored SIGTERM, flatpak kill", ref);
      execFile("flatpak", ["kill", ref], { env: deps.childEnv() }, () => {});
    }
  }, TERM_GRACE_MS);
  setTimeout(() => {
    if (!stillUp()) return;
    console.warn("[native] still alive, SIGKILL");
    for (const p of appPids.concat(child.pid)) {
      try {
        process.kill(p, "SIGKILL");
      } catch (e) {}
    }
  }, KILL_GRACE_MS);
}

// flatpakRefOk is exported so install.js can validate `requires.flatpak` refs
// against the SAME rule the launch path applies to runtime.native.flatpak.
module.exports = { init, start, stop, running, id, parseSpec, flatpakRefOk: refOk };
