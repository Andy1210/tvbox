// The supervisor with real child processes: the two behaviours worth testing are
// the ones that only show up against a real /proc and a real pipe.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
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

test("a leftover instance of the same service is cleared before starting", async () => {
  // What an orphan looks like: the same command line, not our child. A parent killed
  // by signal leaves exactly this, and it keeps the port or device the new one needs.
  const argv = ["sleep", "31"];
  const orphan = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
  await until(() => alive(orphan.pid));

  const sup = new Supervisor();
  const lines = [];
  sup.spawn("dup", { argv: () => argv, log: (m) => lines.push(m) });

  const cleared = await until(() => !alive(orphan.pid));
  const started = await until(() => lines.some((l) => l.startsWith("spawn: sleep 31")));
  sup.stop("dup");
  try {
    orphan.kill("SIGKILL");
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
