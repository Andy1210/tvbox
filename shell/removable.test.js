// Which block devices the box offers as "a stick you plugged in", and what happens
// when one is mounted. The lsblk output below is REAL - captured from a Pi 5
// running the box (util-linux 2.41) - because the one decision that can do damage
// here turns on a field a hand-written fixture gets wrong: the Pi's own SD card
// reports `hotplug: true`, so anything keying off that flag offers the disk the
// system is running from.
const test = require("node:test");
const assert = require("node:assert");

const removable = require("./removable");

// The device list is cached for a couple of seconds; each test below plugs in its
// own set of devices, so each starts from a cold cache.
test.beforeEach(() => removable.invalidate());

// The box itself: SD card with the boot partition and root on it, plus zram swap.
const BOX_DISKS = [
  {
    name: "mmcblk0",
    path: "/dev/mmcblk0",
    type: "disk",
    rm: false,
    hotplug: true,
    fstype: null,
    label: null,
    mountpoint: null,
    size: 127999672320,
    tran: "mmc",
    vendor: null,
    model: null,
    children: [
      {
        name: "mmcblk0p1",
        path: "/dev/mmcblk0p1",
        type: "part",
        rm: false,
        hotplug: true,
        fstype: "vfat",
        label: "bootfs",
        mountpoint: "/boot/firmware",
        size: 536870912,
        tran: "mmc",
      },
      {
        name: "mmcblk0p2",
        path: "/dev/mmcblk0p2",
        type: "part",
        rm: false,
        hotplug: true,
        fstype: "ext4",
        label: "rootfs",
        mountpoint: "/",
        size: 127454412800,
        tran: "mmc",
      },
    ],
  },
  {
    name: "zram0",
    path: "/dev/zram0",
    type: "disk",
    rm: false,
    hotplug: false,
    fstype: "swap",
    label: "zram0",
    mountpoint: "[SWAP]",
    size: 2147483648,
    tran: null,
  },
];

const USB_STICK = {
  name: "sda",
  path: "/dev/sda",
  type: "disk",
  rm: true,
  hotplug: true,
  fstype: null,
  label: null,
  mountpoint: null,
  size: 31000000000,
  tran: "usb",
  vendor: "SanDisk",
  model: "Cruzer Blade",
  children: [
    {
      name: "sda1",
      path: "/dev/sda1",
      type: "part",
      rm: true,
      hotplug: true,
      fstype: "exfat",
      label: "FILMEK",
      mountpoint: null,
      size: 30999000000,
      tran: "usb",
    },
  ],
};

const lsblk = (disks) => JSON.stringify({ blockdevices: disks });

test("the box's own SD card is never offered, hotplug flag and all", () => {
  const devices = removable.parseDevices(lsblk(BOX_DISKS));
  assert.deepStrictEqual(devices, [], "nothing on the disk the box runs from may be offered");
});

test("a USB stick is offered, named by its label", () => {
  const devices = removable.parseDevices(lsblk(BOX_DISKS.concat([USB_STICK])));
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].device, "/dev/sda1");
  assert.strictEqual(devices[0].name, "FILMEK");
  assert.strictEqual(devices[0].fstype, "exfat");
  assert.strictEqual(devices[0].mountpoint, null, "plugged in is not mounted - nothing here auto-mounts");
});

test("a USB disk the box BOOTS from is not a stick", () => {
  // A Pi 5 booting off a USB SSD: removable by bus, and the running system is on
  // it. Offering it would put the box's own root filesystem on the TV.
  const ssd = JSON.parse(JSON.stringify(USB_STICK));
  ssd.model = "Portable SSD";
  ssd.children[0].fstype = "vfat";
  ssd.children[0].label = "bootfs";
  ssd.children[0].mountpoint = "/boot/firmware";
  ssd.children.push({
    name: "sda2",
    path: "/dev/sda2",
    type: "part",
    rm: true,
    fstype: "ext4",
    label: "rootfs",
    mountpoint: "/",
    size: 30000000000,
    tran: "usb",
  });
  assert.deepStrictEqual(removable.parseDevices(lsblk([ssd])), []);
});

