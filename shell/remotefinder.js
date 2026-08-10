// Make a lost remote ring.
//
// A Fire TV Remote Pro carries a buzzer behind a vendor GATT service: write
// `03 01` to start and `03 00` to stop. The ring is CONTINUOUS - nothing stops
// it by itself - so a start that is never answered has to be stopped by us.
//
// **The characteristic is chosen by its parent service AND by the device it
// belongs to, never by UUID alone.** The remote's DFU service (cfbfa000)
// exposes a characteristic with the SAME UUID as the finder's, and a write
// there is a firmware update. Everything strict in the parser below exists for
// that reason: the UUID must sit on the line directly under its own path, the
// characteristic must be a DIRECT child of the finder service, and the whole
// path must live under the device that was asked for. A resolved path is also
// re-derived per operation rather than cached, because BlueZ builds those path
// segments from attribute handles - a remote that re-pairs or updates its
// firmware can move them, and the neighbouring candidate is the DFU channel.
//
// Two tools, each where it is solid, both in the platform baseline:
// `bluetoothctl` (bluez - already required for BT remotes at all) lists the
// attributes with their object paths, and `busctl` (systemd) does the write.
// The remote is already connected as HID, so BlueZ holds the link and the write
// is one D-Bus call - no BLE client and no venv, unlike the IR keymap path in
// firetvir.js, which needs bleak for MTU negotiation and chunked writes.
const { execFile } = require("child_process");

const RING_SERVICE = "cfbfb000-762c-4912-a043-20e3ecde0a2d"; // the finder service
const RING_CHAR = "cfbfb001-762c-4912-a043-20e3ecde0a2d"; // its command characteristic
const DFU_SERVICE = "cfbfa000-762c-4912-a043-20e3ecde0a2d"; // same char UUID lives here - never write to it
const RING_ON = [0x03, 0x01];
const RING_OFF = [0x03, 0x00];
// A remote nobody finds would otherwise ring until its battery died.
const MAX_RING_MS = 60000;
// A stop that could not be delivered (the link drops constantly on some boxes)
// is retried rather than forgotten - the remote is still making a noise.
const STOP_RETRY_MS = 5000;
const STOP_RETRIES = 12;

// Same shape firetvir.js requires. Validated in this module rather than in its
// callers so no entry point can forget: the value reaches a helper binary's
// argv, where a leading "-" would be read as an option.
const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const strip = (s) =>
  String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .trim();

/**
 * bluetoothctl's attribute dump -> [{path, uuid}].
 *
 * The UUID must be on the line DIRECTLY under its path. Scanning ahead for the
 * next UUID-shaped line would let an attribute with no UUID inherit the next
 * one's - and the attribute after the finder service is the DFU service.
 */
function parseAttributes(text) {
  const out = [];
  const lines = String(text || "").split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    const path = /^(\/org\/bluez\/[\w/]+)$/.exec(strip(lines[i]));
    if (!path) continue;
    const uuid = strip(lines[i + 1]).toLowerCase();
    if (UUID_RE.test(uuid)) out.push({ path: path[1], uuid });
  }
  return out;
}

/**
 * The finder characteristic's object path for one device, or null.
 *
 * Three conditions, and each one is a way the wrong object could be picked:
 * the service must be THIS device's (a dump can hold several), the service must
 * be the finder's by full UUID, and the characteristic must be its direct child
 * - the DFU service carries the same characteristic UUID.
 */
