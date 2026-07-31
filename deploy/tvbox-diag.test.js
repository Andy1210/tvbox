// Tests for the boot-partition diagnostics report (deploy/tvbox-diag.sh).
//
// Three things have to hold whatever state the box is in. It must WRITE, because a
// report that needs a healthy box describes nothing. It must not DESTROY the
// previous report when it cannot write a new one, which is how the boot partition
// lost a file already. And it must not leak the secrets that live next to it on a
// world-readable FAT partition.
//
// Everything runs against a fake root (TVBOX_TEST_ROOT) with the commands the
// script may shell out to stubbed onto PATH, so no test reads this machine's real
// state or writes outside its temp dir.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const test = require("node:test");
const assert = require("node:assert");

const SCRIPT = path.join(__dirname, "tvbox-diag.sh");

// A healthy box's stubs. Every command the script may shell out to is stubbed even
// when this machine happens to have it, so a test reads the fake box and never the
// host: the dev host has an `ip` and a `df` of its own, and the report would
// silently describe THEM.
const STUBS = {
  // Answers per path, so the root filesystem and the boot partition are
  // distinguishable in the report.
  df: `#!/bin/sh
for a in "$@"; do case "$a" in -k) K=1 ;; *boot*) B=1 ;; esac; done
echo "Filesystem 1024-blocks Used Available Capacity Mounted-on"
if [ "\${B:-0}" = 1 ]; then
  if [ "\${K:-0}" = 1 ]; then echo "/dev/fake1 517000 66000 451000 13% /boot/firmware"
  else echo "/dev/fake1 505M 66M 439M 13% /boot/firmware"; fi
elif [ "\${K:-0}" = 1 ]; then echo "/dev/fake2 122000000 20000000 96000000 18% /"
else echo "/dev/fake2 117G 20G 93G 18% /"; fi
`,
  systemctl: `#!/bin/sh
case "$1" in is-active) echo active ;; esac
exit 0
`,
  ip: `#!/bin/sh
case "$*" in
  *route*) echo "default via 192.168.1.1 dev wlan0" ;;
  *addr*) echo "1: wlan0    inet 192.168.1.24/24 brd 192.168.1.255 scope global wlan0" ;;
  *link*) echo "1: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500" ;;
esac
exit 0
`,
  nmcli: `#!/bin/sh
case "$*" in
  *"device wifi"*) echo "yes:71:HomeNet" ;;
  *radio*) echo enabled ;;
esac
exit 0
`,
};

