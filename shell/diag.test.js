// The fleet payload, against real command output.
//
// Every string below was captured from a running box (tvbox-gaming, on wifi).
// The parsing is the part that breaks here: /proc/net/wireless is fixed-width
// with trailing dots on its values, gdbus answers in GVariant rather than JSON,
// and update/failed carries the two versions in the opposite order to the one a
// reader expects (it is written "<rolled-back-to> <failed>").
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const diag = require("./diag");

const PROC_WIRELESS = `Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE
 face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22
 wlan0: 0000   55.  -55.  -256        0      0      0      0      0        0
`;

test("signal level comes from /proc/net/wireless in dBm, not nmcli's 0-100 quality", () => {
  const r = diag.parseWirelessLevel(PROC_WIRELESS, "wlan0");
  assert.equal(r.levelDbm, -55);
  assert.equal(r.quality, 55);
});

test("an interface that is not in the table reads as unknown, not as zero", () => {
  assert.deepEqual(diag.parseWirelessLevel(PROC_WIRELESS, "wlan1"), { levelDbm: null, quality: null });
  assert.deepEqual(diag.parseWirelessLevel("", "wlan0"), { levelDbm: null, quality: null });
});

test("the bitrate is parsed out of gdbus's GVariant", () => {
  assert.equal(diag.parseBitrateKbps("(<uint32 390000>,)\n"), 390000);
  assert.equal(diag.parseBitrateKbps("(<uint32 10000>,)\n"), 10000);
  assert.equal(diag.parseBitrateKbps("Error: no such device"), null);
});

test("the device object path is parsed out of the GetDeviceByIpIface reply", () => {
  const out = "(objectpath '/org/freedesktop/NetworkManager/Devices/3',)\n";
  assert.equal(diag.parseDevicePath(out), "/org/freedesktop/NetworkManager/Devices/3");
  assert.equal(diag.parseDevicePath("()"), null);
});

// nmcli -t -f DEVICE,TYPE,STATE device, from a box on wifi with the cable out.
const NMCLI_WIFI = `wlan0:wifi:connected
lo:loopback:connected (externally)
p2p-dev-wlan0:wifi-p2p:disconnected
eth0:ethernet:unavailable
`;
const NMCLI_BOTH = `eth0:ethernet:connected
wlan0:wifi:connected
lo:loopback:connected (externally)
`;

test("the active link is the connected one, and ethernet wins when both are up", () => {
  const wifiOnly = diag.parseDevices(NMCLI_WIFI);
  assert.equal(wifiOnly.active.type, "wifi");
  assert.equal(wifiOnly.wifiDevice, "wlan0");

  const both = diag.parseDevices(NMCLI_BOTH);
  assert.equal(both.active.type, "ethernet");
  assert.equal(both.wifiDevice, "wlan0"); // still known, just not the one carrying traffic
});

test("a box with nothing connected reports no link rather than guessing one", () => {
  const none = diag.parseDevices("eth0:ethernet:unavailable\nwlan0:wifi:disconnected\n");
  assert.equal(none.active, null);
});

test("the compositor version is read out of its own greeting, and absence is empty", () => {
  assert.equal(diag.parseCompositorVersion("tvbox-wc 0.1.6\n"), "0.1.6");
  assert.equal(diag.parseCompositorVersion(""), ""); // a box still on the old session has no binary
});

test("a rollback marker says which release failed and which one the box went back to", () => {
  const at = Date.UTC(2026, 7, 3, 4, 30, 0);
  const r = diag.parseRollback("2.1.0 2.2.0\n", at);
  assert.equal(r.from, "2.2.0"); // the release that could not boot
  assert.equal(r.to, "2.1.0"); // what run-shell.sh flipped back to
  assert.equal(r.at, new Date(at).toISOString());
});

test("a marker with no timestamp still names the versions", () => {
  assert.equal(diag.parseRollback("2.1.0 2.2.0", null).at, null);
  assert.equal(diag.parseRollback("", 1), null);
  assert.equal(diag.parseRollback("2.1.0", 1), null); // half a marker is not a rollback
});

// The wifi path end to end, through the injected execFile: three commands, and
// the rate has to come back in Mbit/s.
test("the wifi link is collected as rate plus level", (t, done) => {
  diag.init({
    execFile: (cmd, args, opts, cb) => {
      const line = [cmd].concat(args).join(" ");
      if (line.includes("nmcli")) return cb(null, NMCLI_WIFI);
      if (line.includes("GetDeviceByIpIface"))
        return cb(null, "(objectpath '/org/freedesktop/NetworkManager/Devices/3',)");
      if (line.includes("Properties.Get")) return cb(null, "(<uint32 390000>,)");
      return cb(new Error("unexpected command: " + line));
    },
  });
  diag.link((net) => {
    assert.equal(net.kind, "wifi");
    assert.equal(net.device, "wlan0");
    assert.equal(net.rateMbps, 390); // NetworkManager answers in kb/s: 390000
    done();
  });
});

test("an ethernet box asks NetworkManager nothing about wifi", (t, done) => {
  const seen = [];
  diag.init({
    execFile: (cmd, args, opts, cb) => {
      const line = [cmd].concat(args).join(" ");
      seen.push(line);
      if (line.includes("nmcli")) return cb(null, NMCLI_BOTH);
      return cb(new Error("unexpected command: " + line));
    },
  });
  diag.link((net) => {
    assert.equal(net.kind, "ethernet");
    assert.equal(net.rateMbps, null);
    assert.equal(
      seen.some((l) => l.includes("gdbus")),
      false,
    );
    done();
  });
});

