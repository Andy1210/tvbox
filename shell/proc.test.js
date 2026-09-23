const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const proc = require("./proc");

test("a command that cannot start completes exactly once, with the error", async () => {
  let calls = 0;
  const r = await new Promise((resolve) => {
    proc.spawnBounded("/nonexistent/tvbox-no-such-binary", [], { stdio: "ignore" }, (res) => {
      calls++;
      setTimeout(() => resolve(res), 100); // leave room for a second call to show up
    });
  });
  assert.equal(calls, 1);
  assert.ok(r.error);
});

test("a deadline kills the whole process group, children included", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-proc-"));
  const pidFile = path.join(dir, "grandchild");
  // The grandchild ignores nothing special; it must die with the group.
  const r = await proc.run("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], {
    stdio: "ignore",
    timeout: 300,
    killAfter: 300,
  });
  assert.equal(r.timedOut, true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    alive = false;
  }
  assert.equal(alive, false, "the grandchild outlived the deadline");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("output is collected and a clean exit reports its code", async () => {
  const r = await proc.run("sh", ["-c", "echo hi; exit 3"], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "hi");
  assert.equal(r.timedOut, false);
});