function fakeBox(overrides = {}, stubs = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-diag-test-"));
  for (const d of [
    ["boot", "firmware"],
    ["run"],
    ["proc", "net"],
    ["etc", "ssh"],
    ["var", "lib", "tvbox"],
    ["home", "tv", ".tvbox", "shell"],
  ]) {
    fs.mkdirSync(path.join(root, ...d), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "etc", "hostname"), "tvbox-test\n");
  fs.writeFileSync(path.join(root, "proc", "uptime"), "5000.42 9000.00\n");
  fs.writeFileSync(path.join(root, "proc", "meminfo"), "MemTotal:        8000000 kB\nMemAvailable:    5000000 kB\n");
  fs.writeFileSync(path.join(root, "proc", "mounts"), "/dev/fake / ext4 rw,relatime 0 0\n");
  // The shell's API on 8097 (hex 1FA1) and sshd on 22 (hex 0016), both LISTEN (0A).
  fs.writeFileSync(
    path.join(root, "proc", "net", "tcp"),
    "  sl  local_address rem_address   st\n" +
      "   0: 0100007F:1FA1 00000000:0000 0A\n" +
      "   1: 00000000:0016 00000000:0000 0A\n",
  );
  fs.writeFileSync(path.join(root, "etc", "resolv.conf"), "nameserver 192.168.1.1\n");
  fs.writeFileSync(
    path.join(root, "boot", "firmware", "cmdline.txt"),
    "root=PARTUUID=x rootwait vc4.force_hotplug=1\n",
  );
  fs.writeFileSync(path.join(root, "home", "tv", ".tvbox", "shell", "package.json"), '{ "version": "9.9.9" }\n');
  for (const k of ["ed25519", "rsa"]) {
    fs.writeFileSync(path.join(root, "etc", "ssh", "ssh_host_" + k + "_key"), "x");
  }

  const bin = path.join(root, "stub-bin");
  fs.mkdirSync(bin);
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  for (const [name, body] of Object.entries({ ...STUBS, ...stubs })) write(name, body);

  for (const [rel, body] of Object.entries(overrides)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return { root, bin };
}

// --stdout by default: it exercises the whole report without a write, and the
// write path gets its own tests below.
function report(box, args = ["--stdout"]) {
  return execFileSync("sh", [SCRIPT, ...args], {
    env: { PATH: box.bin + ":/usr/bin:/bin", TVBOX_TEST_ROOT: box.root },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const p = (box, ...rel) => path.join(box.root, ...rel);
const warnings = (text) => text.split("\n").filter((l) => l.startsWith("WARNING:"));
// chmod means nothing to uid 0, so a test that proves something by making a write
// fail only proves it as a normal user.
const rootless = { skip: process.getuid?.() === 0 ? "needs a non-root uid" : false };

test("a healthy box reports every section and finds nothing wrong", () => {
  const out = report(fakeBox());
  for (const section of [
    "== box ==",
    "== boot ==",
    "== session ==",
    "== storage ==",
    "== network ==",
    "== ssh ==",
    "== boot config ==",
    "== failed units ==",
  ]) {
    assert.ok(out.includes(section), "missing section: " + section);
  }
  assert.match(out, /verdict: *nothing obviously wrong/);
  assert.deepStrictEqual(warnings(out), []);
  assert.match(out, /tvbox: *9\.9\.9 \(dev tree/, "the running version, resolved the way run-shell.sh resolves it");
  assert.match(out, /host keys: *2 present/);
  assert.match(out, /shell: *answering on 127\.0\.0\.1:8097/);
  assert.match(out, /port 22 listening/);
  assert.match(out, /wifi: *SSID "HomeNet" signal 71%/);
  assert.match(out, /\/boot\/firm\. *439M free of 505M/, "the boot partition, told apart from the root filesystem");
  assert.ok(!/ +$/m.test(out), "no trailing whitespace - this is read in a plain text editor");
});

test("user units that could not be asked about are not reported as fine", () => {
  // The input bridges are user units. Saying "none" when the question could not be
  // put would hide exactly the failure someone opens this file to find.
  const out = report(fakeBox());
  assert.match(out, /user: *could not ask/, "no box user resolvable in a fake root");
});

// A resolvable box user, so the user-unit query is actually attempted. `runuser`
// then decides the outcome.
const RESOLVABLE_USER = { id: "#!/bin/sh\necho 1000\n" };

test("a user-unit query that fails is not reported as no failures", () => {
  // The status has to come from runuser, not from the pipeline it feeds: a pipeline
  // reports its LAST command, and `head` succeeds no matter what happened upstream.
  const box = fakeBox({}, { ...RESOLVABLE_USER, runuser: "#!/bin/sh\nexit 1\n" });
  assert.match(report(box), /user: *could not ask/);
});

test("a user-unit query that succeeds with nothing failed says so plainly", () => {
  const box = fakeBox({}, { ...RESOLVABLE_USER, runuser: "#!/bin/sh\nexit 0\n" });
  const out = report(box);
  assert.match(out, /user: *none/);
  assert.deepStrictEqual(warnings(out), []);
});

test("a failed user unit is named and warned about", () => {
  const box = fakeBox(
    {},
    { ...RESOLVABLE_USER, runuser: "#!/bin/sh\necho 'tvbox-cec.service loaded failed failed tvbox CEC bridge'\n" },
  );
  const out = report(box);
  assert.match(out, /user: *tvbox-cec\.service/);
  assert.ok(warnings(out).some((w) => /failed user units.*tvbox-cec/.test(w)));
});

test("the report is plain LF text, small enough to sit on a boot partition", () => {
  const out = report(fakeBox());
  assert.ok(!out.includes("\r"), "no CR: this is read on Linux as often as on Windows");
  assert.ok(out.length < 16384, "report is " + out.length + " bytes");
  assert.ok(out.split("\n").length > 25, "and not so short that it says nothing");
});

test("an empty root filesystem is described, not crashed on", () => {
  // The point of the exercise: the box this runs on may have nothing left working.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-diag-bare-"));
  const out = execFileSync("sh", [SCRIPT, "--stdout"], {
    env: { PATH: "/usr/bin:/bin", TVBOX_TEST_ROOT: root },
    encoding: "utf8",
  });
  assert.match(out, /tvbox diagnostics/);
  assert.match(out, /== storage ==/);
  assert.match(out, /cmdline\.txt: *MISSING/);
});

test("an empty cmdline.txt is called out - it boots on the firmware fallback", () => {
  const box = fakeBox({ "boot/firmware/cmdline.txt": "" });
  const out = report(box);
  assert.match(out, /cmdline\.txt: *EMPTY/);
  assert.ok(
    warnings(out).some((w) => /EMPTY/.test(w) && /bak-tvbox|FSCK/.test(w)),
    "and says where the lost text may still be",
  );
  assert.match(out, /verdict: *1 problem/);
});

test("a missing vc4.force_hotplug=1 is reported, since nothing else would notice", () => {
  const box = fakeBox({ "boot/firmware/cmdline.txt": "root=PARTUUID=x rootwait\n" });
  assert.ok(warnings(report(box)).some((w) => /force_hotplug/.test(w)));
});

test("a FAT recovery file is surfaced - something on the partition was truncated", () => {
  const box = fakeBox({ "boot/firmware/FSCK0000.REC": "root=PARTUUID=x rootwait\n" });
  const out = report(box);
  assert.match(out, /recovered: *FSCK0000\.REC/);
  assert.ok(warnings(out).some((w) => /FSCK0000\.REC/.test(w)));
});

test("missing SSH host keys are named as the reason sshd drops connections", () => {
  const box = fakeBox();
  for (const f of fs.readdirSync(p(box, "etc", "ssh"))) fs.rmSync(p(box, "etc", "ssh", f));
  const out = report(box);
  assert.match(out, /host keys: *MISSING/);
  assert.ok(warnings(out).some((w) => /no banner/.test(w)));
});

test("a read-only root filesystem is the headline, not a footnote", () => {
  const box = fakeBox({ "proc/mounts": "/dev/fake / ext4 ro,relatime 0 0\n" });
  const out = report(box);
  assert.match(out, /root is mounted READ-ONLY/);
  assert.ok(warnings(out).some((w) => /READ-ONLY/.test(w)));
});

test("a nearly full root filesystem is a warning, with the unit that should have prevented it", () => {
  // 174 MB free on any size card is the un-grown flashed image, which fills up on
  // its first boot and takes screen, network and sshd down together.
  const box = fakeBox(
    {},
    {
      df: `#!/bin/sh
for a in "$@"; do case "$a" in -k) K=1 ;; *boot*) B=1 ;; esac; done
echo "Filesystem 1024-blocks Used Available Capacity Mounted-on"
if [ "\${B:-0}" = 1 ]; then echo "/dev/fake1 517000 66000 451000 13% /boot/firmware"
elif [ "\${K:-0}" = 1 ]; then echo "/dev/fake2 3600000 3420000 170000 96% /"
else echo "/dev/fake2 3.5G 3.3G 174M 96% /"; fi
`,
    },
  );
  const out = report(box);
  assert.ok(warnings(out).some((w) => /free on \//.test(w) && /tvbox-expand-rootfs/.test(w)));
});

test("firmware throttling points at the power supply", () => {
  const box = fakeBox({}, { vcgencmd: '#!/bin/sh\necho "throttled=0x50005"\n' });
  const out = report(box);
  assert.match(out, /throttled: *0x50005/);
  assert.ok(warnings(out).some((w) => /power supply/.test(w)));
});

const NO_ROUTE_IP =
  '#!/bin/sh\ncase "$*" in *route*) exit 0 ;; *addr*) echo "1: wlan0    inet 192.168.1.24/24 scope global wlan0" ;; esac\nexit 0\n';

test("an SSID with a colon in it survives the report", () => {
  // nmcli -t writes a ':' inside a value as '\:', so splitting on every colon
  // truncates the name of any network that has one.
  const box = fakeBox(
    {},
    {
      nmcli:
        '#!/bin/sh\ncase "$*" in *"device wifi"*) echo "yes:64:Guest\\\\:5G" ;; *radio*) echo enabled ;; esac\nexit 0\n',
    },
  );
  const out = report(box);
  assert.match(out, /wifi: *SSID "Guest:5G" signal 64%/);
});

test("no default route is reported as no way off the LAN", () => {
  // A box that looks connected - link up, address assigned - and cannot reach
  // anything, so it silently stops updating itself.
  const box = fakeBox({}, { ip: NO_ROUTE_IP });
  assert.ok(warnings(report(box)).some((w) => /default route/.test(w)));
});

test("a box that is still booting is not accused of being broken", () => {
  // The boot-time run lands before DHCP has finished and before the session has
  // brought the shell up. A false alarm at the top of every boot report is how a
  // reader learns to stop reading the warnings - both were seen on a real boot.
  const box = fakeBox(
    { "proc/uptime": "12.00 20.00\n", "proc/net/tcp": "  sl  local_address rem_address   st\n" },
    { ip: NO_ROUTE_IP },
  );
  const out = report(box);
  assert.match(out, /route: *none yet \(the box is still starting\)/);
  assert.match(out, /shell: *not up yet \(the box is still starting\)/);
  assert.deepStrictEqual(warnings(out), []);
});

test("the shell not answering on its port is a warning", () => {
  const box = fakeBox({ "proc/net/tcp": "  sl  local_address rem_address   st\n" });
  const out = report(box);
  assert.match(out, /shell: *NOT listening/);
  assert.ok(warnings(out).some((w) => /not serving its API/.test(w)));
});

test("in safe mode a shell that is not running is expected, not a fault", () => {
  const box = fakeBox({
    "run/tvbox-safe-mode": "because a test said so\n",
    "proc/net/tcp": "  sl  local_address rem_address   st\n   1: 00000000:0016 00000000:0000 0A\n",
  });
  const out = report(box);
  assert.match(out, /safe mode: *ON\. because a test said so/);
  assert.match(out, /shell: *not running \(safe mode - expected\)/);
  assert.deepStrictEqual(warnings(out), []);
});

test("the boot counter is read back from the state tvbox-safemode writes", () => {
  const box = fakeBox({
    "var/lib/tvbox/boot-state": "attempts=2\nmax-attempts=3\nprev-healthy=no\nsafe-mode=no\n",
  });
  const out = report(box);
  assert.match(out, /failed boots: *2 of 3/);
  assert.match(out, /reached the launcher: no/);
});

test("tvbox.conf secrets never reach the report", () => {
  // FAT has no ownership, so this file is readable by every app on the box and by
  // anyone who picks up the card. It may only ever name the keys.
  const box = fakeBox({
    "boot/firmware/tvbox.conf":
      "HOSTNAME=livingroom\nWIFI_SSID=HomeNet\nWIFI_PASSWORD=correct-horse-battery\nPASSWORD=hunter2\nSSH_AUTHORIZED_KEY=ssh-ed25519 AAAAC3Nz nobody@nowhere\nSUDO=true\n",
  });
  const out = report(box);
  for (const secret of ["correct-horse-battery", "hunter2", "AAAAC3Nz"]) {
    assert.ok(!out.includes(secret), "the report leaks " + secret);
  }
  assert.match(out, /PASSWORD=set/);
  assert.match(out, /WIFI_PASSWORD=set/);
  assert.match(out, /SUDO=set/);
});

test("writing lands on the boot partition and replaces the previous report", () => {
  const box = fakeBox();
  const out = p(box, "boot", "firmware", "tvbox-diag.txt");
  report(box, []);
  assert.match(fs.readFileSync(out, "utf8"), /tvbox diagnostics/);
  fs.writeFileSync(p(box, "boot", "firmware", "cmdline.txt"), "");
  report(box, []);
  assert.match(fs.readFileSync(out, "utf8"), /cmdline\.txt: *EMPTY/, "the second run replaced the first");
  assert.ok(!fs.existsSync(p(box, "boot", "firmware", ".tvbox-diag.tmp")), "no temp file left behind");
});

test("a boot partition it cannot write leaves the OLD report intact", rootless, () => {
  // The regression that matters: the previous report is evidence, and a failed
  // write must not be what destroys it.
  const box = fakeBox();
  const out = p(box, "boot", "firmware", "tvbox-diag.txt");
  report(box, []);
  const before = fs.readFileSync(out, "utf8");
  fs.chmodSync(p(box, "boot", "firmware"), 0o555);
  try {
    assert.throws(() => report(box, []), /Command failed/);
    assert.strictEqual(fs.readFileSync(out, "utf8"), before);
  } finally {
    fs.chmodSync(p(box, "boot", "firmware"), 0o755);
  }
});

test("--brief fits a TV console and keeps the part worth reading", () => {
  // The console is about 48 rows on a 1360x768 panel. The full report is longer, so
  // the verdict and the warnings - the answer - scroll off the top; measured on a
  // real safe-mode boot. The short form has to stay comfortably inside that.
  const box = fakeBox({ "boot/firmware/cmdline.txt": "" });
  const brief = report(box, ["--brief"]);
  const lines = brief.replace(/\n$/, "").split("\n");
  assert.ok(lines.length <= 40, "short form is " + lines.length + " lines, a console holds about 48");
  assert.match(brief, /verdict: *1 problem/);
  assert.ok(
    warnings(brief).some((w) => /EMPTY/.test(w)),
    "the warnings are the reason this is on screen at all",
  );
  for (const key of ["host:", "safe mode:", "shell:", "route:", "host keys:"]) {
    assert.ok(brief.includes(key), "short form dropped " + key);
  }
  assert.ok(!brief.includes("== if the box will not start =="), "the long footer belongs in the file, not on a TV");
  assert.match(brief, /whole report is on the boot partition/);
  assert.strictEqual(fs.existsSync(p(box, "boot", "firmware", "tvbox-diag.txt")), false, "writes nothing");
});

test("--stdout writes nothing to the card", () => {
  const box = fakeBox();
  report(box);
  assert.strictEqual(fs.existsSync(p(box, "boot", "firmware", "tvbox-diag.txt")), false);
});

test("--logs writes the log dump as a SEPARATE file", () => {
  // Separate so it can never push the report itself off a full partition.
  const box = fakeBox();
  fs.writeFileSync(p(box, "home", "tv", ".tvbox", "shell.log"), "[shell] something went wrong\n");
  fs.writeFileSync(path.join(box.bin, "journalctl"), '#!/bin/sh\necho "journal line"\n', { mode: 0o755 });
  report(box, ["--logs"]);
  assert.match(fs.readFileSync(p(box, "boot", "firmware", "tvbox-diag.txt"), "utf8"), /tvbox diagnostics/);
  const logs = fs.readFileSync(p(box, "boot", "firmware", "tvbox-diag-logs.txt"), "utf8");
  assert.match(logs, /journal line/);
  assert.match(logs, /something went wrong/);
  assert.ok(logs.length <= 262144, "bounded");
});

test("the timer-driven unit can actually be retriggered", () => {
  // systemd will not restart a oneshot that is still "active", so RemainAfterExit
  // on a timer-driven unit freezes it after the first run: the report would stay at
  // whatever the boot-time write said and the half-hourly refresh would never
  // happen, with nothing failing to show it.
  const unit = fs.readFileSync(path.join(__dirname, "tvbox-diag.service"), "utf8");
  const timer = fs.readFileSync(path.join(__dirname, "tvbox-diag.timer"), "utf8");
  assert.ok(/^Type=oneshot$/m.test(unit));
  assert.ok(!/^RemainAfterExit=yes/m.test(unit), "tvbox-diag.service must not RemainAfterExit - the timer restarts it");
  assert.ok(/^OnUnitActiveSec=/m.test(timer), "and the timer is what restarts it");
});

test("--logs cannot be combined with a mode that writes nothing", () => {
  // "print it, write nothing" has to be true, so a combination that would quietly
  // write a file anyway is refused rather than half-honoured.
  const box = fakeBox();
  for (const mode of ["--stdout", "--brief"]) {
    assert.throws(() => report(box, ["--logs", mode]), /status 2|Command failed/, mode);
    assert.strictEqual(fs.existsSync(p(box, "boot", "firmware", "tvbox-diag-logs.txt")), false);
    assert.strictEqual(fs.existsSync(p(box, "boot", "firmware", "tvbox-diag.txt")), false);
  }
});

test("an unknown argument fails loudly instead of writing something unexpected", () => {
  const box = fakeBox();
  assert.throws(() => report(box, ["--everything"]), /status 2|Command failed/);
});

test("the report tells the reader how to get in, with no working box required", () => {
  const out = report(fakeBox());
  assert.match(out, /tvbox-safe-mode/, "how to ask for safe mode");
  assert.match(out, /SSH_AUTHORIZED_KEY=/, "how to get SSH onto a box that has none");
  assert.match(out, /card reader/, "and that none of it needs the box to work");
});
