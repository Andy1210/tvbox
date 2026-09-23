// Child processes the shell starts for work it waits on (installs, dependency
// downloads, helper tools). Three guarantees every caller needs and used to
// hand-roll differently:
//
//   - a deadline: past `timeout` the whole process GROUP gets SIGTERM, and
//     SIGKILL `killAfter` later if anything is still there. A group, because
//     cli.js and the tools it runs (curl, git, flatpak) are its children;
//   - its own session (`detached`), so nothing it runs can open the session's
//     terminal and stop the shell's process group with SIGTTIN;
//   - exactly one completion call, whether it failed to spawn, exited, or was
//     killed ('error' and 'close' can both fire for one child).
const { spawn } = require("child_process");

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (e) {
    try {
      child.kill(signal);
    } catch (e2) {
      /* already gone */
    }
  }
}

// done({ code, signal, timedOut, error, stdout, stderr }) is called once.
// opts: everything spawn() takes, plus timeout (ms, 0 = none), killAfter (ms),
// onStdout/onStderr (per chunk), maxBuffer (bytes of stdout/stderr kept).
function spawnBounded(cmd, args, opts, done) {
  const { timeout = 0, killAfter = 5000, onStdout, onStderr, maxBuffer = 1e6, ...spawnOpts } = opts || {};
  let finished = false;
  let timedOut = false;
  let killTimer = null;
  let deadline = null;
  let stdout = "";
  let stderr = "";
  const finish = (r) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    clearTimeout(killTimer);
    done({ stdout, stderr, timedOut, ...r });
  };
  let child;
  try {
    child = spawn(cmd, args, { detached: true, ...spawnOpts });
  } catch (e) {
    finish({ code: null, signal: null, error: e });
    return null;
  }
  if (child.stdout)
    child.stdout.on("data", (d) => {
      if (stdout.length < maxBuffer) stdout += d;
      if (onStdout) onStdout(d);
    });
  if (child.stderr)
    child.stderr.on("data", (d) => {
      if (stderr.length < maxBuffer) stderr += d;
      if (onStderr) onStderr(d);
    });
  child.on("error", (e) => finish({ code: null, signal: null, error: e }));
  child.on("close", (code, signal) => finish({ code, signal }));
  if (timeout > 0) {
    deadline = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), killAfter);
    }, timeout);
  }
  return child;
}

// Promise form: resolves with the result object, never rejects.
function run(cmd, args, opts) {
  return new Promise((resolve) => spawnBounded(cmd, args, opts, resolve));
}

module.exports = { spawnBounded, run, killGroup };
