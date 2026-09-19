const { test } = require("node:test");
const assert = require("node:assert");
const sh = require("./storagehealth");

// The lines in here are real: taken from two boxes on the same kernel (6.18), one
// whose SD card had just fallen off the bus and one that was fine. The pair is the
// whole point of the module, so it is the first thing the suite holds.
const FAILING = "/dev/mmcblk0p2 / ext4 rw,noatime,emergency_ro 0 0\n";
const HEALTHY = "/dev/mmcblk0p2 / ext4 rw,noatime 0 0\n";

test("a failing card is read-only even though its options still start with rw", () => {
  assert.deepEqual(sh.parseMounts(FAILING, "/home/tv"), {
    device: "/dev/mmcblk0p2",
    mountPoint: "/",
    fsType: "ext4",
    readOnly: true,
  });
});

test("a healthy card is not", () => {
  assert.equal(sh.parseMounts(HEALTHY, "/home/tv").readOnly, false);
});

test("a plainly read-only mount is caught too", () => {
  // What the same filesystem looks like before systemd-remount-fs, and what an
  // older kernel writes when ext4 gives up on it.
  assert.equal(sh.parseMounts("/dev/mmcblk0p2 / ext4 ro,noatime 0 0\n", "/home/tv").readOnly, true);
});

test("an option that merely CONTAINS the word is not one", () => {
  // `errors=remount-ro` is a mount option saying what to do later, not a state,
  // and `relatime`/`rootcontext` carry the letters in the wrong places.
  const line = "/dev/mmcblk0p2 / ext4 rw,relatime,errors=remount-ro 0 0\n";
  assert.equal(sh.parseMounts(line, "/home/tv").readOnly, false);
});

test("the mount that holds the home directory wins, not the root", () => {
  const text =
    "/dev/mmcblk0p2 / ext4 ro,noatime 0 0\n" + // root gave up
    "/dev/sda1 /home ext4 rw,noatime 0 0\n"; // home did not
  const s = sh.parseMounts(text, "/home/tv");
  assert.equal(s.mountPoint, "/home");
  assert.equal(s.readOnly, false);
});

test("a mount point that is only a STRING prefix does not count", () => {
  // /homework is not /home, and reading it as one would report the wrong disk.
  const text = "/dev/mmcblk0p2 / ext4 rw,noatime 0 0\n/dev/sda1 /homework ext4 ro 0 0\n";
  assert.equal(sh.parseMounts(text, "/home/tv").mountPoint, "/");
});

test("the last of two mounts on the same point is the one on top", () => {
  const text = "/dev/sda1 /home ext4 rw 0 0\n/dev/sdb1 /home ext4 ro 0 0\n";
  assert.equal(sh.parseMounts(text, "/home/tv").device, "/dev/sdb1");
});

test("an escaped mount point is unescaped before it is compared", () => {
  const text = "/dev/sda1 /home/my\\040box ext4 ro 0 0\n/dev/mmcblk0p2 / ext4 rw 0 0\n";
  const s = sh.parseMounts(text, "/home/my box");
  assert.equal(s.mountPoint, "/home/my box");
  assert.equal(s.readOnly, true);
});

test("nothing to read means no claim at all", () => {
  // A box that cannot tell must say nothing: "the storage has failed" takes a
  // television off the wall, and "it is fine" is the silence this exists to end.
  assert.equal(sh.parseMounts("", "/home/tv"), null);
  assert.equal(sh.parseMounts("garbage\nalso garbage\n", "/home/tv"), null);
  assert.equal(sh.parseMounts("/dev/sda1 relative ext4 rw 0 0\n", "/home/tv"), null);
  assert.equal(
    sh.state(() => {
      throw new Error("ENOENT");
    }),
    null,
  );
});

test("a truncated line is skipped rather than half-read", () => {
  const text = "/dev/sda1 /home ext4\n/dev/mmcblk0p2 / ext4 rw,noatime 0 0\n";
  assert.equal(sh.parseMounts(text, "/home/tv").mountPoint, "/");
});

test("state() reads the real mounts file through the injected reader", () => {
  const seen = [];
  const s = sh.state((p) => {
    seen.push(p);
    return FAILING;
  });
  assert.deepEqual(seen, [sh.MOUNTS]);
  assert.equal(s.readOnly, true);
});
