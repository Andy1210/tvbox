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
//  - on a canary box, vouches for its release on  tvbox/<deviceId>/canary  (retained),
//    and on a follower, reads every other box's  tvbox/+/canary  (shell/canary.js),
//  - subscribes  tvbox/<deviceId>/cmd    (control: launch app / transport / TV power)
//        and     tvbox/<deviceId>/notify (on-screen notifications).
// The mqtt npm client auto-reconnects. Secrets come from config.rawMqtt().
const fs = require("fs");
const os = require("os");
const path = require("path");
const mqtt = require("mqtt");
const identity = require("./identity"); // what makes this box THIS box (derived device id)
const canary = require("./canary"); // what a canary topic may say

// The device id this box last published under. A rename (a new hostname, or an
// id set in Settings) moves the whole topic tree, and every retained message
// under the old one - the announce, the state, the discovery configs - would
// stay on the broker for good: a second, dead box in Home Assistant.
const LAST_ID_FILE = path.join(os.homedir(), ".tvbox", "mqtt-last-id");

let client = null;
let base = "";
let deviceId = "";
// The IR actions whose HA buttons are currently on the broker. Kept so a reconnect can
// republish the same set, and so an action REMOVED from the config takes its button with
// it - a discovery config topic is retained, so a button nobody deletes stays in Home
// Assistant forever and presses into a box that no longer maps it.
let irPublished = [];
// The other boxes' canary topics, box id -> canary.parseVouch(). Bounded: every
// holder of the broker credentials can publish under any id.
const vouches = new Map();
const MAX_VOUCHES = 64;

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
  vouches.clear();
  // mqtts:// verifies the broker's certificate against the system store: the
  // credentials and every command travel this connection, so a broker that
  // cannot prove who it is does not get them.
  const url = (cfg.tls ? "mqtts://" : "mqtt://") + cfg.host + ":" + (cfg.port || (cfg.tls ? 8883 : 1883));
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
    const topics = [base + "/cmd", base + "/notify"];
    if (handlers.followCanaries) topics.push("tvbox/+/canary");
    client.subscribe(topics, (e) => {
      if (e) console.warn("[mqtt] subscribe:", e.message);
    });
    publishDiscovery();
    forgetPreviousId(handlers.lastIdFile || LAST_ID_FILE);
    // Everything else this box keeps retained, restated by the caller: a broker
    // that restarted without its retained store has none of it, and nothing
    // else would publish it again until the next change.
    if (handlers.onConnect) {
      try {
        handlers.onConnect();
      } catch (e) {
        console.warn("[mqtt] onConnect:", e.message);
      }
    }
  });
  client.on("message", (topic, buf) => {
    const cm = /^tvbox\/([^/]+)\/canary$/.exec(topic);
    if (cm) return noteVouch(cm[1], buf);
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
    publishCanary,
    forget,
    canaryVouches: () => new Map(vouches),
    deviceId: () => deviceId,
    connected: () => !!(client && client.connected),
  };
}

function followedCanary() {
  try {
    return canary.settings((require("./config").rawUpdate() || {}).canary).from;
  } catch (e) {
    return "";
  }
}

// One box's canary topic. An empty payload is a cleared topic, i.e. no vouch.
function noteVouch(id, buf) {
  if (id === deviceId) return;
  let p;
  try {
    const text = buf.toString();
    p = text ? JSON.parse(text) : null;
  } catch (e) {
    p = null;
  }
  const v = canary.parseVouch(p);
  if (!v) return void vouches.delete(id);
  // The box a follower follows always gets its slot, so topics from other ids
  // cannot crowd it out.
  if (!vouches.has(id) && vouches.size >= MAX_VOUCHES && id !== followedCanary()) return;
  vouches.set(id, v);
}

// This box's own canary topic: the report, or cleared when there is none.
function publishCanary(report) {
  if (!client) return;
  try {
    client.publish(base + "/canary", report ? JSON.stringify(report) : "", { retain: true });
  } catch (e) {}
}

