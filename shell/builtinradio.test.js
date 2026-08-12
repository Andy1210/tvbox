// Offline tests for the built-in radio setting.
//
// Nothing here touches /boot or systemd: what is worth pinning is how a config
// file is READ (a commented line is a note, not a setting), that only the four
// known actions reach systemd, and that the answer to "may I?" is a warning
// rather than a refusal - this setting is reachable from the couch, so every
// change it makes can be undone there.
const assert = require("node:assert");
const test = require("node:test");

const radio = require("./builtinradio");
const { overlayPresent } = radio._test;

/** An injected async reader that answers with one fixed config text. */
const mockRead = (text) => ({ readFile: (_p, _enc, cb) => cb(null, text) });

const CONFIG_PLAIN = `# For more options and information see
dtparam=audio=on
[all]
vc4.force_hotplug=1
`;

const CONFIG_BT_OFF = `${CONFIG_PLAIN}[all]
dtoverlay=disable-bt
`;

test("an overlay counts only when it is actually set", () => {
  assert.strictEqual(overlayPresent(CONFIG_BT_OFF, "bt"), true);
  assert.strictEqual(overlayPresent(CONFIG_BT_OFF, "wifi"), false);
  assert.strictEqual(overlayPresent(CONFIG_PLAIN, "bt"), false);
});

test("a commented line is a note, not a setting", () => {
  // Someone leaving a reminder in the file must not read as "Bluetooth is off",
  // or the UI offers to re-enable a radio that was never disabled.
  assert.strictEqual(overlayPresent("#dtoverlay=disable-bt\n", "bt"), false);
  assert.strictEqual(overlayPresent("  # dtoverlay=disable-bt\n", "bt"), false);
  assert.strictEqual(overlayPresent("  dtoverlay=disable-bt\n", "bt"), true, "indented is still set");
});

test("a longer overlay name is not a match", () => {
  // `disable-bt-something` is a different overlay; matching it as `disable-bt`
  // would report Bluetooth as off and offer a switch that changes nothing.
  assert.strictEqual(overlayPresent("dtoverlay=disable-bt-fake\n", "bt"), false);
  assert.strictEqual(overlayPresent("dtoverlay=disable-btx\n", "bt"), false);
  assert.strictEqual(overlayPresent("dtoverlay=disable-bt,param=1\n", "bt"), true, "parameters still count");
});

test("state comes from the file, and an unreadable file is not an answer", (t, done) => {
  radio.readState((readable) => {
    assert.deepStrictEqual(readable, { readable: true, wifi: "on", bt: "off" });
    radio.readState(
      (missing) => {
        assert.deepStrictEqual(missing, { readable: false, wifi: null, bt: null });
        done();
      },
      { readFile: (_p, _enc, cb) => cb(new Error("ENOENT")) },
    );
  }, mockRead(CONFIG_BT_OFF));
});

test("the boot partition is never read synchronously", () => {
  // It is FAT on an SD card, and this runs in the Electron main process: a card
  // that stalls would take the whole UI with it, and both settings pages ask on
  // mount. Pinned because the sync form is the easy one to reach for.
  assert.doesNotMatch(require("fs").readFileSync(require.resolve("./builtinradio"), "utf8"), /readFileSync/);
});

test("only the compound dead end asks for a confirmation", () => {
  // A single radio off is recoverable from the couch, so it is warned about and
  // not gated. Both off with no cable leaves no network, no BT remote and no
  // phone - and it survives a reboot.
  const strand = (o) => radio.wouldStrand(o);
  assert.strictEqual(strand({ state: { wifi: "on", bt: "off" }, radio: "wifi", on: false, ethernet: null }), true);
  assert.strictEqual(strand({ state: { wifi: "off", bt: "on" }, radio: "bt", on: false, ethernet: null }), true);
  assert.strictEqual(
    strand({ state: { wifi: "on", bt: "on" }, radio: "wifi", on: false, ethernet: null }),
    false,
    "the first radio is only a warning",
  );
  assert.strictEqual(
    strand({ state: { wifi: "on", bt: "off" }, radio: "wifi", on: false, ethernet: { connected: true } }),
    false,
    "a cabled box keeps a way in",
  );
  assert.strictEqual(
    strand({ state: { wifi: "off", bt: "off" }, radio: "wifi", on: true, ethernet: null }),
    false,
    "turning one back ON is never gated",
  );
});

test("apply starts the one unit that matches the action", () => {
  const calls = [];
  const run = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    cb(null, "", "");
  };
  radio.apply({ radio: "bt", on: false }, () => {}, { run });
  radio.apply({ radio: "wifi", on: true }, () => {}, { run });
  // `--no-ask-password` is part of the call, not decoration: a box provisioned
  // before this feature's polkit grant existed has no grant, and without the flag
  // systemctl would answer the missing authorisation by spawning pkttyagent -
  // which reads a terminal, takes SIGTTIN, and stops the shell and its respawn
  // loop with it. A missing grant has to fail, not freeze the TV.
  assert.deepStrictEqual(calls, [
    ["systemctl", "--no-ask-password", "start", "tvbox-radio@bt-off.service"],
    ["systemctl", "--no-ask-password", "start", "tvbox-radio@wifi-on.service"],
  ]);
});

test("an unknown radio never reaches systemctl", () => {
  let ran = false;
  const run = () => {
    ran = true;
  };
  let err = null;
  radio.apply({ radio: "zigbee", on: false }, (e) => (err = e), { run });
  assert.ok(err, "it errors");
  assert.strictEqual(ran, false, "and nothing was started");
});

test("a direction that is not a boolean never reaches systemctl", () => {
  // `on: "false"` is truthy, so reading it loosely would start `wifi-on` for a
  // request to turn the radio off. The route checks the type too; the module
  // should not depend on its caller for that.
  let ran = false;
  for (const on of ["false", 0, null, undefined]) {
    let err = null;
    radio.apply({ radio: "wifi", on }, (e) => (err = e), {
      run: () => {
        ran = true;
      },
    });
    assert.ok(err, `${JSON.stringify(on)} is refused`);
  }
  assert.strictEqual(ran, false);
});

test("systemd's own message survives, because the box user cannot read the journal", () => {
  const run = (cmd, args, opts, cb) =>
    cb(new Error("Command failed"), "", "Failed to start tvbox-radio@bt-off.service: Access denied\n");
  let err = null;
  radio.apply({ radio: "bt", on: false }, (e) => (err = e), { run });
  assert.match(String(err.message), /Access denied/);
});

test("the helper is looked for where provision puts it", () => {
  const seen = [];
  assert.strictEqual(
    radio.helperInstalled({
      exists: (p) => {
        seen.push(p);
        return true;
      },
    }),
    true,
  );
  assert.deepStrictEqual(seen, ["/usr/local/sbin/tvbox-radio"]);
  assert.strictEqual(radio.helperInstalled({ exists: () => false }), false);
});
