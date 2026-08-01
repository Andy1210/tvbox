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
//  - announces availability via a retained LWT on  tvbox/<deviceId>/status,
//  - subscribes  tvbox/<deviceId>/cmd    (control: launch app / transport / TV power)
//        and     tvbox/<deviceId>/notify (on-screen notifications).
// The mqtt npm client auto-reconnects. Secrets come from config.rawMqtt().
const mqtt = require("mqtt");
const identity = require("./identity"); // what makes this box THIS box (derived device id)

let client = null;
let base = "";
let deviceId = "";

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

// HA MQTT discovery: a now-playing sensor whose state is the title and whose
// attributes carry artist/app/image, available-gated on the LWT status topic.
function publishDiscovery() {
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
}

function stop() {
  if (!client) return;
  try {
    client.publish(base + "/status", "offline", { retain: true });
    client.end(true);
  } catch (e) {}
  client = null;
}

module.exports = { init, stop };
