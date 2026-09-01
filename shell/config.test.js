// The box's own record that onboarding is finished.
//
// The launcher keeps a copy in its localStorage for a synchronous first render, but
// that store is not always the truth: an Electron instance that lost Chromium's
// storage lock reads it EMPTY, and a fully configured box was then walked through
// setup again - and could not save the answer either, so it asked at every start.
// This is the copy that survives that, so it has to be on disk, not in memory.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-config-test-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const config = require("./config"); // resolves ~/.tvbox/config.json at import
const FILE = path.join(HOME, ".tvbox", "config.json");

test("a box that was never set up says so", () => {
  assert.strictEqual(config.publicConfig().setup.done, false);
});

test("recording it lands on disk, not just in memory", () => {
  assert.strictEqual(config.setSetupDone(), true);
  assert.strictEqual(config.publicConfig().setup.done, true);
  const onDisk = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.strictEqual(onDisk.setup.done, true);
  assert.ok(typeof onDisk.setup.at === "number", "when, for anyone debugging later");
});

test("re-confirming it keeps when onboarding actually finished", () => {
  // The launcher re-confirms this on any start where its own copy went missing, so
  // the timestamp has to survive that - otherwise it drifts to "last seen" and
  // stops answering the only question it is there for.
  config.setSetupDone(); // stand on our own feet, not on the previous test's write
  const first = JSON.parse(fs.readFileSync(FILE, "utf8")).setup.at;
  config.setSetupDone();
  config.setSetupDone();
  assert.strictEqual(JSON.parse(fs.readFileSync(FILE, "utf8")).setup.at, first);
});

test("it is the launcher's only secret-free view of it", () => {
  // publicConfig is everything the launcher may see; the flag has to be in there or
  // the launcher has nothing to fall back on when its own store reads empty.
  assert.ok("setup" in config.publicConfig());
});

test("nothing else in the config is disturbed by recording it", () => {
  config.setAppConfig("plex", { baseUrl: "http://plex.example" });
  config.setSetupDone();
  assert.deepStrictEqual(config.appConfig("plex"), { baseUrl: "http://plex.example" });
  assert.strictEqual(config.publicConfig().setup.done, true);
});

// The ERTM toggle is a GLOBAL Bluetooth change reached over the HTTP config API,
// and the root applier greps config.json for a literal JSON true/false - so the
// only safe thing to store is a real boolean, and what the launcher is shown has
// to agree with what the applier will do.
test("the ERTM toggle stores a real boolean and ignores anything else", () => {
  assert.strictEqual(config.publicConfig().bluetooth.disableErtm, false, "defaults off");

  config.setBluetooth({ disableErtm: true });
  assert.strictEqual(config.publicConfig().bluetooth.disableErtm, true);
  config.setBluetooth({ disableErtm: false });
  assert.strictEqual(config.publicConfig().bluetooth.disableErtm, false);

  // A truthy non-boolean must not enable it: "false" is exactly what a hand-rolled
  // curl sends, and coercion would turn it on.
  for (const junk of ["false", "true", 1, 0, "", null, {}, []]) {
    config.setBluetooth({ disableErtm: junk });
    assert.strictEqual(config.publicConfig().bluetooth.disableErtm, false, `junk ${JSON.stringify(junk)} stayed off`);
  }

  // Junk already ON disk reads as off too - the applier would leave the radio alone,
  // so the row must not claim otherwise.
  config.setBluetooth({ disableErtm: true });
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  raw.bluetooth.disableErtm = "false";
  fs.writeFileSync(FILE, JSON.stringify(raw));
  assert.strictEqual(config.publicConfig().bluetooth.disableErtm, false);
});

// An app's manifest-declared switches. The app id and the key are both object keys
// here and both come from a manifest, so the guards are the subject.
test("an app switch is stored under its app id, and reads back", () => {
  assert.strictEqual(config.setAppSwitch("youtube", "cast", false), true);
  assert.strictEqual(config.appSwitches("youtube").cast, false);
  assert.strictEqual(config.setAppSwitch("youtube", "cast", true), true);
  assert.strictEqual(config.appSwitches("youtube").cast, true);
  // Sections keyed by app id, never a section NAMED after the app: an app id is not
  // a namespace we control, so `update` must not be able to reach the shell's own.
  assert.strictEqual(config.setAppSwitch("update", "auto", false), true);
  assert.strictEqual(config.appSwitches("update").auto, false);
  assert.notStrictEqual(config.publicConfig().update.auto, false, "the shell's own update setting is untouched");
});

test("a switch key or app id that is not a property is refused", () => {
  for (const id of ["__proto__", "constructor", "prototype", "With Caps", "a".repeat(65), ""]) {
    assert.strictEqual(config.setAppSwitch(id, "cast", true), false, "id " + JSON.stringify(id));
  }
  for (const key of ["__proto__", "constructor", "prototype", "Cast", "with space", "k".repeat(33), ""]) {
    assert.strictEqual(config.setAppSwitch("youtube", key, true), false, "key " + JSON.stringify(key));
  }
  assert.deepStrictEqual(Object.keys(config.appSwitches("youtube")), ["cast"], "and nothing else was written");
  assert.strictEqual({}.cast, undefined, "Object.prototype is unpolluted");
});

