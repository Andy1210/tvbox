// "This boot got as far as a working launcher."
//
// The root-side safe-mode counter (deploy/tvbox-safemode.sh) needs to know whether
// the previous boot actually worked, and only the shell can tell it: reaching the
// launcher is the first moment everything below it - session, compositor, HTTP
// server, renderer - is proven to work at once. The shell is rootless, so it cannot
// write to /var/lib or the boot partition; it drops a marker in its own home and
// tvbox-safemode deletes that at every boot, which is what makes the marker mean
// "the boot that just ended", not "some boot, once".
//
// Same signal the OTA health gate uses (updater.onLauncherLoaded), kept separate
// because it answers a different question: that one commits a release, this one
// says the box is bootable at all.
const fs = require("fs");
const os = require("os");
const path = require("path");

const MARKER = path.join(os.homedir(), ".tvbox", "healthy");

let marked = false;

// The launcher fires did-finish-load on every navigation (launcher <-> app), and
// the marker's content only concerns the boot, so write it once per process.
function markHealthy(version) {
  if (marked) return false;
  marked = true;
  const bootId = readBootId();
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(
      MARKER,
      "boot=" + bootId + "\nat=" + new Date().toISOString() + "\nversion=" + (version || "") + "\n",
    );
    return true;
  } catch (e) {
    // A box that cannot write here is a box in the trouble this marker exists to
    // report, so say so and carry on: never take the shell down over it.
    console.warn("[boothealth] cannot record a healthy boot: " + e.message);
    return false;
  }
}

// Recorded for whoever reads the marker by hand; the safe-mode script only cares
// that the file exists. Unreadable on a non-Linux dev host, which is not an error.
function readBootId() {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (e) {
    return "";
  }
}

module.exports = { markHealthy, MARKER };