test("an unlabelled stick is named after the drive, then after the kernel", () => {
  const unlabelled = JSON.parse(JSON.stringify(USB_STICK));
  unlabelled.children[0].label = null;
  assert.strictEqual(removable.parseDevices(lsblk([unlabelled]))[0].name, "SanDisk Cruzer Blade");
  unlabelled.vendor = null;
  unlabelled.model = null;
  assert.strictEqual(removable.parseDevices(lsblk([unlabelled]))[0].name, "sda1");
});

test("a stick with no partition table is the disk itself", () => {
  const raw = {
    name: "sdb",
    path: "/dev/sdb",
    type: "disk",
    rm: true,
    fstype: "vfat",
    label: "CAMERA",
    mountpoint: null,
    size: 8000000000,
    tran: "usb",
  };
  const devices = removable.parseDevices(lsblk([raw]));
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].device, "/dev/sdb");
});

test("what cannot be opened as a folder is not offered", () => {
  const odd = JSON.parse(JSON.stringify(USB_STICK));
  odd.children[0].fstype = "LVM2_member";
  odd.children.push({ name: "sda2", path: "/dev/sda2", type: "part", rm: true, fstype: "swap", size: 100 });
  odd.children.push({ name: "sda3", path: "/dev/sda3", type: "part", rm: true, fstype: null, size: 100 });
  assert.deepStrictEqual(removable.parseDevices(lsblk([odd])), []);
});

test("a system mount lsblk reports only in the plural column still hides the disk", () => {
  // A device can be mounted more than once, and the singular MOUNTPOINT column
  // shows one of them. If the check reads only that one, the disk the box runs
  // from can be offered as a stick.
  const ssd = JSON.parse(JSON.stringify(USB_STICK));
  ssd.children[0].mountpoint = "/mnt/spare";
  ssd.children[0].mountpoints = ["/mnt/spare", "/"];
  assert.deepStrictEqual(removable.parseDevices(lsblk([ssd])), []);
});

test("an lsblk old enough to write its flags as strings is still understood", () => {
  // Real booleans in lsblk's JSON are util-linux 2.38 and newer; before that `rm`
  // is "0"/"1", and reading that as false calls every stick non-removable.
  const old = JSON.parse(JSON.stringify(USB_STICK));
  old.rm = "1";
  old.tran = null;
  old.children[0].rm = "1";
  assert.strictEqual(removable.parseDevices(lsblk([old])).length, 1);
});

test("garbage in is an empty list, not a crash", () => {
  assert.deepStrictEqual(removable.parseDevices("not json"), []);
  assert.deepStrictEqual(removable.parseDevices(""), []);
});

// A fake udisksctl/lsblk pair. `answers` maps a substring of the command line to
// stdout, or to { fail, stderr } when the test is about a failure.
function fake(answers, devices) {
  const seen = [];
  const execFile = (cmd, args, opts, cb) => {
    const done = typeof opts === "function" ? opts : cb;
    const line = [cmd].concat(args).join(" ");
    seen.push(line);
    setImmediate(() => {
      if (cmd === "lsblk") return done(null, lsblk(devices || [USB_STICK]), "");
      const key = Object.keys(answers).find((k) => line.includes(k));
      const answer = key === undefined ? "" : answers[key];
      if (answer && answer.fail) return done(new Error("failed"), "", answer.stderr || "");
      done(null, typeof answer === "string" ? answer : "", "");
    });
  };
  return { deps: { execFile, onPath: () => true }, seen };
}

test("a device that is not on the list never reaches a command line", async () => {
  const { deps, seen } = fake({});
  const r = await new Promise((res) => removable.mount(deps, "/dev/sda1; rm -rf /", res));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "unknown_device");
  assert.ok(
    !seen.some((l) => l.startsWith("udisksctl")),
    "the candidate list is the gate: nothing may be mounted that was not offered",
  );
});

test("a device from another disk is refused even though it looks like one of ours", async () => {
  const { deps } = fake({});
  const r = await new Promise((res) => removable.mount(deps, "/dev/mmcblk0p2", res));
  assert.strictEqual(r.error, "unknown_device");
});

