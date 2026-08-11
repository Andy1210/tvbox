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

test("state comes from the file, and an unreadable file is not an answer", () => {
  const readable = radio.readState({ readFile: () => CONFIG_BT_OFF });
  assert.deepStrictEqual(readable, { readable: true, wifi: "on", bt: "off" });

  const missing = radio.readState({
    readFile: () => {
      throw new Error("ENOENT");
    },
  });
  assert.deepStrictEqual(missing, { readable: false, wifi: null, bt: null });
});

test("nothing is refused - the owner is warned instead", () => {
  // Every one of these is recoverable from the couch: this setting lives in
  // Settings on the TV, which needs no network and answers the remote.
  const off = { radio: "wifi", on: false };
  assert.strictEqual(radio.warningFor({ ...off, ethernet: { connected: false } }), "goes-offline");
  assert.strictEqual(radio.warningFor({ ...off, ethernet: null }), "goes-offline");
  assert.strictEqual(radio.warningFor({ ...off, ethernet: { connected: true } }), null, "a cabled box loses nothing");
  assert.strictEqual(radio.warningFor({ radio: "bt", on: false, ethernet: null }), "loses-bluetooth");
});

test("turning a radio back on warns about nothing", () => {
  assert.strictEqual(radio.warningFor({ radio: "wifi", on: true, ethernet: null }), null);
  assert.strictEqual(radio.warningFor({ radio: "bt", on: true, ethernet: null }), null);
});

test("apply starts the one unit that matches the action", () => {
  const calls = [];
  const run = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    cb(null, "", "");
  };
  radio.apply({ radio: "bt", on: false }, () => {}, { run });
  radio.apply({ radio: "wifi", on: true }, () => {}, { run });
  assert.deepStrictEqual(calls, [
    ["systemctl", "start", "tvbox-radio@bt-off.service"],
    ["systemctl", "start", "tvbox-radio@wifi-on.service"],
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
