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
//   firetv        - the Fire TV remote's own IR LED, over the BLE keymap service
//                   (firetvir.js). Needs no hardware beyond the remote already
//                   paired to the box, and can send codes for buttons the remote
//                   does not have - a TV input among them.
//
// A new vendor (e.g. Broadlink without HA) = one more make*Backend() returning
// { name, send(value), connected(), close() } - nothing else changes.
const config = require("./config");
const netguard = require("./netguard");

const MAX_STEPS = 10; // cap on "volume up by N" repeats (MQTT can ask for them)
// Steps are sequential sends, and on the `firetv` backend each one goes over BLE at
// ~0.9 s plus the gap below - so a ten-step ramp there is about eleven seconds and holds
// the queue. That is the hardware's pace, not a bug; a box that ramps volume often
// should let the remote's own programmed keys do it
// (config.remote.devices[<mac>].irPassthrough).
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

// ---- Fire TV remote backend (the remote's own IR LED, over its BLE keymap) ----
// The remote, not the box, carries the LED - so an "InstantFire" blast hands it a code
// and it fires. Unlike the other two backends there is no appliance here, but the link
// is held the same way theirs are: one resident process keeps the BLE connection, since
// a blast over an open link is ~0.9 s while a fresh connect per blast is seconds and
// fails outright shortly after the previous process disconnected. The remote still
// sleeps between presses, so a link that is gone needs a button press to come back.
//
// The interesting property is that a blast is bound to no BUTTON. Programming the
// remote's keymap can only reach the four keys the remote physically has, while this can
// send any code in the saved plan - which is the only way to select a TV input, a
// command CEC has no equivalent of.
// The service answers with a code NAME per failure; the per-blast tool answers with an
// exit code, which cannot tell as much apart. These sentences are shown on the TV and
// read out by a voice assistant, so each one has to be true of what actually happened
// and has to offer the press ONLY where a press is the fix:
//
//   asleep    nothing was sent - the remote could not be reached at all. A press fixes
//             it, and this is the normal state between presses.
//   notfired  the remote was reached and took the code, and its own status never said
//             it fired. Pressing buttons will not help; aim and batteries might.
//   linklost  the link went during the send, so the code MAY have gone out. Never
//             invite a retry here - a repeated power toggle undoes itself.
//   badspec   the request was not a shape the box builds. A bug on our side, not the
//             remote's, and saying "press a button" would send someone chasing it.
const FIRETV_SEND_ERRORS = {
  nokeymap: "this remote has no IR keymap service",
  badcode: "this code cannot be sent by this remote - pick another codeset",
  badspec: "the box built an IR command this remote cannot accept - please report it",
  asleep: "the remote did not answer - press a button on it to wake it, then retry",
  notfired: "the remote took the code but did not fire it - check the batteries and aim it at the device",
  linklost: "the link to the remote dropped while sending - check whether it worked before trying again",
  busy: "the remote is busy with another IR command - try again in a moment",
};

