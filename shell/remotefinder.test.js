const { test } = require("node:test");
const assert = require("node:assert");
const rf = require("./remotefinder");

// The one thing that must not go wrong: the remote's DFU service carries a
// characteristic with the SAME UUID as the finder's, so picking by UUID alone
// can select the firmware-update channel. Every fixture below is shaped to
// attack that choice from a different side.
//
// Real `bluetoothctl gatt.list-attributes` output from a Fire TV Remote Pro,
// trimmed to the two services that collide.
const DEV = "/org/bluez/hci0/dev_7C_ED_C6_12_E6_3C";
const MAC = "7c:ed:c6:12:e6:3c";
const OTHER = "aa:bb:cc:dd:ee:ff";
const ATTRS = `
Primary Service (Handle 0xff02)
	${DEV}/serviceff02
	cfbfb000-762c-4912-a043-20e3ecde0a2d
	Vendor specific
Characteristic (Handle 0xff03)
	${DEV}/serviceff02/charff03
	cfbfb001-762c-4912-a043-20e3ecde0a2d
	Vendor specific
Descriptor (Handle 0xff05)
	${DEV}/serviceff02/charff03/descff05
	00002902-0000-1000-8000-00805f9b34fb
	Client Characteristic Configuration
Primary Service (Handle 0xfe02)
	${DEV}/servicefe02
	cfbfa000-762c-4912-a043-20e3ecde0a2d
	Vendor specific
Characteristic (Handle 0xfe0e)
	${DEV}/servicefe02/charfe0e
	cfbfb001-762c-4912-a043-20e3ecde0a2d
	Vendor specific
`;
const RING_CHAR_PATH = DEV + "/serviceff02/charff03";
const DFU_CHAR_PATH = DEV + "/servicefe02/charfe0e";
// A second remote that can also ring, for the switching cases. Its paths reuse
// the same handles, which is exactly what BlueZ does - the device segment is
// the only thing telling them apart.
const DEV2 = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";
const ATTRS_TWO =
  ATTRS +
  `
Primary Service (Handle 0xff02)
	${DEV2}/serviceff02
	cfbfb000-762c-4912-a043-20e3ecde0a2d
	Vendor specific
Characteristic (Handle 0xff03)
	${DEV2}/serviceff02/charff03
	cfbfb001-762c-4912-a043-20e3ecde0a2d
	Vendor specific
`;

const pick = (text, mac = MAC) => rf.pickRingChar(rf.parseAttributes(text), mac);

test("the finder characteristic is the one under the finder service", () => {
  assert.equal(pick(ATTRS), RING_CHAR_PATH);
});

test("the DFU service's same-UUID characteristic is never chosen, whatever the order", () => {
  const reordered = ATTRS.split("Primary Service").reverse().join("Primary Service");
  assert.equal(pick(reordered), RING_CHAR_PATH);
});

test("a service UUID missing from the dump cannot be inherited from the next one", () => {
  // Without "the UUID is on the line directly below its path", the DFU service
  // takes the finder's UUID and its characteristic becomes the answer.
  const holed = ATTRS.replace("\tcfbfa000-762c-4912-a043-20e3ecde0a2d\n", "");
  const got = pick(holed);
  assert.notEqual(got, DFU_CHAR_PATH, "picked the firmware-update characteristic");
  assert.equal(got, RING_CHAR_PATH);
});

test("a characteristic nested deeper than a direct child is not the finder's", () => {
  const nested = ATTRS.replace(`${DEV}/servicefe02\n\tcfbfa000`, `${DEV}/serviceff02/servicefe02\n\tcfbfa000`).replace(
    `${DEV}/servicefe02/charfe0e`,
    `${DEV}/serviceff02/servicefe02/charfe0e`,
  );
  assert.equal(pick(nested), RING_CHAR_PATH);
});

test("a descriptor is never returned, even carrying the characteristic's UUID", () => {
  const d = ATTRS.replace("00002902-0000-1000-8000-00805f9b34fb", "cfbfb001-762c-4912-a043-20e3ecde0a2d");
  assert.equal(pick(d), RING_CHAR_PATH);
});

test("another device's finder service is not this remote's", () => {
  assert.equal(pick(ATTRS, OTHER), null);
});

