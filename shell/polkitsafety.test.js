// Nothing the box runs by itself may stop to ask a question.
//
// This is a source check rather than a unit test, because the bug it guards has no
// return value to assert on: the failure mode is a STOPPED PROCESS GROUP. Measured
// on the living-room box, with the pre-fix power path put back deliberately:
//
//   curl rc=28 (no answer)   electron: Tl   session.sh: T, wchan: do_signal_stop
//   pkttyagent 4967 --notify-fd 12 --fallback        http: 000
//   polkitd: Registered Authentication Agent ... [pkttyagent --fallback]
//
// A tool that wants an answer opens the session's terminal (the shell's stdin is
// /dev/tty7 on a box), and a background process group that reads a terminal is sent
// SIGTTIN, which stops the whole group - Electron and `session.sh`, the respawn loop
// that would bring it back. The TV stops answering the remote, the HTTP port dies,
// and `pkill` makes it worse; recovery is killing the agent and `kill -CONT` on the
// group. It reads as a CEC fault, which is why it went undiagnosed for so long.
//
// Two families, and the second one is not about polkit at all:
//
//   1. systemd's client tools ask polkit, and answer to `--no-ask-password`.
//   2. `unzip` asks for a ZIP password by opening /dev/tty ITSELF, so redirecting
//      stdio does not stop it. `-P ""` is what makes it fail instead. (Verified:
//      a plain archive extracts unchanged with `-P ""`, an encrypted one exits 82
//      instead of waiting.)
//
// Found through Settings -> Reboot, which had been written this way from the start.
// The audit that followed found five more, every one of them added later and every
// one of them looking fine on its own - which is why this is a test.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
// Where the box's own code lives. `shell/` is scanned recursively, and the input
// bridges are here because one of them powers the box off from the remote's button.
const ROOTS = ["shell", "remote", "cec", "voice", "gamepad"];
// Anything that reaches polkit and takes `--no-ask-password`.
const SYSTEMD_TOOLS = ["systemctl", "timedatectl", "hostnamectl", "localectl", "loginctl"];
// Verbs that only READ. systemd authorises those for anyone, so they never reach
// polkit and can never prompt - listing them keeps the check about the calls that
// can actually stop the box, rather than making every status read carry a flag it
// does not need.
const READ_ONLY = ['"show"', '"status"', '"list-', '"is-active"', '"is-enabled"', '"cat"', '"show-'];
// How far after the tool's name its arguments can be and still be its arguments.
// Deliberately FORWARD-looking: a comment sits above a call, so a window that
// reached backwards could be satisfied by prose rather than by an argument.
const WINDOW = 200;

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "launcher-dist") continue;
        walk(full);
      } else if (/\.(js|py)$/.test(entry.name) && !entry.name.endsWith(".test.js")) {
        out.push([path.relative(REPO, full), fs.readFileSync(full, "utf8")]);
      }
    }
  };
  for (const root of ROOTS) {
    const dir = path.join(REPO, root);
    if (fs.existsSync(dir)) walk(dir);
  }
  return out;
}

// Every place the file names one of these tools AS A STRING - which covers a bare
// `execFile("systemctl", [...])` and a wrapped `["sudo", "-n", "systemctl", ...]`
// alike. The old version of this check only saw the first shape, and so could not
// see the sudo fallback in the very file the bug was found in.
function callsOf(source, tools) {
  const found = [];
  for (const tool of tools) {
    const quoted = '"' + tool + '"';
    for (let i = source.indexOf(quoted); i >= 0; i = source.indexOf(quoted, i + 1)) {
      found.push({
        tool,
        window: source.slice(i, i + WINDOW),
        // The one legitimate exception is a path only a HUMAN at a terminal can
        // reach, and it has to say so in a comment above itself rather than live in
        // a list here - an exemption nobody can grep for is one nobody re-checks.
        exempt: source.slice(Math.max(0, i - WINDOW * 3), i).includes("polkit-safety: human-terminal"),
      });
    }
  }
  return found;
}

test("no systemd client tool can be answered with a password prompt", () => {
  let checked = 0;
  for (const [name, source] of sources()) {
    for (const call of callsOf(source, SYSTEMD_TOOLS)) {
      checked++;
      // `--user` talks to the user's own systemd, which has no polkit in front of it.
      // The verb is the first argument, so a read is recognisable at the head of the
      // window rather than anywhere in it - `systemctl start x --show-something`
      // must not pass as a read.
      const head = call.window.slice(0, 60);
      const reads = READ_ONLY.some((verb) => head.includes(verb));
      const safe = call.exempt || reads || call.window.includes("--no-ask-password") || call.window.includes("--user");
      assert.ok(safe, `${name}: ${call.tool} may prompt - add "--no-ask-password": ${call.window.slice(0, 90)}`);
    }
  }
  // The count is the point: if a refactor hides these behind a helper this check
  // stops seeing them, and a green test that looks at nothing is worse than none.
  assert.ok(checked >= 8, `expected to find the box's systemd calls, saw ${checked}`);
});

test("unzip is never left able to ask for a password", () => {
  let checked = 0;
  for (const [name, source] of sources()) {
    for (const call of callsOf(source, ["unzip"])) {
      checked++;
      assert.ok(
        call.exempt || call.window.includes('"-P"'),
        `${name}: unzip can prompt on an encrypted archive - pass "-P", "": ${call.window.slice(0, 90)}`,
      );
    }
  }
  assert.ok(checked >= 2, `expected to find the unzip calls, saw ${checked}`);
});