// A command that is not there at all (a box provisioned before the baseline
// gained it) must not take the payload down with it.
test("a missing command costs its field, not the report", (t, done) => {
  diag.init({
    execFile: (cmd, args, opts, cb) => cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  });
  diag.link((net) => {
    assert.equal(net.kind, null);
    assert.equal(net.rateMbps, null);
    done();
  });
});

test("collect assembles one box's answer from system + updater", (t, done) => {
  diag.init({
    execFile: (cmd, args, opts, cb) => {
      const line = [cmd].concat(args).join(" ");
      if (line.includes("nmcli")) return cb(null, NMCLI_WIFI);
      if (line.includes("GetDeviceByIpIface"))
        return cb(null, "(objectpath '/org/freedesktop/NetworkManager/Devices/3',)");
      if (line.includes("Properties.Get")) return cb(null, "(<uint32 390000>,)");
      if (line.includes("tvbox-wc")) return cb(null, "tvbox-wc 0.1.6\n");
      return cb(new Error("unexpected command: " + line));
    },
  });
  const system = {
    systemInfo: (cb) =>
      cb({
        version: "2.2.0",
        hostname: "tvbox-gaming",
        model: "Raspberry Pi 5 Model B Rev 1.0",
        ip: "192.168.1.24",
        uptimeSec: 3600,
        cpuTempC: 61.2,
        mem: { totalKb: 8000000, availableKb: 5000000 },
        disk: { freeBytes: 20e9, totalBytes: 60e9 },
        wifi: { ssid: "home", signal: 55 },
      }),
  };
  const updater = {
    status: () => ({
      current: "2.2.0",
      release: "2.2.0",
      state: "idle",
      auto: true,
      available: false,
      latest: null,
      unmet: [],
      lastCheckAt: 1,
      // updater.osStatus()'s real shape: a list only when a reboot is pending.
      os: { rebootRequired: true, packages: ["linux-image-rpi-2712"] },
    }),
  };
  diag.collect({ system, updater }, (p) => {
    assert.equal(p.hostname, "tvbox-gaming");
    assert.equal(p.version, "2.2.0");
    assert.equal(p.compositor, "0.1.6");
    assert.equal(p.net.kind, "wifi");
    assert.equal(p.net.ssid, "home");
    assert.equal(p.net.rateMbps, 390);
    assert.equal(p.update.os.rebootRequired, true);
    assert.equal(typeof p.bootedAt, "string");
    done();
  });
});

// By the time the payload is assembled we are three execFile callbacks deep, so a
// TypeError here would NOT reach the caller's try/catch: it would reach the Electron
// main process as an uncaught exception. A box's diagnostics must not be able to do
// that, so a half-answer costs its fields and nothing else.
test("a system or updater that answers half a shape still yields a payload", (t, done) => {
  diag.init({
    execFile: (cmd, args, opts, cb) => {
      const line = [cmd].concat(args).join(" ");
      if (line.includes("nmcli")) return cb(null, NMCLI_WIFI);
      return cb(new Error("nothing else answers"));
    },
  });
  diag.collect(
    {
      system: { systemInfo: (cb) => cb({ hostname: "tvbox-spare" }) }, // no wifi, no mem, no disk
      updater: { status: () => null }, // and nothing at all from the updater
    },
    (p) => {
      assert.equal(p.hostname, "tvbox-spare");
      assert.equal(p.net.ssid, ""); // the field that used to throw
      assert.equal(p.release, null);
      assert.deepEqual(p.update.unmet, []);
      assert.equal(p.update.os, null);
      done();
    },
  );
});

// The marker is read off the real filesystem at a path the module resolved from
// os.homedir() when it was imported, so this runs in a CHILD PROCESS with its own
// HOME (the pattern integration.test.js uses, and for the same reason). Writing to
// the developer's real ~/.tvbox/update/failed would destroy the mtime of an actual
// rollback, which is the one thing about it that cannot be reconstructed.
test("a real update/failed marker is picked up with its own mtime", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-diag-"));
  fs.mkdirSync(path.join(home, ".tvbox", "update"), { recursive: true });
  fs.writeFileSync(path.join(home, ".tvbox", "update", "failed"), "2.1.0 2.2.0\n");
  const out = execFileSync(process.execPath, ["-e", 'console.log(JSON.stringify(require("./diag").rollback()))'], {
    cwd: __dirname,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  const r = JSON.parse(out);
  assert.equal(r.from, "2.2.0");
  assert.equal(r.to, "2.1.0");
  assert.ok(r.at, "the marker's mtime is the only record of when it happened");
  fs.rmSync(home, { recursive: true, force: true });
});

test("no marker at all is the normal case, not an error", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-diag-"));
  fs.mkdirSync(path.join(home, ".tvbox"), { recursive: true });
  const out = execFileSync(process.execPath, ["-e", 'console.log(JSON.stringify(require("./diag").rollback()))'], {
    cwd: __dirname,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(JSON.parse(out), null);
  fs.rmSync(home, { recursive: true, force: true });
});