test("a remote without the finder service has no path", () => {
  const only = ATTRS.slice(ATTRS.indexOf("Primary Service (Handle 0xfe02)"));
  assert.equal(pick(only), null);
});

test("a UUID that only resembles the finder's is not it", () => {
  assert.equal(
    pick(ATTRS.replace("cfbfb000-762c-4912-a043-20e3ecde0a2d", "cfbfb000-0000-0000-0000-000000000000")),
    null,
  );
});

test("colour codes in the output do not hide the path", () => {
  const coloured = ATTRS.split("\n")
    .map((l) => (l.trim() ? "\x1b[0;94m" + l + "\x1b[0m" : l))
    .join("\n");
  assert.equal(pick(coloured), RING_CHAR_PATH);
});

test("empty and junk input yield nothing rather than throwing", () => {
  for (const s of ["", "\n\n", "not a dump", DEV + "/serviceff02"]) assert.equal(pick(s), null);
});

test("a mac that is not a mac is refused before anything is matched", () => {
  for (const m of ["", "--monitor", "7C:ED:C6:12:E6", "../../etc", null]) assert.equal(pick(ATTRS, m), null);
});

// --- ringing -----------------------------------------------------------------

function harness(opts = {}) {
  const { attrs = ATTRS, failWrite = () => false, devices = "Device 7C:ED:C6:12:E6:3C Amazon Remote\n" } = opts;
  const calls = [];
  const timers = [];
  const finder = rf.makeFinder({
    execFile: (cmd, args, o, cb) => {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      const reply = () => {
        if (cmd === "bluetoothctl" && args[0] === "gatt.list-attributes") return cb(null, attrs);
        if (cmd === "bluetoothctl" && args[0] === "devices") return cb(null, devices);
        if (cmd === "bluetoothctl" && args[0] === "info") {
          const cap = args[1].toLowerCase() === MAC;
          return cb(
            null,
            "Connected: yes\n\tName: a remote\n" + (cap ? "\tUUID: Vendor specific (" + rf.RING_SERVICE + ")\n" : ""),
          );
        }
        if (cmd === "busctl") return cb(failWrite(line) ? new Error("link down") : null, "");
        cb(null, "");
      };
      setImmediate(reply); // real execFile is async; sync callbacks hide races
    },
    now: () => 0,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, live: true });
      return timers.length - 1;
    },
    clearTimeout: (i) => {
      if (timers[i]) timers[i].live = false;
    },
  });
  const live = () => timers.filter((t) => t.live);
  const writes = () => calls.filter((c) => c.startsWith("busctl"));
  return { finder, calls, timers, live, writes };
}

const ON = "0x03 0x01";
const OFF = "0x03 0x00";

test("ring on writes 03 01 to the finder characteristic, on the right bus object", async () => {
  const h = harness();
  assert.equal(await h.finder.ring(MAC, true), null);
  const w = h.writes()[0];
  assert.ok(w.includes("call org.bluez " + RING_CHAR_PATH + " org.bluez.GattCharacteristic1 WriteValue"), w);
  assert.ok(w.endsWith("aya{sv} 2 " + ON + " 0"), w);
  assert.equal(h.finder.isRinging(), MAC);
});

test("ring off writes 03 00 and forgets the ring", async () => {
  const h = harness();
  await h.finder.ring(MAC, true);
  assert.equal(await h.finder.ring(MAC, false), null);
  assert.ok(h.writes()[1].includes(OFF));
  assert.equal(h.finder.isRinging(), null);
  assert.equal(h.live().length, 0, "the auto-stop timer was cleared");
});

test("a ring nobody stops is stopped by the timer, after a minute", async () => {
  const h = harness();
  await h.finder.ring(MAC, true);
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0].ms, 60000, "the documented one-minute cap");
  h.live()[0].fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    h.writes().some((w) => w.includes(OFF)),
    "auto-stop wrote the off command",
  );
  assert.equal(h.finder.isRinging(), null);
});

test("a stop that could not be delivered keeps the ring and retries", async () => {
  // Forgetting here is the bug that leaves a remote buzzing with nothing
  // tracking it - the box would report "stopped" while the noise continues.
  const h = harness({ failWrite: (c) => c.includes(OFF) });
  await h.finder.ring(MAC, true);
  const err = await h.finder.ring(MAC, false);
  assert.ok(err, "the caller is told");
  assert.equal(h.finder.isRinging(), MAC, "still believed to be ringing");
  assert.equal(h.live().length, 1, "a retry is armed");
  assert.equal(h.live()[0].ms, 5000);
});

