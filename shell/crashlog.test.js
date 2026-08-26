// The record a crash leaves behind.
//
// It is the only thing that survives the restart, so the three properties it needs
// are the ones tested here: appended (a crash LOOP reads exactly like one crash
// when each overwrites the last), capped (that loop must not fill the card), and
// 0600 with no symlink followed (~/.tvbox is reachable through the file server).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-crashlog-"));
process.env.HOME = home;

const crashlog = require("./crashlog");

let n = 0;
const tmp = (name) => path.join(home, name + "-" + ++n);

test("a stack is appended, so a loop of crashes is legible as a loop", () => {
  const f = tmp("log");
  crashlog.writeCrashLog("first", f);
  crashlog.writeCrashLog("second", f);
  const body = fs.readFileSync(f, "utf8");
  assert.match(body, /first/);
  assert.match(body, /second/);
  assert.ok(body.indexOf("first") < body.indexOf("second"));
});

test("each entry carries a timestamp and the shell version", () => {
  const f = tmp("log");
  crashlog.writeCrashLog("boom", f);
  const body = fs.readFileSync(f, "utf8");
  assert.match(body, /^\d{4}-\d\d-\d\dT[\d:.]+Z v\S+\n/, "the first line names when and which version");
});

test("the file is 0600, and an existing loose one is tightened", () => {
  const f = tmp("log");
  fs.writeFileSync(f, "", { mode: 0o644 });
  crashlog.writeCrashLog("x", f);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test("past the cap it starts again, rather than growing until the card is full", () => {
  const f = tmp("log");
  fs.writeFileSync(f, "x".repeat(crashlog.CRASH_LOG_MAX + 10), { mode: 0o600 });
  crashlog.writeCrashLog("after the cap", f);
  const body = fs.readFileSync(f, "utf8");
  assert.ok(body.length < crashlog.CRASH_LOG_MAX, "truncated: " + body.length);
  assert.match(body, /after the cap/);
});

test("one stack is capped - an Error's message is whatever threw it", () => {
  const f = tmp("log");
  crashlog.writeCrashLog("y".repeat(crashlog.CRASH_STACK_MAX * 2), f);
  const body = fs.readFileSync(f, "utf8");
  assert.ok(body.length < crashlog.CRASH_STACK_MAX + 200, "a plugin's whole payload must not land here");
});

test("a symlink planted at the path is not written through", () => {
  const target = tmp("target");
  fs.writeFileSync(target, "untouched");
  const link = tmp("link");
  fs.symlinkSync(target, link);
  crashlog.writeCrashLog("should not arrive", link);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
});

test("a path that is not a regular file takes no write", () => {
  const dir = tmp("dir");
  fs.mkdirSync(dir);
  crashlog.writeCrashLog("nowhere", dir); // a directory: opens or fails, never writes
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a path that cannot be opened at all is survivable - no crash log beats a crash", () => {
  crashlog.writeCrashLog("x", path.join(home, "no", "such", "dir", "log"));
});

// ---- the marker the launcher reads once ----

test("the notice is created once, and consuming it is what clears it", () => {
  const f = tmp("notice");
  assert.equal(crashlog.markNotice(f), true);
  assert.equal(crashlog.markNotice(f), false, "a second crash nobody has been told about yet is nothing to do");
  assert.equal(crashlog.takeNotice(f), true);
  assert.equal(crashlog.takeNotice(f), false, "an ordinary start");
  assert.equal(crashlog.markNotice(f), true, "and the next crash can raise it again");
});

test("the notice is 0600", () => {
  const f = tmp("notice");
  crashlog.markNotice(f);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test("a symlink at the notice path is refused rather than followed", () => {
  const target = tmp("nt");
  const link = tmp("nlink");
  fs.symlinkSync(target, link);
  assert.equal(crashlog.markNotice(link), false, "wx never follows a symlink");
  assert.equal(fs.existsSync(target), false);
});

// ---- the handler itself ----

test("install registers exactly one handler, and it exits after doing its work", () => {
  // Run in a child: the handler exits the process, and it is registered on
  // `process` itself.
  const { spawnSync } = require("node:child_process");
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-crashrun-"));
  fs.mkdirSync(path.join(box, ".tvbox")); // the box always has one; the writer does not create it
  const script = path.join(box, "run.js");
  fs.writeFileSync(
    script,
    `
    process.env.HOME = ${JSON.stringify(box)};
    const crashlog = require(${JSON.stringify(path.join(__dirname, "crashlog.js"))});
    let stopped = false;
    crashlog.install({
      stopServices: () => { stopped = true; },
      exit: (code) => {
        console.log("EXIT " + code + " stopped=" + stopped);
        process.exit(0);
      },
    });
    setTimeout(() => { throw new Error("a secret-bearing failure"); }, 0);
    `,
  );
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, HOME: box } });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.match(out, /EXIT 1 stopped=true/, out);
  assert.match(out, /uncaught exception - restarting/);
  const log = fs.readFileSync(path.join(box, ".tvbox", "shell.crash.log"), "utf8");
  assert.match(log, /a secret-bearing failure/);
  assert.equal(fs.existsSync(path.join(box, ".tvbox", "crash-notice")), true, "the next launcher load says so");
  fs.rmSync(box, { recursive: true, force: true });
});
