// tvbox MQTT bridge. Connects to the broker (a provisioned `tvbox` user), and:
//  - publishes now-playing to  tvbox/<deviceId>/nowplaying  (+ HA MQTT discovery
//    so a sensor auto-appears in Home Assistant),
//  - publishes the full player state to  tvbox/<deviceId>/state  (retained) - what
//    the Home Assistant media_player entity runs on (docs/homeassistant-integration.md),
//  - announces itself, retained, on  tvbox/<deviceId>/announce, which is what makes
//    the box DISCOVERABLE: the tvbox HA integration declares that topic in its
//    manifest, so Home Assistant offers the box for setup with no ids typed in.
//    MQTT discovery cannot create a media_player (Home Assistant has no such MQTT
//    platform), so integration-level discovery is the equivalent.
//  - publishes what the box knows about ITSELF to  tvbox/<deviceId>/diag  (retained) -
//    version, update/rollback outcome, link rate, heat, disk (shell/diag.js). Retained
//    because the question it answers is asked hours later: docs/fleet-view.md,
//  - announces availability via a retained LWT on  tvbox/<deviceId>/status,
//  - subscribes  tvbox/<deviceId>/cmd    (control: launch app / transport / TV power)
//        and     tvbox/<deviceId>/notify (on-screen notifications).
// The mqtt npm client auto-reconnects. Secrets come from config.rawMqtt().
const mqtt = require("mqtt");
const identity = require("./identity"); // what makes this box THIS box (derived device id)

let client = null;
let base = "";
let deviceId = "";
// The IR actions whose HA buttons are currently on the broker. Kept so a reconnect can
// republish the same set, and so an action REMOVED from the config takes its button with
// it - a discovery config topic is retained, so a button nobody deletes stays in Home
// Assistant forever and presses into a box that no longer maps it.
let irPublished = [];

const safeId = identity.safeId; // one topic-segment rule, shared with the derived default

function init(cfg, handlers) {
  if (!cfg || !cfg.host) return null;
  handlers = handlers || {};
  // Derived from the hostname, not the constant "tvbox": that constant made every
  // box that never set one publish into a single topic tree, which looks fine
  // until there are two boxes and each acts on the other's commands.
  //
  // safeId here as well as in setMqtt: a RESTORE writes config.json through
  // config.replaceAll(), which does not sanitize, so a backup can reintroduce a
  // deviceId with a `/` or `#` in it - and that does not fail, it silently moves
  // or widens the box's whole topic tree.
  deviceId = safeId(cfg.deviceId || identity.defaultDeviceId());
  base = "tvbox/" + deviceId;
  const statusTopic = base + "/status";
  const url = "mqtt://" + cfg.host + ":" + (cfg.port || 1883);
  client = mqtt.connect(url, {
    username: cfg.username,
    password: cfg.password,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    will: { topic: statusTopic, payload: "offline", retain: true, qos: 0 },
  });
  client.on("connect", () => {
    console.log("[mqtt] connected", url, "as", deviceId);
    client.publish(statusTopic, "online", { retain: true });
    client.subscribe([base + "/cmd", base + "/notify"], (e) => {
      if (e) console.warn("[mqtt] subscribe:", e.message);
    });
    publishDiscovery();
  });
  client.on("message", (topic, buf) => {
    let payload;
    try {
      payload = JSON.parse(buf.toString() || "{}");
    } catch (e) {
      payload = { text: buf.toString() };
    }
    try {
      if (topic === base + "/cmd" && handlers.onCommand) handlers.onCommand(payload);
      else if (topic === base + "/notify" && handlers.onNotify) handlers.onNotify(payload);
    } catch (e) {
      console.warn("[mqtt] handler:", e.message);
    }
  });
  client.on("error", (e) => console.warn("[mqtt] error:", e.message));
  client.on("reconnect", () => console.log("[mqtt] reconnecting…"));
  return {
    publish,
    publishDiscovery,
    announce,
    deviceId: () => deviceId,
    connected: () => !!(client && client.connected),
  };
}

// Retained "this box exists, here is where it lives". Home Assistant's mqtt
// integration watches this topic on behalf of the tvbox integration, so a box that
// comes online is offered for setup rather than configured by hand - and because it
// is retained, a Home Assistant installed later still finds it.
function announce(info) {
  if (!client) return;
  // info FIRST, then the fixed fields: id and base are what Home Assistant keys
  // discovery off, and a caller that happened to pass either of them would
  // otherwise announce a box at an address it does not listen on.
  publish("announce", { ...(info || {}), id: deviceId, base: base }, { retain: true });
}

// Publish under the device base. Objects are JSON-encoded; retain for state
// topics (nowplaying) so a late HA subscriber gets the current value.
function publish(subtopic, payload, opts) {
  if (!client) return;
  const p = typeof payload === "string" ? payload : JSON.stringify(payload || {});
  try {
    client.publish(base + "/" + subtopic, p, { retain: !!(opts && opts.retain) });
  } catch (e) {}
}

