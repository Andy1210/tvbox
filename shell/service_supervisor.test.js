// The supervisor with real child processes. Everything here needs a real /proc or a
// real pipe to mean anything: a fake stderr never fills, and a fake process list
// never contains the orphan the reap exists for.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Supervisor } = require("./service_supervisor");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a predicate rather than a fixed delay: the reap path deliberately waits
// a beat before starting, and a fixed sleep either flakes or slows the suite.
async function until(pred, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(25);
  }
  return false;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

test("a service's stderr reaches the log, not just its exit code", async () => {
  const sup = new Supervisor();
  const lines = [];
  sup.spawn("noisy", {
    argv: () => ["sh", "-c", "echo 'address already in use' >&2; exit 1"],
    log: (m) => lines.push(m),
    ceiling: 1, // one rapid failure is enough; then it retries slowly and stays out of the way
  });
  // Both, and in either order: stderr arrives on the pipe before the exit event.
  const got = await until(
    () => lines.some((l) => l.includes("address already in use")) && lines.some((l) => l.startsWith("exited code 1")),
  );
  sup.stop("noisy");
  assert.ok(got, "the child's own reason and its exit code: " + JSON.stringify(lines));
});

test("the last line survives having no trailing newline", async () => {
  // What a service says on its way out is usually unterminated, and it is the line
  // worth having - dropping it puts back the exit-code-with-no-reason problem.
  const sup = new Supervisor();
  const lines = [];
  sup.spawn("abrupt", {
    argv: () => ["sh", "-c", "printf 'died mid-sentence' >&2; exit 3"],
    log: (m) => lines.push(m),
    ceiling: 1,
  });
  const got = await until(() => lines.some((l) => l === "died mid-sentence"));
  sup.stop("abrupt");
  assert.ok(got, "an unterminated final line must still be logged: " + JSON.stringify(lines));
});

test("a service with no log still has its stderr drained", async () => {
  // stderr is piped by default, so a spec without a log would leave a pipe nobody
  // reads - and a child that fills 64 KB of it blocks on write. The marker is what
  // makes this a real test: a blocked child never reaches the line that writes it.
  const marker = path.join(os.tmpdir(), "tvbox-sup-drain-" + process.pid);
  fs.rmSync(marker, { force: true });
  const sup = new Supervisor();
  sup.spawn("chatty", {
    // 400 KB of stderr, well past the 64 KB pipe, and then the marker.
    argv: () => [
      "sh",
      "-c",
      'awk \'BEGIN{while(n++<400){c=0; while(c++<1023) printf "x"; print ""}}\' >&2; : > \'' + marker + "'; exit 7",
    ],
  });
  const wrote = await until(() => fs.existsSync(marker), 15000);
  sup.stop("chatty");
  fs.rmSync(marker, { force: true });
  assert.ok(wrote, "a child writing 400 KB to an unlogged stderr must still run to the end");
});

test("a single enormous line does not grow without bound", async () => {
  const sup = new Supervisor();
  const lines = [];
  sup.spawn("oneline", {
    argv: () => ["sh", "-c", "awk 'BEGIN{while(c++<5000) printf \"y\"}' >&2; exit 4"],
    log: (m) => lines.push(m),
    ceiling: 1,
  });
  const got = await until(() => lines.some((l) => l.startsWith("yyy")));
  sup.stop("oneline");
  assert.ok(got, "the partial line must be reported: " + JSON.stringify(lines));
  const longest = Math.max(...lines.map((l) => l.length));
  assert.ok(longest <= 300, "and capped, longest was " + longest);
});

function ppidOf(pid) {
  try {
    const m = /^PPid:\s*(\d+)/m.exec(fs.readFileSync("/proc/" + pid + "/status", "utf8"));
    return m ? Number(m[1]) : -1;
  } catch (e) {
    return -1;
  }
}

// A real orphan, the way one actually appears: a shell backgrounds the process and
// exits, so the kernel reparents it. A process spawned straight from this test would
// have a LIVE parent and must not be reaped at all - which is the next test.
async function makeOrphan(cmd, matchArgv) {
  spawn("sh", ["-c", cmd + " &"], { stdio: "ignore" });
  let pid = -1;
  await until(() => {
    for (const entry of fs.readdirSync("/proc")) {
      const p = Number(entry);
      if (!p) continue;
      let cmdline;
      try {
        cmdline = fs.readFileSync("/proc/" + p + "/cmdline", "utf8");
      } catch (e) {
        continue;
      }
      if (cmdline.replace(/\0$/, "") === matchArgv.join("\0") && ppidOf(p) === 1) {
        pid = p;
        return true;
      }
    }
    return false;
  });
  return pid;
}

