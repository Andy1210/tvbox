// Nothing the shell runs may ask polkit a question it cannot answer.
//
// This is a source check rather than a unit test, because the bug it guards has no
// return value to assert on: a `systemctl` call that reaches polkit without
// `--no-ask-password` does not fail, it FREEZES THE BOX. systemctl answers
// "interactive authentication required" by spawning `pkttyagent`, which reads a
// controlling terminal; a background process group that reads a terminal is sent
// SIGTTIN, and SIGTTIN stops the whole group - Electron and `session.sh`, the
// respawn loop, together. The TV then stops answering the remote, the HTTP port
// goes dead, and `pkill` cannot recover it, because the loop that would respawn the
// shell is stopped too. It reads as a CEC fault. (Recovery is `kill -CONT` on
// session.sh.)
//
// Found on a real box through Settings -> Reboot, which had run without the flag
// since it was written. The audit that followed found the same shape in two more
// places, both added long after - which is the reason this is a test and not a
// comment: every one of them looked fine on its own.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// The CLI is the one caller that legitimately has a terminal: a human is sitting at
// it, and an authentication prompt there is a prompt, not a stopped session.
const HAS_A_TERMINAL = new Set(["cli.js"]);

function sourceFiles() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js") && !HAS_A_TERMINAL.has(f))
    .map((f) => [f, fs.readFileSync(path.join(__dirname, f), "utf8")]);
}

// Every `"systemctl"` argv0 in the file, paired with the argument list that follows
// it. Deliberately dumb: a call this cannot parse fails the test rather than being
// skipped, because "we could not tell" is the answer that let this bug in.
function systemctlCalls(source) {
  const calls = [];
  const re = /"systemctl"\s*,\s*\[/g;
  let m;
  while ((m = re.exec(source))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "[") depth++;
      else if (source[i] === "]" && --depth === 0) {
        end = i;
        break;
      }
    }
    assert.ok(end > 0, "could not read the argument list of a systemctl call");
    calls.push(source.slice(open, end + 1));
  }
  return calls;
}

test("no systemctl call can be answered with a password prompt", () => {
  let checked = 0;
  for (const [name, source] of sourceFiles()) {
    for (const args of systemctlCalls(source)) {
      checked++;
      // `--user` talks to the user's own systemd, which has no polkit in front of
      // it at all; everything else goes to the system bus and has to say so.
      const safe = args.includes("--no-ask-password") || args.includes('"--user"');
      assert.ok(safe, `${name}: systemctl call may prompt - add "--no-ask-password": ${args.replace(/\s+/g, " ")}`);
    }
  }
  // The count is the point: if a refactor moves these calls behind a helper this
  // check stops seeing them, and a green test that looks at nothing is worse than
  // no test. Bump it deliberately when a call is added or removed.
  assert.ok(checked >= 5, `expected to find the shell's systemctl calls, saw ${checked}`);
});
