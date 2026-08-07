// runtime.native validation tests. A native app's command line comes from a
// manifest, and a registry manifest dropped into ~/.tvbox/apps/ never sees CI,
// so parseSpec is the only thing standing between a bad (or hostile) manifest
// and argv. These tests pin what it accepts.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const native = require("./native");

// Run a real (harmless) native app under a throwaway HOME and hand back what
// landed in its ~/.tvbox. HOME is honoured by os.homedir() on POSIX, and native.js
// resolves the log path per launch, so this needs no module reloading.
// Pass a home back in to launch a second time into the same one.
async function launchUnderTempHome(id, home) {
  if (!home) {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-native-log-"));
    fs.mkdirSync(path.join(home, ".tvbox"));
  }
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    native.init({ childEnv: () => process.env, bridgeCmd: () => {}, onExit: () => {} });
    assert.strictEqual(native.start({ id, runtime: { native: { bin: "sleep", args: ["30"] } } }), true);
    return { home, logs: fs.readdirSync(path.join(home, ".tvbox")) };
  } finally {
    native.stop();
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    const deadline = Date.now() + 5000;
    while (!native.settled() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }
}

test("flatpak spec becomes a `flatpak run <ref>` command line", () => {
  const spec = native.parseSpec({ flatpak: "org.libretro.RetroArch", args: ["--fullscreen"] });
  assert.deepStrictEqual(spec, {
    cmd: "flatpak",
    args: ["run", "--die-with-parent", "org.libretro.RetroArch", "--fullscreen"],
    ref: "org.libretro.RetroArch",
  });
});

test("--die-with-parent is always passed: an orphaned sandbox would own the TV", () => {
  // The sandbox is a child of the `flatpak run` launcher, not of the shell. Without
  // this flag it survives the launcher, is reparented to init, and leaves a
  // full-screen app on screen that the shell no longer tracks.
  for (const nat of [{ flatpak: "org.libretro.RetroArch" }, { flatpak: "org.x.Y", args: ["-f"] }]) {
    assert.ok(native.parseSpec(nat).args.includes("--die-with-parent"));
  }
});

test("bin spec runs the binary straight (PATH includes ~/.tvbox/bin)", () => {
  const spec = native.parseSpec({ bin: "moonlight", args: ["stream", "pc"] });
  assert.deepStrictEqual(spec, { cmd: "moonlight", args: ["stream", "pc"], ref: null });
});

test("args are optional", () => {
  const spec = native.parseSpec({ flatpak: "org.libretro.RetroArch" });
  assert.strictEqual(spec.args[spec.args.length - 1], "org.libretro.RetroArch");
  assert.deepStrictEqual(
    { cmd: spec.cmd, ref: spec.ref },
    {
      cmd: "flatpak",
      ref: "org.libretro.RetroArch",
    },
  );
});

test("an absolute binary path is allowed", () => {
  const spec = native.parseSpec({ bin: "/usr/bin/retroarch" });
  assert.strictEqual(spec.cmd, "/usr/bin/retroarch");
});

test("a missing or malformed native block is refused", () => {
  for (const nat of [null, undefined, "retroarch", 42, {}, { args: ["--x"] }]) {
    assert.strictEqual(native.parseSpec(nat), null, JSON.stringify(nat) + " must not parse");
  }
});

test("a flatpak ref is strictly reverse-DNS, never a path or a shell string", () => {
  for (const ref of [
    "",
    "../../etc/passwd",
    "org.libretro.RetroArch; rm -rf /",
    "org.libretro RetroArch",
    "-org.libretro.RetroArch", // a leading dash would read as a flatpak option
    "org/libretro/RetroArch",
    "a".repeat(256),
  ]) {
    assert.strictEqual(native.parseSpec({ flatpak: ref }), null, JSON.stringify(ref) + " must be refused");
  }
});

test("a bin name cannot smuggle traversal or whitespace", () => {
  for (const bin of ["", "../../bin/sh", "retro arch", "retroarch\n-L evil", "rm -rf /", "./retroarch"]) {
    assert.strictEqual(native.parseSpec({ bin }), null, JSON.stringify(bin) + " must be refused");
  }
});

