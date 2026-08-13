// The image stage's chroot block is an UNQUOTED heredoc, and that is a trap the
// file's own comments describe twice.
//
// Everything between `on_chroot <<CHROOT` and its terminator is expanded by the
// BUILD HOST before the chroot ever sees it. Two variables are meant to be -
// FIRST_USER_NAME and USER_HOME, which is the whole reason the heredoc is
// unquoted - and any other `$name` silently becomes an empty string. A retry
// loop added here lost its `$attempt` that way: the give-up test became
// `[ "" = 4 ]`, so the loop could exhaust, return 0, and let an hour-long build
// carry on with no Electron installed. `bash -n` cannot see it (a heredoc is
// data), shellcheck does not read into it, and the smoke test only catches the
// consequence, fifty minutes later and an hour up the log.
//
// The same block also warns against backticks and `$(...)`, for the same reason
// and with the same symptom - the build shell blames the line the heredoc OPENS
// on, not the line at fault.
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const STAGE = path.join(__dirname, "..", "image", "stage-tvbox", "01-tvbox", "00-run.sh");

// Expanded at build time on purpose: the chroot has no idea who the box user is.
const HOST_EXPANDED = new Set(["FIRST_USER_NAME", "USER_HOME", "ROOTFS_DIR"]);

function chrootBlocks(src) {
  const lines = src.split("\n");
  const blocks = [];
  let start = -1;
  let terminator = null;
  lines.forEach((line, i) => {
    if (terminator === null) {
      // Only UNQUOTED heredocs matter: a <<'CHROOT' passes everything through.
      const m = /^on_chroot\s*<<([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
      if (m) {
        terminator = m[1];
        start = i + 1;
      }
    } else if (line.trim() === terminator) {
      blocks.push({ from: start, to: i, body: lines.slice(start, i) });
      terminator = null;
    }
  });
  assert.equal(terminator, null, "an on_chroot heredoc is never terminated");
  return blocks;
}

test("the image stage has an unquoted chroot heredoc to police", () => {
  const blocks = chrootBlocks(fs.readFileSync(STAGE, "utf8"));
  assert.ok(blocks.length >= 1, "no `on_chroot <<CHROOT` block found - did it move or gain quotes?");
});

test("every variable in the chroot block is either host-expanded on purpose or escaped", () => {
  const src = fs.readFileSync(STAGE, "utf8");
  for (const block of chrootBlocks(src)) {
    block.body.forEach((line, n) => {
      const lineNo = block.from + n + 1;
      if (line.trim().startsWith("#")) return; // comments cannot break the chroot
      // An escaped \$name reaches the chroot intact; anything else is expanded
      // here and now. Match only the unescaped ones.
      for (const m of line.matchAll(/(^|[^\\])\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
        assert.ok(
          HOST_EXPANDED.has(m[2]),
          `00-run.sh:${lineNo} uses $${m[2]} inside the unquoted chroot heredoc, so the build host ` +
            `expands it to an empty string before the chroot runs. Write it as \\$${m[2]} if the chroot ` +
            `shell is meant to see it, or add it to HOST_EXPANDED if it really is a build-time value.\n` +
            `    ${line.trim()}`,
        );
      }
    });
  }
});

test("the chroot block runs nothing on the build host by accident", () => {
  const src = fs.readFileSync(STAGE, "utf8");
  for (const block of chrootBlocks(src)) {
    block.body.forEach((line, n) => {
      const lineNo = block.from + n + 1;
      if (line.trim().startsWith("#")) return;
      // Both forms of command substitution run on the BUILD HOST here, against
      // its filesystem and its packages - and the failure is reported against
      // the line the heredoc opens on, which is why this is worth a test.
      assert.ok(!/(^|[^\\])`/.test(line), `00-run.sh:${lineNo} has an unescaped backtick in the chroot heredoc`);
      assert.ok(!/(^|[^\\])\$\(/.test(line), `00-run.sh:${lineNo} has an unescaped $( in the chroot heredoc`);
    });
  }
});
