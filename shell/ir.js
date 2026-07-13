// tvbox IR hub - forwards abstract TV commands (volume_up / volume_down / mute)
// to a network IR blaster, for TVs whose volume can't be driven over CEC. Fed
// from two places: the BT/USB remote's volume keys (remote_input_bridge.py
// POSTs /tvbox/api/ir/send) and MQTT commands (main.js handleTvCommand, e.g. a
// voice assistant). Backends are pluggable behind one send(action) surface:
//
//   esphome       - an ESPHome IR transceiver over the native API (tested with
//                   the Seeed XIAO Smart IR Mate, whose stock firmware replays
//                   a learned signal as "set the signal select" + "press the
//                   send button"). Plaintext and noise-encrypted API both work.
//   homeassistant - HA REST: each action runs an HA script. Covers ANY IR
//                   device HA can drive (Broadlink RM4, SmartIR, Tuya...)
//                   without tvbox speaking the vendor protocol itself.
//
// A new vendor (e.g. Broadlink without HA) = one more make*Backend() returning
// { name, send(value), connected(), close() } - nothing else changes.
const config = require("./config");
const netguard = require("./netguard");

const MAX_STEPS = 10; // cap on "volume up by N" repeats (MQTT can ask for them)
const STEP_GAP_MS = 250; // pause between repeated sends - IR receivers need a beat
const SELECT_SETTLE_MS = 150; // esphome: let the select apply on-device before "send"
const READY_TIMEOUT_MS = 6000; // give a (re)connecting esphome client this long to surface entities

let backend = null; // { name, send(value), connected(), close() } - null until configured
let actions = {}; // action name -> backend-specific value (signal option / HA script)
let lastError = "";
// Sends are strictly serialized: two interleaved esphome select+send pairs
// would replay the wrong signal. Failures must not break the chain.
let queue = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function errMsg(e) {
  return String((e && e.message) || e || "unknown error");
}

// ---- esphome backend (native API, persistent auto-reconnecting connection) ----
function makeEsphomeBackend(cfg) {
  // Lazy require: protobuf + noise wasm only load when an ESPHome blaster is
  // actually configured.
  const { Client } = require("@2colors/esphome-native-api");
  const ent = { select: null, button: null }; // re-captured after every reconnect (clearSession)
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    ...(cfg.encryptionKey ? { encryptionKey: cfg.encryptionKey } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
    clearSession: true,
    initializeDeviceInfo: false,
    initializeListEntities: true,
    initializeSubscribeStates: false, // we only command; no state stream needed
    reconnect: true, // lib-managed: 30s retry + 15s ping keepalive
  });
  client.on("newEntity", (e) => {
    if (e.type === "Select" && e.config.objectId === cfg.select) ent.select = e;
    if (e.type === "Button" && e.config.objectId === cfg.button) ent.button = e;
  });
  client.on("initialized", () => {
    lastError = "";
    if (!ent.select || !ent.button)
      lastError = `entities not found on device (select=${cfg.select}, button=${cfg.button})`;
  });
  // An unhandled 'error' event would take the whole shell down - always absorb.
  client.on("error", (e) => {
    lastError = errMsg(e);
  });
  try {
    client.connect();
  } catch (e) {
    lastError = errMsg(e);
  }
  const ready = () => !!(client.initialized && ent.select && ent.button);
  return {
    name: "esphome",
    connected: ready,
    async send(value) {
      const t0 = Date.now();
      while (!ready()) {
        if (Date.now() - t0 > READY_TIMEOUT_MS) throw new Error("IR blaster unreachable: " + (lastError || cfg.host));
        await sleep(100);
      }
      ent.select.command({ state: value }); // pick the learned signal slot...
      await sleep(SELECT_SETTLE_MS);
      ent.button.command(); // ...and replay it
    },
    close() {
      try {
        client.disconnect();
      } catch (e) {
        /* already down */
      }
    },
  };
}

// ---- Home Assistant backend (stateless REST, one script per action) ----
function haScriptCall(base, token, entityId) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL("/api/services/script/turn_on", base);
    } catch (e) {
      return reject(new Error("invalid Home Assistant URL"));
    }
    // https anywhere (e.g. Nabu Casa); plain http must stay on the owner's LAN -
    // the bearer token must never cross the internet in cleartext.
    if (u.protocol !== "https:" && !netguard.isLanUrl(u.href)) {
      return reject(new Error("plain http is only allowed toward LAN hosts"));
    }
    const mod = u.protocol === "https:" ? require("https") : require("http");
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error("Home Assistant answered HTTP " + res.statusCode));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Home Assistant timed out")));
    req.on("error", reject);
    req.end(JSON.stringify({ entity_id: entityId }));
  });
}

function makeHaBackend(cfg) {
  return {
    name: "homeassistant",
    connected: () => null, // stateless - nothing persistent to report
    send: (value) => haScriptCall(cfg.url, cfg.token, value),
    close() {},
  };
}

// ---- hub ----
// (Re)build the backend from config. Called at boot and on every config save.
function applyConfig() {
  if (backend) {
    try {
      backend.close();
    } catch (e) {
      /* best effort */
    }
  }
  backend = null;
  actions = {};
  lastError = "";
  const raw = config.rawIr(); // null unless the selected backend is fully configured
  if (!raw) return;
  try {
    if (raw.backend === "homeassistant") {
      backend = makeHaBackend(raw.homeassistant);
      actions = raw.homeassistant.actions;
    } else {
      backend = makeEsphomeBackend(raw.esphome);
      actions = raw.esphome.actions;
    }
  } catch (e) {
    lastError = errMsg(e);
    backend = null;
    actions = {};
  }
}

function clampSteps(steps) {
  const n = Math.floor(Number(steps));
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_STEPS, n)) : 1;
}

// Send an abstract action ("volume_up"), optionally repeated. Resolves with
// { ok, action, steps }; rejects with a user-presentable error.
function send(action, steps) {
  const b = backend; // pin: applyConfig() may swap the backend while queued
  if (!b) return Promise.reject(new Error("no IR blaster configured"));
  const key = String(action || "");
  // own-property only: a plain-object lookup would let "__proto__"/"constructor"
  // etc. slip past the whitelist as truthy inherited members
  const value = Object.prototype.hasOwnProperty.call(actions, key) ? actions[key] : undefined;
  if (!value) return Promise.reject(new Error("unknown IR action: " + action));
  const n = clampSteps(steps);
  const job = queue.then(async () => {
    for (let i = 0; i < n; i++) {
      if (i) await sleep(STEP_GAP_MS);
      await b.send(value);
    }
    return { ok: true, action, steps: n };
  });
  queue = job.then(
    () => {},
    () => {},
  );
  return job.catch((e) => {
    lastError = errMsg(e);
    throw e;
  });
}

// For the launcher settings card and /tvbox/api/ir/status.
function status() {
  return {
    configured: !!backend,
    backend: backend ? backend.name : null,
    connected: backend ? backend.connected() : false,
    actions: Object.keys(actions),
    lastError,
  };
}

function setBackendForTest(b, a) {
  backend = b;
  actions = a || {};
}

module.exports = { applyConfig, send, status, _test: { clampSteps, haScriptCall, setBackendForTest } };