test("a leftover instance of the same service is cleared before starting", async () => {
  // What an orphan looks like: the same command line, no living parent. A shell that
  // died by signal leaves exactly this, holding the port the new one needs.
  const argv = ["sleep", "31"];
  const orphan = await makeOrphan("sleep 31", argv);
  assert.notStrictEqual(orphan, -1, "the test needs a genuinely orphaned process");

  const sup = new Supervisor();
  const lines = [];
  sup.spawn("dup", { argv: () => argv, log: (m) => lines.push(m) });

  const cleared = await until(() => !alive(orphan));
  const started = await until(() => lines.some((l) => l.startsWith("spawn: sleep 31")));
  sup.stop("dup");
  try {
    process.kill(orphan, "SIGKILL");
  } catch (e) {
    /* already reaped, which is the point */
  }

  assert.ok(cleared, "the leftover must be signalled");
  assert.ok(
    lines.some((l) => l.includes("cleared a leftover instance")),
    "and it must say so: " + JSON.stringify(lines),
  );
  assert.ok(started, "then the service starts");
});

test("an update changes a service's arguments, and the leftover is still its own", async () => {
  // The leftover that matters comes from the PREVIOUS release: its command line
  // differs by exactly the flag the new one added, so an exact match never finds it
  // and every respawn hits a port the old instance still holds. A service that can
  // name itself in its leading arguments is cleared anyway.
  const before = ["sleep", "32"];
  const after = ["sleep", "32", "--now-with-a-flag"];
  const orphan = await makeOrphan("sleep 32", before);
  assert.notStrictEqual(orphan, -1, "the test needs a genuinely orphaned process");

  const sup = new Supervisor();
  const lines = [];
  sup.spawn("dup2", { argv: () => after, reapPrefix: before, log: (m) => lines.push(m) });

  const cleared = await until(() => !alive(orphan));
  sup.stop("dup2");
  try {
    process.kill(orphan, "SIGKILL");
  } catch (e) {
    /* already reaped, which is the point */
  }
  assert.ok(cleared, "the previous version's instance must be signalled: " + JSON.stringify(lines));
});

test("a process with the same argv but a living parent is left alone", async () => {
  // "Kill whatever runs this command line" is a much broader promise than "clear my
  // own leftovers": a live parent means somebody else is supervising it.
  const argv = ["sleep", "34"];
  const keeper = spawn("sh", ["-c", "sleep 34 & wait"], { stdio: "ignore" });
  let victim = -1;
  await until(() => {
    for (const entry of fs.readdirSync("/proc")) {
      const p = Number(entry);
      if (!p) continue;
      try {
        if (fs.readFileSync("/proc/" + p + "/cmdline", "utf8").replace(/\0$/, "") !== argv.join("\0")) continue;
      } catch (e) {
        continue;
      }
      if (ppidOf(p) === keeper.pid) {
        victim = p;
        return true;
      }
    }
    return false;
  });
  assert.notStrictEqual(victim, -1, "the test needs a live-parented process to protect");

  const sup = new Supervisor();
  const lines = [];
  sup.spawn("polite", { argv: () => argv, log: (m) => lines.push(m) });
  await until(() => lines.some((l) => l.startsWith("spawn: sleep 34")));
  const survived = alive(victim);
  sup.stop("polite");
  keeper.kill("SIGKILL");
  try {
    process.kill(victim, "SIGKILL");
  } catch (e) {
    /* fine */
  }

  assert.ok(survived, "someone else's supervised child must not be reaped");
  assert.ok(
    !lines.some((l) => l.includes("cleared a leftover instance")),
    "and nothing should claim it cleared one: " + JSON.stringify(lines),
  );
});

test("reaping does not touch another service's live child", async () => {
  const sup = new Supervisor();
  const lines = [];
  sup.spawn("keeper", { argv: () => ["sleep", "32"], log: (m) => lines.push(m) });
  await until(() => lines.some((l) => l.startsWith("spawn: sleep 32")));
  const keeper = sup.svcs.get("keeper").proc.pid;

  // A different service whose argv differs must leave the first one running - the
  // match is the whole argument list, so "sleep" alone is not a match.
  sup.spawn("other", { argv: () => ["sleep", "33"], log: () => {} });
  await sleep(300);
  const survived = alive(keeper);
  sup.stopAll();
  assert.ok(survived, "an unrelated service must not be reaped");
});
