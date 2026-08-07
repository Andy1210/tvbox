// The USB stick someone just pushed into the box.
//
// Two things about this box shape everything below:
//
//   • NOTHING auto-mounts here. There is no desktop and no file manager, so a
//     plugged-in stick is a block device and nothing more. It is mounted when
//     someone opens it on the TV and unmounted from the same screen before it is
//     pulled out.
//   • The mount goes through **udisks2**, the only way an ordinary user mounts a
//     disk with no fstab line and no setuid helper. Electron moves its own main
//     process into a systemd app scope, which takes it out of the seat's logind
//     session, so polkit does not see the shell as "the active session" and the
//     desktop default (allow_active) never applies to us - the grant is a rule in
//     deploy/provision.sh instead. That rule covers `filesystem-mount` ONLY, i.e.
//     what udisks calls an external device; the box's own SD card answers to
//     `filesystem-mount-system`, which is deliberately not granted, so nothing
//     here can mount the running system's partitions.
//
// Which devices count is NOT "hotplug": the Pi's own SD card reports hotplug=1
// (measured on a Pi 5, util-linux 2.41), so that flag alone would offer the disk
// the box boots from. A device is offered when the kernel calls it removable or it
// arrived over USB - and never when the running system sits on it, which a Pi
// booting from a USB SSD makes a real case rather than a theoretical one.
// MOUNTPOINTS (plural) as well as MOUNTPOINT, because the singular column reports
// only ONE of a device's mount points - and the check that keeps the box's own disk
// out of this list is exactly the one that must not miss the other.
const LSBLK_COLUMNS = "NAME,PATH,TYPE,RM,HOTPLUG,FSTYPE,LABEL,MOUNTPOINT,MOUNTPOINTS,SIZE,TRAN,VENDOR,MODEL";
// A stick with a cold filesystem can take seconds to mount (a dirty FAT is checked
// first), and unmounting flushes whatever was written. Long enough not to fail a
// slow but working device; short enough that the TV is never stuck.
const TIMEOUT_MS = 30000;

// Mount points that mean "this is the box, not a stick". A device carrying any of
// them is never offered, whatever the kernel says about how removable it is.
const SYSTEM_MOUNTS = new Set(["/", "/boot", "/boot/firmware", "/usr", "/var", "/home"]);
// Filesystems udisks cannot hand back as a directory to browse.
const UNMOUNTABLE_FS = new Set(["swap", "linux_raid_member", "LVM2_member", "crypto_LUKS", "zfs_member"]);

// A device path we are willing to put on a command line. The candidate list is the
// real gate (see deviceFrom below) - this is the shape check in front of it.
const DEVICE_RE = /^\/dev\/[A-Za-z0-9][A-Za-z0-9_-]*$/;

function nodes(n) {
  // lsblk nests partitions under their disk; walk the whole subtree.
  const out = [n];
  for (const c of n.children || []) out.push(...nodes(c));
  return out;
}

// Every path a node is mounted at. `mountpoints` is the authority (a device can be
// mounted more than once, and the singular column then shows only one of them);
// `mountpoint` is what an lsblk too old for the plural column leaves behind.
function mountsOf(n) {
  const list = Array.isArray(n.mountpoints) ? n.mountpoints : [n.mountpoint];
  return list.filter((m) => typeof m === "string" && m);
}

function carriesSystem(disk) {
  return nodes(disk).some((n) => mountsOf(n).some((m) => SYSTEM_MOUNTS.has(m)));
}

// lsblk's JSON has emitted real booleans only since util-linux 2.38; before that a
// flag is the STRING "0"/"1", and reading that as false would call every stick
// non-removable.
function flag(v) {
  return v === true || v === "1";
}

// The kernel's own answer (rm) or the bus it arrived on. Deliberately not hotplug.
function isRemovable(disk) {
  return flag(disk.rm) || disk.tran === "usb";
}

function mountable(n) {
  if (n.type !== "part" && n.type !== "disk") return false;
  if (!n.fstype || UNMOUNTABLE_FS.has(n.fstype)) return false;
  return DEVICE_RE.test(n.path || "");
}

// What the TV shows for a partition: its own label if it has one, otherwise the
// drive it sits on, otherwise the kernel name. A stick formatted by a camera has
// no label and every one of them would otherwise read "sda1".
function displayName(disk, part) {
  const label = (part.label || "").trim();
  if (label) return label;
  const vendor = (disk.vendor || "").trim();
  const model = (disk.model || "").trim();
  const drive = [vendor, model].filter(Boolean).join(" ").trim();
  if (drive) return drive;
  return part.name || part.path || "";
}

// Every partition of every removable drive: what to show, where it is mounted (or
// null), and the device to act on. Pure, so the filtering is testable without a
// stick to plug in.
function parseDevices(out) {
  let root;
  try {
    root = JSON.parse(out || "{}");
  } catch (e) {
    return [];
  }
  const devices = [];
  for (const disk of root.blockdevices || []) {
    if (disk.type !== "disk" || !isRemovable(disk) || carriesSystem(disk)) continue;
    // A stick partitioned as a whole device (no partition table) has no children.
    const parts = disk.children && disk.children.length ? disk.children : [disk];
    for (const part of parts) {
      if (!mountable(part)) continue;
      devices.push({
        device: part.path,
        name: displayName(disk, part),
        label: (part.label || "").trim(),
        fstype: part.fstype || "",
        size: Number(part.size) || 0,
        mountpoint: mountsOf(part)[0] || null,
        drive: disk.path || "",
      });
    }
  }
  return devices;
}

