// Screen mirroring: the parts that decide behaviour without a radio.
//
// The negotiation itself is covered in wfd.test.js against a captured session.
// What is worth pinning here is the boundary with the privileged helper: which
// address we dial, that a refusal reaches the caller as a refusal rather than a
// silent no-op, and that stopping always hands the radio back.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const miracast = require("./miracast");

function stateFileWith(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mira-")), "state");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

test("the helper's state file is read as plain key=value", () => {
  const s = miracast.parseState("state=running\niface=p2p-wlan0-0\nssid=DIRECT-Iu\n\ngarbage\n");
  assert.strictEqual(s.state, "running");
  assert.strictEqual(s.iface, "p2p-wlan0-0");
  assert.strictEqual(s.ssid, "DIRECT-Iu");
  assert.strictEqual(Object.keys(s).length, 3, "a line with no = is not a setting");
});

test("the newest lease is the one to dial", () => {
  // A phone that reconnects can hold two leases, and the older one belongs to a
  // socket that is no longer listening - dialling it wastes the whole session.
  const leases = [
    "1786130000 be:27:7a:0a:aa:5e 192.168.49.10 Andy-s-S26-Ultra 01:be:27:7a:0a:aa:5e",
    "1786139999 be:27:7a:0a:aa:5e 192.168.49.14 Andy-s-S26-Ultra 01:be:27:7a:0a:aa:5e",
    "not a lease line",
    "1786135000 aa:bb:cc:dd:ee:ff not-an-ip Thing *",
  ].join("\n");
  assert.deepStrictEqual(miracast.peersFromLeases(leases), ["192.168.49.14", "192.168.49.10"]);
  assert.deepStrictEqual(miracast.peersFromLeases(""), []);
});

test("a failure to arm reaches the caller as a code, not as an exit status", () => {
  // Whatever went wrong, the viewer has to be told in their own language, so what
  // travels is a code the launcher translates - never a sentence from a shell
  // script, which would reach a Hungarian TV in English.
  const events = [];
  const m = miracast.create({
    stateFile: stateFileWith(["state=error", "error=radio-busy"]),
    onEvent: (e) => events.push(e),
    run: (cmd, args, opts, cb) => cb(new Error("exit 1"), "", ""),
  });

  let reported = null;
  m.start((err) => {
    reported = err;
  });

  assert.ok(reported, "the caller learns it failed");
  assert.strictEqual(m.isArmed(), false);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, "error");
  assert.strictEqual(events[0].message, "radio-busy", "and learns why - as a code the launcher can translate");
});

test("the helper's own code beats systemd's boilerplate", () => {
  // Measured on a box: `systemctl start` answers "the control process exited with
  // error code" and nothing else - the useful part went to the journal. The helper
  // leaves a code in the state file, and that is what must reach the screen.
  const events = [];
  const m = miracast.create({
    stateFile: stateFileWith(["state=error", "error=radio-busy"]),
    onEvent: (e) => events.push(e),
    run: (cmd, args, opts, cb) => cb(new Error("Command failed: systemctl start tvbox-miracast.service"), "", ""),
  });
  let reported = null;
  m.start((err) => {
    reported = err;
  });
  assert.strictEqual(events[0].message, "radio-busy");
  assert.strictEqual(String(reported.message), "radio-busy", "and the caller gets it too, not the exit code");
});

test("a helper that starts but produces no group is still a failure", () => {
  const events = [];
  const m = miracast.create({
    stateFile: stateFileWith(["state=stopped"]), // the unit "started", the radio did not
    onEvent: (e) => events.push(e),
    run: (cmd, args, opts, cb) => cb(null, "", ""),
  });
  let reported = null;
  m.start((err) => {
    reported = err;
  });
  assert.ok(reported, "an exit code of zero is not proof the group came up");
  assert.strictEqual(m.isArmed(), false);
  assert.strictEqual(events[0].type, "error");
});

test("stopping always hands the radio back, even when nothing was armed", () => {
  const calls = [];
  const m = miracast.create({
    stateFile: stateFileWith(["state=stopped"]),
    run: (cmd, args, opts, cb) => {
      calls.push([cmd, args.join(" ")]);
      cb(null, "", "");
    },
  });
  let stopped = false;
  m.stop(() => {
    stopped = true;
  });
  assert.ok(stopped);
  assert.deepStrictEqual(calls, [["systemctl", "stop " + miracast.UNIT]]);
});

test("the push button is re-opened on the group interface, without root", () => {
  const calls = [];
  const m = miracast.create({
    stateFile: stateFileWith(["state=running", "iface=p2p-wlan0-3"]),
    run: (cmd, args, opts, cb) => {
      calls.push([cmd, args]);
      cb(null, "", "");
    },
  });
  m.accept();
  assert.strictEqual(calls.length, 1);
  const [cmd, args] = calls[0];
  assert.strictEqual(cmd, "/usr/sbin/wpa_cli", "wpa_cli reaches the supplicant directly - the socket is group netdev");
  assert.deepStrictEqual(args.slice(-3), ["-i", "p2p-wlan0-3", "wps_pbc"]);
  assert.strictEqual(
    args.includes("sudo"),
    false,
    "nothing in the shell may call sudo - this box's root lives in provision only",
  );
});

test("with no group there is nothing to accept and nothing to dial", () => {
  const calls = [];
  const m = miracast.create({
    stateFile: path.join(os.tmpdir(), "definitely-not-here", "state"),
    run: (cmd, args, opts, cb) => {
      calls.push(cmd);
      cb(null, "", "");
    },
  });
  m.accept();
  assert.deepStrictEqual(calls, [], "a missing state file is a stopped sink, not a crash");
  assert.deepStrictEqual(m.peers(), []);
  assert.deepStrictEqual(m.state(), {});
});

test("the push button is a short, deliberate window - not a standing invitation", () => {
  // WPS push-button admits WHOEVER presses it: that is the protocol, so the guard
  // has to be the window rather than a credential, and a neighbour in radio range
  // is the threat this pins down.
  const T = 1000000;
  const deadline = T + miracast.PAIR_WINDOW_MS;

  assert.strictEqual(miracast.pairingGate(false, T, deadline), "open", "just armed: a phone may pair");
  assert.strictEqual(miracast.pairingGate(false, deadline - 1, deadline), "open", "still inside the window");
  assert.strictEqual(
    miracast.pairingGate(true, T, deadline),
    "shut",
    "a phone is already in, so nobody else is admitted - even mid-window",
  );
  assert.strictEqual(
    miracast.pairingGate(false, deadline + 1, deadline),
    "expired",
    "nobody came: give the radio back rather than leave an open button beaconing at an empty room",
  );
  assert.ok(miracast.PAIR_WINDOW_MS <= 180000, "a window measured in minutes, not for as long as mirroring is armed");
});