function pickRingChar(entries, mac) {
  if (!MAC_RE.test(String(mac || ""))) return null;
  const dev = "/dev_" + String(mac).toUpperCase().replace(/:/g, "_") + "/";
  const mine = (entries || []).filter((e) => e.path.includes(dev));
  const svc = mine.find((e) => /\/service[0-9a-f]+$/i.test(e.path) && e.uuid === RING_SERVICE);
  if (!svc) return null;
  const child = new RegExp("^" + svc.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/char[0-9a-f]+$", "i");
  const ch = mine.find((e) => child.test(e.path) && e.uuid === RING_CHAR);
  return ch ? ch.path : null;
}

function makeFinder(deps) {
  const run = (deps && deps.execFile) || execFile;
  const now = (deps && deps.now) || (() => Date.now());
  const setTimer = (deps && deps.setTimeout) || setTimeout;
  const clearTimer = (deps && deps.clearTimeout) || clearTimeout;

  // -Infinity, not 0: a cache that has never been filled must not read as fresh.
  let capable = { ts: -Infinity, macs: [] };
  let state = null; // { mac, timer, retries } - the remote we believe is ringing
  let queue = Promise.resolve(); // one operation at a time (see `serial`)

  /**
   * Run `fn` after whatever is already in flight, so no two writes interleave.
   * The tail swallows failures on purpose: a rejected chain would never call
   * another `then`, so one throw would wedge the finder for the life of the
   * shell and leave every later caller awaiting a promise that never settles.
   */
  function serial(fn) {
    return new Promise((resolve) => {
      queue = queue
        .then(
          () =>
            new Promise((next) => {
              try {
                fn((err) => (resolve(err || null), next()));
              } catch (e) {
                resolve(e);
                next();
              }
            }),
        )
        .catch(() => {});
    });
  }

  /** MACs of connected remotes whose service list carries the finder service. */
  function capableRemotes(cb) {
    if (now() - capable.ts < 8000) return cb(capable.macs);
    run("bluetoothctl", ["devices", "Connected"], { timeout: 5000 }, (err, out) => {
      const macs = String(err ? "" : out || "")
        .split("\n")
        .map((l) => /Device ([0-9A-F:]{17})/i.exec(l))
        .filter(Boolean)
        .map((m) => m[1])
        .filter((m) => MAC_RE.test(m));
      const found = [];
      let pending = macs.length;
      if (!pending) {
        // A failed call must not be cached as "no remote can ring" - that would
        // hide the Settings row and the MQTT fallback for the next 8 seconds.
        if (!err) capable = { ts: now(), macs: found };
        return cb(found);
      }
      macs.forEach((mac) =>
        run("bluetoothctl", ["info", mac], { timeout: 5000 }, (e2, info) => {
          // Match a UUID LINE, not the whole dump: the device's own name is in
          // there, and a remote that calls itself "cfbfb000" is not a finder.
          const has = String(e2 ? "" : info || "")
            .split("\n")
            .some((l) => /^\s*UUID:/i.test(l) && l.toLowerCase().includes(RING_SERVICE));
          if (!e2 && /Connected: yes/i.test(info) && has) found.push(mac.toLowerCase());
          if (--pending === 0) {
            capable = { ts: now(), macs: found };
            cb(found);
          }
        }),
      );
    });
  }

  /** Resolve the finder characteristic's path for one remote. Never cached. */
  function charPath(mac, cb) {
    if (!MAC_RE.test(String(mac || ""))) return cb(new Error("bad mac"));
    const key = String(mac).toLowerCase();
    run("bluetoothctl", ["gatt.list-attributes", key], { timeout: 8000 }, (err, out) => {
      if (err) return cb(err);
      const path = pickRingChar(parseAttributes(out), key);
      cb(path ? null : new Error("this remote has no finder service"), path);
    });
  }

  function write(path, bytes, cb) {
    // busctl's WriteValue signature: ay (count then bytes) + a{sv} (count 0).
    const args = [
      "call",
      "org.bluez",
      path,
      "org.bluez.GattCharacteristic1",
      "WriteValue",
      "aya{sv}",
      String(bytes.length),
      ...bytes.map((b) => "0x" + b.toString(16).padStart(2, "0")),
      "0",
    ];
    run("busctl", args, { timeout: 8000 }, (err) => cb(err || null));
  }

  /** Send the off command, and only forget the ring once it has landed. */
  function doStop(cb) {
    const cur = state;
    if (!cur) return cb(null);
    clearTimer(cur.timer);
    charPath(cur.mac, (err, path) => {
      const failed = (e) => {
        // Still ringing as far as we know, so keep the state and try again -
        // dropping it here is what would leave a remote buzzing with nothing
        // tracking it. Bounded, so a remote that never comes back stops costing
        // timers.
        if (cur.retries < STOP_RETRIES) {
          cur.retries += 1;
          // Back through the queue: a retry that ran alongside a fresh start
          // would write while that start was mid-flight.
          cur.timer = setTimer(() => serial((fin) => doStop(fin)), STOP_RETRY_MS);
        } else if (state === cur) {
          // Give up only on the ring this chain owns. Another remote may have
          // become the tracked one while these retries were running.
          state = null;
        }
        cb(e);
      };
      if (err) return failed(err);
      write(path, RING_OFF, (e) => {
        if (e) return failed(e);
        if (state === cur) state = null;
        cb(null);
      });
    });
  }

  function doStart(mac, cb) {
    charPath(mac, (err, path) => {
      if (err) return cb(err);
      write(path, RING_ON, (e) => {
        if (e) return cb(e);
        const entry = { mac: String(mac).toLowerCase(), retries: 0, timer: null };
        entry.timer = setTimer(() => doStop(() => {}), MAX_RING_MS);
        state = entry;
        cb(null);
      });
    });
  }

  /**
   * Ring a remote, or stop whatever is ringing. Operations are serialized: two
   * callers that overlap would otherwise both see "nothing ringing", both
   * start, and leave one remote buzzing with no record of it.
   *
   * Only one remote rings at a time, and a stop always targets the one we
   * believe is ringing rather than the caller's argument - so an unvalidated
   * mac can never reach a write on the stop path.
   */
  function ring(mac, on, cb) {
    const done = cb || (() => {});
    return serial((finish) => {
      if (!on) return doStop(finish);
      if (!MAC_RE.test(String(mac || ""))) return finish(new Error("bad mac"));
      if (state && state.mac !== String(mac).toLowerCase()) {
        return doStop((err) => (err ? finish(err) : doStart(mac, finish)));
      }
      if (state) clearTimer(state.timer); // same remote again: restart its clock
      doStart(mac, finish);
    }).then((err) => {
      done(err);
      return err; // callers may await instead of passing a callback
    });
  }

  const stop = (cb) => ring(null, false, cb);
  const isRinging = () => (state ? state.mac : null);

  return { capableRemotes, ring, stop, isRinging, charPath };
}

module.exports = {
  parseAttributes,
  pickRingChar,
  makeFinder,
  MAC_RE,
  RING_SERVICE,
  RING_CHAR,
  DFU_SERVICE,
  RING_ON,
  RING_OFF,
  MAX_RING_MS,
  STOP_RETRY_MS,
  STOP_RETRIES,
  ...makeFinder({}),
};