// udisksctl says why in prose. The UI needs a code it can translate, and the prose
// as the detail line - "Object /org/freedesktop/UDisks2/block_devices/sda1 is not a
// mountable filesystem" is not something to put on a TV on its own.
function errorCode(stderr) {
  const s = String(stderr || "");
  if (/not authorized|NotAuthorized/i.test(s)) return "not_authorized";
  if (/already mounted/i.test(s)) return "already_mounted";
  if (/not mounted/i.test(s)) return "not_mounted";
  if (/target is busy|Device or resource busy/i.test(s)) return "busy";
  if (/unknown filesystem|not a mountable/i.test(s)) return "unsupported_filesystem";
  return "failed";
}

// The last line of a udisks error is the one that says something; the rest is the
// D-Bus interface it came from.
function errorMessage(stderr) {
  const lines = String(stderr || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return last.replace(/^Error \w+ing [^:]+:\s*/i, "").slice(0, 200);
}

function defaults(deps) {
  const d = deps || {};
  return {
    execFile: d.execFile || require("child_process").execFile,
    env: d.env || process.env,
    onPath: d.onPath || (() => true),
  };
}

// `udisksctl` is the whole mechanism, and it is not on every box: it ships with
// udisks2, which provision.sh installs as a SOFT dep and OTA can never add. A box
// without it browses its own folders and says so about USB.
function supported(deps) {
  return !!defaults(deps).onPath("udisksctl");
}

// What is plugged in changes when someone walks to the TV, not per request - and
// every answer costs a forked lsblk. Without this, browsing a folder tree forks one
// per keypress and any page the box loads can ask for the list in a loop.
// Invalidated by anything that CHANGES the answer, so a mount is never read stale.
const CACHE_MS = 2000;
let cache = null; // { at, value }

function invalidate() {
  cache = null;
}

function list(deps, cb) {
  const d = defaults(deps);
  if (!supported(deps)) return cb({ supported: false, devices: [] });
  if (cache && Date.now() - cache.at < CACHE_MS) return setImmediate(() => cb(cache.value));
  d.execFile("lsblk", ["-J", "-b", "-o", LSBLK_COLUMNS], { env: d.env, timeout: 10000 }, (e, out) => {
    // A failure is not cached: an lsblk too old for the MOUNTPOINTS column fails
    // every time anyway, and anything transient should be retried, not remembered.
    if (e) return cb({ supported: true, devices: [], error: "lsblk_failed" });
    const value = { supported: true, devices: parseDevices(out) };
    cache = { at: Date.now(), value };
    cb(value);
  });
}

// Resolve a caller's device string against what is actually plugged in. This is
// the gate: a string only reaches udisksctl when it names one of the partitions
// the list above just offered, so no path from the UI (or from an app sharing the
// shell's origin) can hand an arbitrary argument to a mount command.
function deviceFrom(devices, wanted) {
  const w = String(wanted || "");
  if (!DEVICE_RE.test(w)) return null;
  return devices.find((x) => x.device === w) || null;
}

function act(deps, verb, wanted, cb) {
  const d = defaults(deps);
  list(deps, (l) => {
    if (!l.supported) return cb({ ok: false, error: "unsupported" });
    const dev = deviceFrom(l.devices, wanted);
    if (!dev) return cb({ ok: false, error: "unknown_device" });
    d.execFile(
      "udisksctl",
      [verb, "-b", dev.device, "--no-user-interaction"],
      { env: d.env, timeout: TIMEOUT_MS },
      (e, _out, stderr) => {
        const code = e ? errorCode(stderr) : null;
        // "Already mounted" and "not mounted" are the state the caller asked for,
        // so they are successes: the TV asked for a folder to open, not for a
        // mount syscall to be issued.
        const benign = code === (verb === "mount" ? "already_mounted" : "not_mounted");
        invalidate(); // whatever happened, the cached answer is now the old one
        if (e && !benign) return cb({ ok: false, error: code, message: errorMessage(stderr) });
        // Report the mount point udisks actually used rather than the one its
        // message claims: a re-read cannot disagree with the rest of the UI, and
        // the message format is not something to depend on.
        list(deps, (after) => {
          const now = deviceFrom(after.devices, dev.device);
          cb({ ok: true, device: dev.device, mountpoint: now ? now.mountpoint : null });
        });
      },
    );
  });
}

const mount = (deps, device, cb) => act(deps, "mount", device, cb);
const unmount = (deps, device, cb) => act(deps, "unmount", device, cb);

module.exports = {
  LSBLK_COLUMNS,
  SYSTEM_MOUNTS,
  CACHE_MS,
  invalidate,
  parseDevices,
  errorCode,
  errorMessage,
  deviceFrom,
  supported,
  list,
  mount,
  unmount,
};