// A button entity per IR action the blaster has mapped, so anything in Home Assistant -
// a dashboard, an automation, a voice assistant - can send one without knowing this
// box's topic layout. The press publishes the SAME command an external caller would, so
// there is one path into the box rather than a second private one.
//
// What the actions are is the blaster's business (shell/ir.js): a box with no IR
// configured publishes none, and a box whose config lost one deletes its button.
const IR_BUTTON_NAMES = {
  volume_up: "TV volume up",
  volume_down: "TV volume down",
  mute: "TV mute",
  tv_power: "TV power",
  input_next: "TV next input",
  input_hdmi1: "TV input HDMI 1",
  input_hdmi2: "TV input HDMI 2",
  input_hdmi3: "TV input HDMI 3",
  input_hdmi4: "TV input HDMI 4",
  soundbar_power: "Soundbar power",
  soundbar_volume_up: "Soundbar volume up",
  soundbar_volume_down: "Soundbar volume down",
  soundbar_mute: "Soundbar mute",
};

// A power button that looks like a volume button is a button somebody presses by
// mistake, and there are four of each here.
const IR_BUTTON_ICONS = {
  tv_power: "mdi:power",
  soundbar_power: "mdi:power",
  mute: "mdi:volume-off",
  soundbar_mute: "mdi:volume-off",
};

function irButtonTopic(sid, action) {
  return "homeassistant/button/tvbox_" + sid + "/ir_" + action + "/config";
}

function publishIrButtons(actions, sid, device) {
  // Only what this module put there is ever deleted, and only a name it knows is ever
  // published: `actions` comes from a config file, and an unknown one has no name to
  // show and no reason to exist as an entity.
  const want = (Array.isArray(actions) ? actions : []).filter((a) =>
    Object.prototype.hasOwnProperty.call(IR_BUTTON_NAMES, a),
  );
  // Delete every action NOT wanted, from the whole vocabulary rather than from what
  // this process happens to have published. `irPublished` is empty at startup, so
  // diffing against it only ever cleaned up within one run - while the config topics
  // are RETAINED, so a button whose action was removed while the box was off, or one
  // left behind by an OTA rollback to a shell that never heard of the action, stayed in
  // Home Assistant looking available and pressed into `unknown command`. The cost of
  // being thorough is a handful of empty publishes on a topic that already has nothing.
  for (const gone of Object.keys(IR_BUTTON_NAMES)) {
    if (want.includes(gone)) continue;
    try {
      client.publish(irButtonTopic(sid, gone), "", { retain: true });
    } catch (e) {}
  }
  for (const action of want) {
    const payload = {
      name: IR_BUTTON_NAMES[action],
      unique_id: "tvbox_" + sid + "_ir_" + action,
      command_topic: base + "/cmd",
      // The command topic takes JSON, so the press is the same object an automation or
      // an assistant would publish by hand.
      payload_press: JSON.stringify({ action }),
      availability_topic: base + "/status",
      icon: IR_BUTTON_ICONS[action] || (action.startsWith("input") ? "mdi:video-input-hdmi" : "mdi:volume-high"),
      // Filed as device configuration, which is what keeps these OUT of an area sweep.
      // A caller that asks Home Assistant to act on every `button` in a room would
      // otherwise press all of them at once - every input, both power keys - and an
      // input press is the one action here that cannot be undone from the box. Naming
      // an entity explicitly still reaches it; only the sweep is excluded.
      entity_category: "config",
      device,
    };
    try {
      client.publish(irButtonTopic(sid, action), JSON.stringify(payload), { retain: true });
    } catch (e) {}
  }
  irPublished = want;
}

// HA MQTT discovery: a now-playing sensor whose state is the title and whose
// attributes carry artist/app/image, available-gated on the LWT status topic; plus a
// button per configured IR action.
//
// `irActions` omitted means "whatever was published last" - a reconnect has to restate
// the set without knowing it, while a config save passes the new one.
function publishDiscovery(irActions) {
  if (!client) return;
  const sid = safeId(deviceId);
  const payload = {
    name: "Now playing", // HA prepends the device name -> "tvbox <id> Now playing"
    unique_id: "tvbox_" + sid + "_nowplaying",
    state_topic: base + "/nowplaying",
    value_template: "{{ value_json.title | default('') }}",
    json_attributes_topic: base + "/nowplaying",
    availability_topic: base + "/status",
    icon: "mdi:television-play",
    device: {
      identifiers: ["tvbox_" + sid],
      name: "tvbox " + deviceId,
      manufacturer: "tvbox",
      model: "Raspberry Pi TV box",
    },
  };
  try {
    client.publish("homeassistant/sensor/tvbox_" + sid + "/nowplaying/config", JSON.stringify(payload), {
      retain: true,
    });
  } catch (e) {}
  publishIrButtons(irActions === undefined ? irPublished : irActions, sid, payload.device);
}

function stop() {
  if (!client) return;
  try {
    client.publish(base + "/status", "offline", { retain: true });
    client.end(true);
  } catch (e) {}
  client = null;
}

// The discovery half is testable without a broker: the publish surface is one method.
function setStateForTest(st) {
  client = st.client || null;
  base = st.base === undefined ? base : st.base;
  deviceId = st.deviceId === undefined ? deviceId : st.deviceId;
  irPublished = st.irPublished || [];
}

module.exports = {
  init,
  stop,
  _test: { IR_BUTTON_NAMES, irButtonTopic, publishDiscovery, setStateForTest, published: () => irPublished },
};