function makeFiretvBackend(cfg, mod) {
  // Lazy, like the esphome client: firetvir pulls in the index reader and the EDID
  // probe, and a box on another backend should pay for neither. Injectable so the
  // failure mapping below can be tested without a remote in the room.
  const firetvir = mod || require("./firetvir");
  // One resident process holds the BLE link, the way this backend's esphome sibling
  // holds one connection to its device. Measured on a Remote Pro: ~0.9 s per blast over
  // a held link and 20 of them over 20 minutes, against a fresh connect per blast and a
  // remote that is unreachable after that process disconnects - which is what made the
  // second of two blasts fail.
  firetvir.startService(cfg.mac);
  return {
    name: "firetv",
    mac: cfg.mac, // read by applyConfig to tell a no-op save from a real change
    // What the resident link last reported. `null` means nobody has asked yet or there
    // is no service - not "down", which would show a working remote as broken.
    connected: () => firetvir.serviceLinkState(),
    send: (value) =>
      new Promise((resolve, reject) => {
        // The per-blast process, which is what this backend did before the service and
        // is still the path on a box where the service cannot run.
        const oneShot = () =>
          firetvir.blastAction(cfg.mac, value, (err, r) => {
            if (err) return reject(err);
            if (r && r.ok) return resolve();
            // The three ways this fails are worth telling apart: a remote that cannot do
            // it at all, one that is merely asleep, and anything else (which gets to
            // speak for itself). A press wakes the remote, so the middle one is the
            // failure a person can actually fix from the sofa.
            if (r && r.code === 3) return reject(new Error(FIRETV_SEND_ERRORS.nokeymap));
            if (r && r.code === 4) return reject(new Error(FIRETV_SEND_ERRORS.badcode));
            if (r && r.code === 5) return reject(new Error(FIRETV_SEND_ERRORS.asleep));
            // A kill leaves no exit code at all, and it is the one failure where the
            // budget itself is the news: saying "no output" sends someone looking for a
            // crash that did not happen.
            if (r && r.code === null) return reject(new Error("the remote did not answer in time"));
            // Exit 1 is "the remote took the code and its status never said it fired",
            // which a press does not fix - a remote it could not reach at all exits 5.
            if (r && r.code === 1) return reject(new Error(FIRETV_SEND_ERRORS.notfired));
            reject(new Error("blast failed: " + ((r && r.output) || "no output")));
          });
        firetvir.blastViaService(cfg.mac, value, (err, resp) => {
          // A service that is not RUNNING is not a failed blast, so fall back. A service
          // that ran and did not answer is a different thing: retrying through a second
          // process would spend another budget on a remote that has already had one, and
          // the queue behind it waits for both.
          if (err) return err.absent ? oneShot() : reject(err);
          if (resp && resp.ok) return resolve();
          const known = resp && FIRETV_SEND_ERRORS[resp.code];
          reject(new Error(known || (resp && resp.error) || "blast failed"));
        });
      }),
    close() {
      firetvir.stopService();
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
// Everything the hub holds, on the way out. Without this the firetv backend's resident
// process outlives the shell, keeps the remote's ONE allowed BLE connection, and the
// next shell's service can never get it - every blast then answers "asleep" and no
// amount of pressing buttons helps. The supervisor reaps such an orphan on the next
// start, but only after it has already broken the first attempt.
function shutdown() {
  if (!backend) return;
  try {
    backend.close();
  } catch (e) {
    /* best effort - we are quitting */
  }
  backend = null;
}

function applyConfig() {
  const raw0 = config.rawIr();
  // Saving the IR page unchanged used to close the backend and rebuild it, which on the
  // firetv backend means killing the resident process - and about two seconds later the
  // remote is unreachable until somebody presses a button on it. So a save that changes
  // nothing about the link leaves it alone.
  if (backend && backend.name === "firetv" && raw0 && raw0.backend === "firetv" && backend.mac === raw0.firetv.mac) {
    actions = raw0.firetv.actions;
    lastError = "";
    return;
  }
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
    } else if (raw.backend === "firetv") {
      backend = makeFiretvBackend(raw.firetv);
      actions = raw.firetv.actions;
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
    // A send that worked retires the last failure. Without this the settings page shows
    // "the blaster is not reachable" from an earlier attempt for as long as the config
    // is not saved again - directly above the green "Sent." of the retry that worked.
    lastError = "";
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
// One classifier for what a failed send MEANS, used by the on-screen toast and by the
// settings page. It lives here rather than in tvcommand.js because the page reads its
// answer out of /tvbox/api/ir/status: a second copy would drift, and the page would show
// the raw English sentence next to a translated one.
const IR_CAUSES = [
  [/no IR blaster configured/, "noBlaster"],
  [/unknown IR action/, "unmapped"],
  [/no IR keymap service/, "noService"],
  [/cannot be sent by this remote/, "badCode"],
  [/the box built an IR command/, "badSpec"],
  [/busy with another IR command|still in flight/, "busy"],
  [/dropped while sending/, "linkLost"],
  [/took the code but did not fire/, "notFired"],
  [/did not answer in time/, "timeout"],
  // Last, because it is the broadest: several sentences end with the wake advice.
  [/press a button on it to wake it/, "asleep"],
];

function causeOf(message) {
  const m = String(message || "");
  for (const [re, cause] of IR_CAUSES) if (re.test(m)) return cause;
  return "other";
}

function status() {
  return {
    configured: !!backend,
    backend: backend ? backend.name : null,
    // Three-valued for the firetv backend: true/false once its resident link service
    // has answered, null while nothing is known. A screen must not turn null into
    // "unreachable" - a remote one button press away is not a broken blaster.
    connected: backend ? backend.connected() : false,
    actions: Object.keys(actions),
    lastError,
    // What the last failure MEANS, so a screen can say it in the viewer's language
    // instead of showing the English sentence a voice assistant reads out.
    cause: lastError ? causeOf(lastError) : null,
  };
}

function setBackendForTest(b, a) {
  backend = b;
  actions = a || {};
}

module.exports = {
  applyConfig,
  send,
  status,
  shutdown,
  causeOf,
  _test: { clampSteps, haScriptCall, setBackendForTest, makeFiretvBackend },
};
