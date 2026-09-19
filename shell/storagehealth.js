// "Can this box still write to its card?"
//
// An SD card that fails does not announce itself. ext4 forces the filesystem
// read-only, and from then on the box keeps running out of the page cache for a
// while - the launcher is up, apps still draw, the remote still works - and then
// dies one piece at a time until the screen is black. Nothing on the way says
// what happened: the shell's own log cannot be written, and Raspberry Pi OS keeps
// the journal in /run, so a reboot takes the evidence with it.
//
// So the one thing a box in that state can still do is TELL somebody, out of
// memory and over the network, while it is still up. This module is the reading;
// diag.js publishes it retained on tvbox/<id>/diag and the launcher puts it on
// screen.
//
// Deliberately the cheapest check there is - one read of /proc/self/mounts, no
// exec, no probe write. A write probe would be the more direct question, but it
// is a write to a card that is already in trouble, on a timer, for ever.
const fs = require("fs");
const os = require("os");

const MOUNTS = "/proc/self/mounts";

// A read-only root is not always spelled `ro`. When ext4 hits an I/O error it
// forces the filesystem read-only, and on a 6.x kernel that is a filesystem state
// rather than a VFS flag, so the option list keeps its `rw` and gains a word at
// the end. Measured on a box whose SD card fell off the bus, kernel 6.18:
//
//   /dev/mmcblk0p2 / ext4 rw,noatime,emergency_ro 0 0     <- card failing
//   /dev/mmcblk0p2 / ext4 rw,noatime 0 0                  <- healthy
//
// A check that reads the first option, or looks for `ro` alone, calls the failing
// box healthy - which is the one answer this must never give.
const READ_ONLY_OPTIONS = new Set(["ro", "emergency_ro"]);

// /proc escapes the characters that would break the field split.
function unescapeField(s) {
  return String(s).replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
}

// The mount that holds `dir`: the longest mount point that is a prefix of it, and
// on a tie the LAST one, which is the one on top. The box's home is what the shell
// writes to, and it is not necessarily on the root filesystem.
function mountFor(text, dir) {
  let best = null;
  for (const line of String(text || "").split("\n")) {
    const f = line.split(" ");
    if (f.length < 4) continue;
    const mountPoint = unescapeField(f[1]);
    if (!mountPoint.startsWith("/")) continue;
    const within = dir === mountPoint || dir.startsWith(mountPoint === "/" ? "/" : mountPoint + "/");
    if (!within) continue;
    if (best && mountPoint.length < best.mountPoint.length) continue;
    best = { device: unescapeField(f[0]), mountPoint, fsType: f[2], options: f[3].split(",") };
  }
  return best;
}

// null means "this box cannot tell" - no mount line matched, or /proc could not be
// read at all (a dev host that is not Linux). Saying nothing is the safe answer
// here: a claim that the storage has failed takes a television off the wall for
// its owner, and a claim that it is fine is the silence this module exists to end.
function parseMounts(text, dir) {
  const m = mountFor(text, dir);
  if (!m) return null;
  return {
    device: m.device,
    mountPoint: m.mountPoint,
    fsType: m.fsType,
    readOnly: m.options.some((o) => READ_ONLY_OPTIONS.has(o)),
  };
}

// `read` is injected so the parsing can be tested without a Linux /proc.
function state(read) {
  try {
    return parseMounts((read || ((p) => fs.readFileSync(p, "utf8")))(MOUNTS), os.homedir());
  } catch (e) {
    return null;
  }
}

module.exports = { state, parseMounts, mountFor, unescapeField, MOUNTS, READ_ONLY_OPTIONS };