test("args must be clean strings and bounded in count", () => {
  const ref = "org.libretro.RetroArch";
  assert.strictEqual(native.parseSpec({ flatpak: ref, args: "--fullscreen" }), null, "args must be an array");
  assert.strictEqual(native.parseSpec({ flatpak: ref, args: [1, 2] }), null, "args must be strings");
  assert.strictEqual(native.parseSpec({ flatpak: ref, args: ["a\nb"] }), null, "no newline in an arg");
  assert.strictEqual(native.parseSpec({ flatpak: ref, args: ["a\0b"] }), null, "no NUL in an arg");
  assert.strictEqual(
    native.parseSpec({ flatpak: ref, args: new Array(33).fill("-x") }),
    null,
    "an unbounded arg list is a manifest bug",
  );
  assert.ok(native.parseSpec({ flatpak: ref, args: new Array(32).fill("-x") }), "32 args is still fine");
});

test("flatpak wins over bin when a manifest declares both (one code path, no ambiguity)", () => {
  const spec = native.parseSpec({ flatpak: "org.libretro.RetroArch", bin: "retroarch" });
  assert.strictEqual(spec.cmd, "flatpak");
  assert.strictEqual(spec.ref, "org.libretro.RetroArch");
});

test("nothing is running before a start", () => {
  assert.strictEqual(native.running(), false);
  assert.strictEqual(native.id(), null);
});

test("stop() on an idle manager is a no-op, not a throw", () => {
  assert.doesNotThrow(() => native.stop());
});

test("start refuses a manifest whose native block is unusable and stays idle", () => {
  assert.strictEqual(native.start({ id: "bogus", runtime: { native: { flatpak: "bad ref" } } }), false);
  assert.strictEqual(native.running(), false);
});

// The lifecycle against a REAL process, so the pid identity path (stamp, signal,
// settled) is exercised rather than just the parser. `sleep` is a plain `bin` app
// with no descendants, which is the branch that signals the spawned process itself.
test("start then stop drives a real process down, and settled() reports it", async () => {
  native.init({ childEnv: () => process.env, bridgeCmd: () => {}, onExit: () => {} });
  assert.strictEqual(native.start({ id: "sleeper", runtime: { native: { bin: "sleep", args: ["30"] } } }), true);
  try {
    assert.strictEqual(native.running(), true);
    assert.strictEqual(native.id(), "sleeper");
  } finally {
    // A failing assertion above must not leave the spawned process running for
    // the rest of its 30 seconds.
    native.stop();
  }
  const deadline = Date.now() + 5000;
  while (!native.settled() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(native.settled(), true, "the process was still alive after stop()");
  assert.strictEqual(native.running(), false, "the exit should have cleared the state");
});

// The log holds whatever the app printed - paths it opened, a share it mounted -
// so it is the user's, not the world's.
test("a native app's log is created owner-only", async () => {
  const { home, logs } = await launchUnderTempHome("sleeper");
  assert.deepStrictEqual(logs, ["native-sleeper.log"]);
  const st = fs.statSync(path.join(home, ".tvbox", "native-sleeper.log"));
  assert.strictEqual(st.mode & 0o777, 0o600, "mode was " + (st.mode & 0o777).toString(8));
  fs.rmSync(home, { recursive: true, force: true });
});

// A crash is reported after the box is back, i.e. after the next launch has
// already opened the log truncating. One kept generation is what leaves anything
// to read about the run that actually failed.
test("the run before this one is kept as .log.1", async () => {
  const { home } = await launchUnderTempHome("sleeper");
  const log = path.join(home, ".tvbox", "native-sleeper.log");
  fs.writeFileSync(log, "the run that crashed\n");
  const { logs } = await launchUnderTempHome("sleeper", home);
  assert.deepStrictEqual(logs.sort(), ["native-sleeper.log", "native-sleeper.log.1"]);
  assert.strictEqual(fs.readFileSync(log + ".1", "utf8"), "the run that crashed\n");
  fs.rmSync(home, { recursive: true, force: true });
});

// The id names the file, so an id that is not a manifest id (the validator allows
// only [a-z0-9_-]+) must not be reshaped into some other name - it gets no log,
// and the app still launches.
test("an id that is not a manifest id gets no log at all", async () => {
  const { home, logs } = await launchUnderTempHome("../escape");
  assert.deepStrictEqual(logs, [], "wrote " + logs.join(", "));
  fs.rmSync(home, { recursive: true, force: true });
});