test("mounting reports the mount point the kernel ended up with", async () => {
  const mounted = JSON.parse(JSON.stringify(USB_STICK));
  let done = false;
  const seen = [];
  const deps = {
    onPath: () => true,
    execFile: (cmd, args, opts, cb) => {
      const finish = typeof opts === "function" ? opts : cb;
      seen.push([cmd].concat(args).join(" "));
      setImmediate(() => {
        if (cmd === "lsblk") return finish(null, lsblk([done ? mountedStick() : mounted]), "");
        done = true; // the mount succeeded; the next lsblk sees it
        finish(null, "Mounted /dev/sda1 at /run/media/tv/FILMEK.\n", "");
      });
    },
  };
  function mountedStick() {
    const m = JSON.parse(JSON.stringify(USB_STICK));
    m.children[0].mountpoint = "/run/media/tv/FILMEK";
    return m;
  }
  const r = await new Promise((res) => removable.mount(deps, "/dev/sda1", res));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mountpoint, "/run/media/tv/FILMEK");
  assert.ok(
    seen.some((l) => l === "udisksctl mount -b /dev/sda1 --no-user-interaction"),
    "a TV has nobody to answer a prompt: the mount must never wait for one",
  );
});

test("a stick that is already mounted is a success, not an error", async () => {
  const mounted = JSON.parse(JSON.stringify(USB_STICK));
  mounted.children[0].mountpoint = "/run/media/tv/FILMEK";
  const { deps } = fake(
    { udisksctl: { fail: true, stderr: "Error mounting /dev/sda1: GDBus.Error:...: Device is already mounted" } },
    [mounted],
  );
  const r = await new Promise((res) => removable.mount(deps, "/dev/sda1", res));
  assert.strictEqual(r.ok, true, "the caller asked for a folder to open, not for a syscall to be issued");
  assert.strictEqual(r.mountpoint, "/run/media/tv/FILMEK");
});

test("a missing polkit grant is reported as itself", async () => {
  const { deps } = fake({
    udisksctl: {
      fail: true,
      stderr: "Error mounting /dev/sda1: GDBus.Error:org.freedesktop.UDisks2.Error.NotAuthorized: Not authorized",
    },
  });
  const r = await new Promise((res) => removable.mount(deps, "/dev/sda1", res));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "not_authorized", "the box needs re-provisioning, and the UI has to be able to say so");
});

test("unmounting a busy stick says why", async () => {
  const mounted = JSON.parse(JSON.stringify(USB_STICK));
  mounted.children[0].mountpoint = "/run/media/tv/FILMEK";
  const { deps } = fake({ udisksctl: { fail: true, stderr: "Error unmounting: target is busy" } }, [mounted]);
  const r = await new Promise((res) => removable.unmount(deps, "/dev/sda1", res));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "busy");
  assert.match(r.message, /busy/);
});

test("the list is cached, and a mount is never read from the stale copy", async () => {
  // One forked lsblk per keypress is what this avoids - browsing a folder tree asks
  // for the roots on every navigation. But a mount CHANGES the answer, so the cache
  // has to be dropped by the thing that changed it.
  const mounted = JSON.parse(JSON.stringify(USB_STICK));
  mounted.children[0].mountpoint = "/media/tv/FILMEK";
  let mountDone = false;
  const seen = [];
  const deps = {
    onPath: () => true,
    execFile: (cmd, args, opts, cb) => {
      const done = typeof opts === "function" ? opts : cb;
      seen.push(cmd);
      setImmediate(() => {
        if (cmd === "lsblk") return done(null, lsblk([mountDone ? mounted : USB_STICK]), "");
        mountDone = true;
        done(null, "Mounted /dev/sda1 at /media/tv/FILMEK.\n", "");
      });
    },
  };
  const first = await new Promise((res) => removable.list(deps, res));
  const second = await new Promise((res) => removable.list(deps, res));
  assert.strictEqual(seen.filter((c) => c === "lsblk").length, 1, "the second answer comes from the cache");
  assert.strictEqual(second.devices[0].mountpoint, first.devices[0].mountpoint);
  const r = await new Promise((res) => removable.mount(deps, "/dev/sda1", res));
  assert.strictEqual(r.mountpoint, "/media/tv/FILMEK", "the confirming read must not be the pre-mount copy");
});

test("a box without udisks says so instead of failing per device", async () => {
  const deps = { onPath: () => false, execFile: () => assert.fail("nothing to run without udisks") };
  assert.strictEqual(removable.supported(deps), false);
  const l = await new Promise((res) => removable.list(deps, res));
  assert.deepStrictEqual(l, { supported: false, devices: [] });
  const r = await new Promise((res) => removable.mount(deps, "/dev/sda1", res));
  assert.strictEqual(r.error, "unsupported");
});