test("the value is a boolean whatever was passed, and an unknown app reads empty", () => {
  config.setAppSwitch("someapp", "flag", "yes");
  assert.strictEqual(config.appSwitches("someapp").flag, true);
  assert.deepStrictEqual(config.appSwitches("nosuchapp"), {});
  // A lookup for a name every object has must not answer with a function.
  assert.deepStrictEqual(config.appSwitches("constructor"), {});
});

test("both caps hold, and a switch already stored stays flippable at the cap", () => {
  for (let i = 0; i < 8; i++) assert.strictEqual(config.setAppSwitch("capped", "k" + i, true), true);
  assert.strictEqual(config.setAppSwitch("capped", "k8", true), false, "the 9th switch of one app");
  assert.strictEqual(config.setAppSwitch("capped", "k0", false), true, "an existing one still moves");
  assert.strictEqual(config.appSwitches("capped").k0, false);
});

test("a corrupted appSwitches section degrades to empty rather than throwing", () => {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  raw.appSwitches = "not an object";
  fs.writeFileSync(FILE, JSON.stringify(raw));
  assert.deepStrictEqual(config.appSwitches("youtube"), {});
  assert.strictEqual(config.setAppSwitch("youtube", "cast", true), true, "and a write repairs it");
  assert.strictEqual(config.appSwitches("youtube").cast, true);
});

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

// ---- the firetv IR backend ---------------------------------------------------------
// A third blaster whose "device" is the Fire TV remote already paired to the box. It
// carries no secret - the BlueZ bond is the credential - so the block is a MAC plus
// which plan entry each action points at.
test("a firetv blaster round-trips, and only with a real MAC", () => {
  config.setIr({
    backend: "firetv",
    firetv: { mac: "7c:ed:c6:12:e6:3c", actions: { input_hdmi2: "tv:HDMI2", soundbar_power: "audio:Power" } },
  });
  const pub = config.publicConfig().ir;
  assert.equal(pub.backend, "firetv");
  assert.equal(pub.firetv.mac, "7C:ED:C6:12:E6:3C", "stored uppercase, however it was typed");
  assert.deepEqual(pub.firetv.actions, { input_hdmi2: "tv:HDMI2", soundbar_power: "audio:Power" });
  assert.equal(pub.configured, true);

  const raw = config.rawIr();
  assert.equal(raw.backend, "firetv");
  assert.equal(raw.firetv.mac, "7C:ED:C6:12:E6:3C");

  // A typo does NOT throw the action map away. This config is hand-edited, and losing a
  // whole mapping over one bad field is the kind of silence nobody notices until a
  // button stops working; an EMPTY mac is the deliberate way to clear it.
  config.setIr({ firetv: { mac: "not-a-mac", actions: { input_hdmi2: "tv:HDMI2" } } });
  assert.equal(config.publicConfig().ir.firetv.mac, "7C:ED:C6:12:E6:3C", "the stored MAC survives a typo");
  assert.deepEqual(config.publicConfig().ir.firetv.actions, {
    input_hdmi2: "tv:HDMI2",
    soundbar_power: "audio:Power",
  });

  config.setIr({ firetv: { mac: "" } });
  assert.equal(config.publicConfig().ir.firetv.mac, "", "an empty MAC clears the block");
});

test("an action pointing nowhere real is dropped, not stored", () => {
  // The value becomes a lookup into the saved remote plan. A malformed one would fail
  // per-press with nothing on any screen having said so, which is the failure this
  // whole area keeps producing - so it is refused at the save.
  config.setIr({
    backend: "firetv",
    firetv: {
      mac: "7C:ED:C6:12:E6:3C",
      actions: {
        input_hdmi2: "tv:HDMI2", // good
        input_hdmi3: "tv:hdmi3", // wrong case - not a key name
        soundbar_power: "speaker:Power", // not a device kind
        soundbar_mute: "audio:Volume", // not a key
        mute: "audio:Mute; rm -rf /", // not a target at all
      },
    },
  });
  assert.deepEqual(config.publicConfig().ir.firetv.actions, { input_hdmi2: "tv:HDMI2" });
});

test("every action in the vocabulary can be mapped", () => {
  // The list is closed, and a name that silently would not store is a feature that
  // looks configured and never fires.
  const actions = {};
  for (const a of [
    "volume_up",
    "volume_down",
    "mute",
    "tv_power",
    "input_next",
    "input_hdmi1",
    "input_hdmi2",
    "input_hdmi3",
    "input_hdmi4",
    "soundbar_power",
    "soundbar_volume_up",
    "soundbar_volume_down",
    "soundbar_mute",
  ])
    actions[a] = "tv:Power";
  config.setIr({ backend: "firetv", firetv: { mac: "7C:ED:C6:12:E6:3C", actions } });
  assert.deepEqual(Object.keys(config.publicConfig().ir.firetv.actions).sort(), Object.keys(actions).sort());
});

test("a button can be bound to an IR action", () => {
  // The remap is what puts a TV input on a button the remote has no key for. The NAME
  // is not checked against the blaster's mapping here on purpose: the two are edited on
  // different screens, and dropping the binding would lose it silently.
  config.setRemote({
    devices: {
      "7C:ED:C6:12:E6:3C": { name: "Remote Pro", keymap: { "ir:soundbar_power": [640], "ir:nope!": [641] } },
    },
  });
  const km = config.publicConfig().remote.devices["7C:ED:C6:12:E6:3C"].keymap;
  assert.deepEqual(km["ir:soundbar_power"], [640], "the headphone button's usage, 0x0280");
  assert.ok(!("ir:nope!" in km), "but the charset is still the charset");
});