// Take this box off the broker: clear every retained topic it owns, so Home
// Assistant drops its MQTT-discovered device, then disconnect cleanly. A clean
// DISCONNECT is what keeps the will from republishing "offline" afterwards, and
// stop() is not used because it publishes that itself.
function forget(cb) {
  const done = typeof cb === "function" ? cb : () => {};
  if (!client || !client.connected) return done(new Error("not connected"));
  const c = client;
  for (const t of retainedTopicsOf(deviceId)) {
    try {
      c.publish(t, "", { retain: true, qos: 1 });
    } catch (e) {}
  }
  client = null;
  vouches.clear();
  irPublished = [];
  // end(false) waits for the QoS 1 clears above to be acknowledged; a broker
  // that stops answering meanwhile is cut off rather than waited on.
  let finished = false;
  const finish = (e) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(e);
  };
  const timer = setTimeout(() => {
    try {
      c.end(true);
    } catch (e) {}
    finish(new Error("broker did not confirm"));
  }, FORGET_TIMEOUT_MS);
  c.end(false, {}, () => finish(null));
}
const FORGET_TIMEOUT_MS = 8000;

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

// Actions this box once published and no longer has. The delete sweep below iterates
// the CURRENT vocabulary, so an action removed from it in a release would leave its
// retained discovery config on the broker forever - available in Home Assistant,
// pressing into `unknown command`. Removing an action means adding it here.
const IR_RETIRED_ACTIONS = ["input_next"];

// Sensors read off the retained diag topic (diag.js + health.js). Few on purpose:
// the whole document is one subscribe away for anything that wants more.
const DIAG_SENSORS = [
  {
    key: "health",
    name: "Health",
    value: "{{ value_json.health.status | default('unknown') }}",
    icon: "mdi:heart-pulse",
    attributes: "{{ (value_json.health | default({})) | tojson }}",
  },
];
// The version and the CPU temperature were published here once, but the Home
// Assistant integration already makes those entities from the same diag topic, so
// they came out twice. Their retained configs are cleared on connect.
const RETIRED_DIAG_SENSORS = ["version", "cpu_temp"];
function diagSensorTopic(sid, key) {
  return "homeassistant/sensor/tvbox_" + sid + "/" + key + "/config";
}

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
  for (const gone of [...Object.keys(IR_BUTTON_NAMES), ...IR_RETIRED_ACTIONS]) {
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
  for (const key of RETIRED_DIAG_SENSORS) {
    try {
      client.publish(diagSensorTopic(sid, key), "", { retain: true });
    } catch (e) {}
  }
  for (const d of DIAG_SENSORS) {
    const cfg = {
      name: d.name,
      unique_id: "tvbox_" + sid + "_" + d.key,
      state_topic: base + "/diag",
      value_template: d.value,
      availability_topic: base + "/status",
      entity_category: "diagnostic",
      icon: d.icon,
      device: payload.device,
      ...(d.attributes ? { json_attributes_topic: base + "/diag", json_attributes_template: d.attributes } : {}),
      ...(d.extra || {}),
    };
    try {
      client.publish(diagSensorTopic(sid, d.key), JSON.stringify(cfg), { retain: true });
    } catch (e) {}
  }
  publishIrButtons(irActions === undefined ? irPublished : irActions, sid, payload.device);
}

// The retained topics a box id owns, all of them, so a rename can take them away.
function retainedTopicsOf(id) {
  const b = "tvbox/" + id;
  const sid = safeId(id);
  return [
    ...["announce", "state", "nowplaying", "diag", "status", "canary"].map((t) => b + "/" + t),
    "homeassistant/sensor/tvbox_" + sid + "/nowplaying/config",
    ...[...DIAG_SENSORS.map((d) => d.key), ...RETIRED_DIAG_SENSORS].map((k) => diagSensorTopic(sid, k)),
    ...[...Object.keys(IR_BUTTON_NAMES), ...IR_RETIRED_ACTIONS].map((a) => irButtonTopic(sid, a)),
  ];
}

function forgetPreviousId(file) {
  let prev = "";
  try {
    prev = fs.readFileSync(file, "utf8").trim();
  } catch (e) {}
  if (prev && prev !== deviceId && safeId(prev) === prev) {
    console.log("[mqtt] device id changed from", prev, "- clearing its retained topics");
    for (const t of retainedTopicsOf(prev)) {
      try {
        client.publish(t, "", { retain: true });
      } catch (e) {}
    }
  }
  if (prev === deviceId) return;
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, deviceId + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn("[mqtt] could not record the device id:", e.message);
  }
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
  if (st.clearVouches) vouches.clear();
}

module.exports = {
  init,
  stop,
  _test: {
    IR_BUTTON_NAMES,
    IR_RETIRED_ACTIONS,
    irButtonTopic,
    publishDiscovery,
    setStateForTest,
    retainedTopicsOf,
    forgetPreviousId,
    noteVouch,
    forget,
    publishCanary,
    vouches: () => vouches,
    DIAG_SENSORS,
    published: () => irPublished,
  },
};