test("switching remotes reports a failed stop instead of losing the first one", async () => {
  const h = harness({ attrs: ATTRS_TWO, failWrite: (c) => c.includes(OFF) });
  await h.finder.ring(MAC, true);
  const err = await h.finder.ring(OTHER, true);
  assert.ok(err, "the switch failed");
  assert.equal(h.finder.isRinging(), MAC, "the first remote is still the one we track");
  assert.equal(h.writes().filter((w) => w.includes(ON)).length, 1, "the second was not started");
});

test("starting a second remote stops the first, so a stop cannot hit the wrong one", async () => {
  const h = harness({ attrs: ATTRS_TWO });
  await h.finder.ring(MAC, true);
  await h.finder.ring(OTHER, true);
  assert.equal(h.writes().filter((w) => w.includes(OFF)).length, 1);
  assert.equal(h.finder.isRinging(), OTHER);
  assert.equal(h.live().length, 1, "exactly one auto-stop is armed");
});

test("two overlapping starts do not leave a remote ringing untracked", async () => {
  // Unserialized, both see "nothing ringing", both start, and the loser's timer
  // later stops the winner while its own remote buzzes on.
  const h = harness({ attrs: ATTRS_TWO });
  const [a, b] = await Promise.all([h.finder.ring(MAC, true), h.finder.ring(OTHER, true)]);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(h.live().length, 1, "one live timer, not two");
  assert.equal(h.writes().filter((w) => w.includes(ON)).length, 2);
  assert.equal(h.writes().filter((w) => w.includes(OFF)).length, 1, "the first was stopped");
  assert.equal(h.finder.isRinging(), OTHER);
});

test("a stop issued while a start is still in flight is not swallowed", async () => {
  const h = harness();
  const [, stopErr] = await Promise.all([h.finder.ring(MAC, true), h.finder.ring(MAC, false)]);
  assert.equal(stopErr, null);
  assert.equal(h.finder.isRinging(), null, "the user pressed stop and it stayed stopped");
  assert.ok(h.writes().some((w) => w.includes(OFF)));
  assert.equal(h.live().length, 0);
});

test("a bad mac never reaches a command line", async () => {
  // The MQTT payload is not validated by its caller, so the module has to be.
  for (const bad of ["--monitor", "", "; reboot", "not-a-mac"]) {
    const h = harness();
    const err = await h.finder.ring(bad, true);
    assert.ok(err, "expected a refusal for " + JSON.stringify(bad));
    assert.equal(h.calls.length, 0, "nothing was spawned for " + JSON.stringify(bad));
  }
});

test("a remote with no finder service errors rather than writing", async () => {
  const only = ATTRS.slice(ATTRS.indexOf("Primary Service (Handle 0xfe02)"));
  const h = harness({ attrs: only });
  const err = await h.finder.ring(MAC, true);
  assert.ok(err);
  assert.equal(h.writes().length, 0, "nothing was written");
  assert.equal(h.finder.isRinging(), null);
});

test("only remotes that really carry the service are offered it", (t, done) => {
  const h = harness({
    devices: "Device 7C:ED:C6:12:E6:3C Amazon Remote\nDevice AA:BB:CC:DD:EE:FF Some Speaker\n",
  });
  h.finder.capableRemotes((macs) => {
    assert.deepEqual(macs, [MAC], "the speaker has no finder service");
    done();
  });
});

test("a device that merely NAMES itself after the service is not capable", (t, done) => {
  const rfDep = rf.makeFinder({
    execFile: (cmd, args, o, cb) =>
      setImmediate(() => {
        if (args[0] === "devices") return cb(null, "Device AA:BB:CC:DD:EE:FF " + rf.RING_SERVICE + "\n");
        if (args[0] === "info") return cb(null, "Connected: yes\n\tAlias: " + rf.RING_SERVICE + "\n");
        cb(null, "");
      }),
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  rfDep.capableRemotes((macs) => {
    assert.deepEqual(macs, []);
    done();
  });
});
