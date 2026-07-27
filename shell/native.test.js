// runtime.native validation tests. A native app's command line comes from a
// manifest, and a registry manifest dropped into ~/.tvbox/apps/ never sees CI,
// so parseSpec is the only thing standing between a bad (or hostile) manifest
// and argv. These tests pin what it accepts.
const test = require("node:test");
const assert = require("node:assert");
const native = require("./native");

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
  assert.deepStrictEqual(native.parseSpec({ flatpak: "org.libretro.RetroArch" }), {
    cmd: "flatpak",
    args: ["run", "--die-with-parent", "org.libretro.RetroArch"],
    ref: "org.libretro.RetroArch",
  });
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
