// The box as ONE media player, on the wire.
//
// Everything outside the box that wants to know "what is this TV doing" asks one
// question, so there is one answer: a retained `state` topic composed from mpv,
// the foreground app's now-playing report and the audio sink (mediastate.js owns
// the merge rules). The nowplaying topic keeps its old shape beside it - the voice
// assistant reads that one - so nothing that already works has to change.
//
// This module owns the publishing: what is composed, when it is worth sending, the
// broker's lifecycle, and the two slow ticks. The merge rules are mediastate.js's
// and the wiring around a window is main.js's.

// Every command the box answers, in one list, because it is also what the box
// ADVERTISES: Home Assistant turns it into the entity's supported_features, so an
// older box never shows a button that does nothing.
const TV_COMMANDS = [
  "launch",
  "home",
  "play",
  "pause",
  "stop",
  "next",
  "previous",
  "shuffle",
  "repeat",
  "lyrics",
  "seek",
  "volume_set",
  "volume_mute",
  "volume_up",
  "volume_down",
  "mute",
  "tv_on",
  "tv_off",
  "find_remote",
  "find_remote_stop",
];

// Which app is in front changes through half a dozen paths (launch, resume,
// native app, HOME, the typing screen), so the state topic is re-composed on a
// slow tick instead of at every one of them: composing is pure and in-memory, and
// worthPublishing drops the result when nothing moved. Media events themselves
// don't wait for this - they publish immediately.
const MEDIA_TICK_MS = 5000;
const SINK_TICK_MS = 20000; // wpctl is a process spawn; the volume is not urgent
// Nothing in the fleet payload changes by the second (a version, a link rate, a
// temperature), and it costs three spawns, so it is published slowly. The topic is
// retained, so a subscriber never waits for the next one.
const DIAG_TICK_MS = 5 * 60 * 1000;
// mpv reports a position every second and an app can push now-playing in bursts, so
// publishes are batched to the next tick and then filtered by worthPublishing.
const COALESCE_MS = 200;

let deps = {
  mqtt: null, // ./mqtt
  mediastate: null,
  audio: null,
  diag: null,
  identity: null,
  config: null,
  system: null,
  updater: null,
  player: null,
  version: "",
  childEnv: () => ({ ...process.env }),
  // The state this module reads but does not own.
  nowPlaying: () => null,
  currentApp: () => null,
  sources: () => [],
  // Re-decide the HOME card on the way past (see publish).
  soundWidget: () => {},
  onNotify: () => {},
  onCommand: () => {},
  // Which IR actions the blaster has mapped (ir.js status). Home Assistant gets a
  // button per action, so this list decides which buttons exist.
  irActions: () => [],
};

function init(d) {
  deps = { ...deps, ...d };
}

let ctl = null; // the bridge control once connected; null if not configured
let sinkState = { volume: null, muted: false };
let lastMediaState = null;
let publishTimer = null;
let publishForced = false;

const control = () => ctl;

// Publish on the now-playing topic, which keeps its old shape beside `state`.
function publishNowPlaying(data) {
  if (ctl) ctl.publish("nowplaying", data, { retain: true });
}

/**
 * Coalesced publish of the composed state.
 *
 * The HOME card is re-decided on the way past. This is called on every player
 * event, which is what the card needs and the app's own reports do not provide:
 * an app reports itself playing the instant it asks for a track, i.e. BEFORE mpv
 * exists, so that first report cannot raise a card and the next one is ten
 * seconds later - a card that takes ten seconds to appear after a cast.
 */
function publish(opts) {
  deps.soundWidget(deps.nowPlaying());
  if (!ctl) return;
  // A forced call that lands inside an already-queued window must not lose its
  // force: re-seeding a fresh broker (applyConfig) is exactly a forced publish,
  // and lastMediaState still holds the previous broker's value, so being folded into
  // a filtered publish would leave the new broker with no retained state at all.
  if (opts && opts.force) publishForced = true;
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    const forced = publishForced;
    publishForced = false;
    if (!ctl) return;
    const next = deps.mediastate.compose({
      nowPlaying: deps.nowPlaying(),
      mpv: deps.player.media,
      volume: sinkState.volume,
      muted: sinkState.muted,
      currentApp: deps.currentApp(),
      sources: deps.sources(),
    });
    if (!forced && !deps.mediastate.worthPublishing(lastMediaState, next)) return;
    lastMediaState = next;
    ctl.publish("state", next, { retain: true });
  }, COALESCE_MS);
}

// The box's OWN output volume, set from outside (MQTT / Home Assistant). Targets
// the DEFAULT sink, because that is what "the box's volume" means; the caller
// never has to know a wireplumber node id. `volume` is 0..1.
function setBoxVolume(action, cmd) {
  const env = deps.childEnv();
  deps.audio.defaultSink(env, (sink) => {
    if (!sink) return console.warn("[mqtt]", action, "- no audio sink");
    const done = (ok) => {
      if (!ok) console.warn("[mqtt]", action, "failed on sink", sink.id);
      refreshSinkState(); // report what it actually became, not what was asked for
    };
    if (action === "volume_set") deps.audio.setVolume(env, sink.id, Number(cmd && cmd.volume), done);
    else deps.audio.setMuted(env, sink.id, cmd && cmd.mute !== undefined ? !!cmd.mute : "toggle", done);
  });
}

// The sink's volume/mute, refreshed on a timer rather than per publish: wpctl is a
// process spawn, and nothing else on the box changes the volume between ticks
// without going through us.
function refreshSinkState() {
  // Only while something is listening. listSinks is `wpctl status` plus two more
  // spawns per sink, and a box that never touches Home Assistant has no reason to
  // pay three processes a minute forever - least of all during a film or a game.
  if (!ctl) return;
  deps.audio.defaultSink(deps.childEnv(), (sink) => {
    const next = {
      volume: sink && typeof sink.volume === "number" ? sink.volume : null,
      muted: !!(sink && sink.muted),
    };
    if (next.volume === sinkState.volume && next.muted === sinkState.muted) return;
    sinkState = next;
    publish();
  });
}

// What this box looks like to whoever is watching all of them (docs/fleet-view.md).
// Retained, so a dashboard that subscribes tomorrow still sees last night's
// rollback; and only while MQTT is configured, for the same reason refreshSinkState
// is gated - it spawns nmcli and gdbus, which a box nobody watches should not pay.
function publishDiag() {
  if (!ctl) return;
  // Guarded on both sides of the asynchronous hop: this catch only ever sees a
  // synchronous failure, because collect answers through execFile callbacks, and an
  // exception raised there would reach the Electron main process rather than here.
  try {
    deps.diag.collect({ system: deps.system, updater: deps.updater }, (payload) => {
      try {
        if (ctl) ctl.publish("diag", payload, { retain: true });
      } catch (e) {
        console.warn("[diag] publish:", e.message);
      }
    });
  } catch (e) {
    console.warn("[diag] collect:", e.message);
  }
}

// (Re)start the MQTT bridge from the saved config. mqtt.js stop() publishes a
// best-effort retained "offline" and force-ends the module-level client, so
// calling it before init is safe (and a no-op when not started). rawMqtt() is
// null unless host AND username are set - a cleared config turns the bridge off.
function applyConfig() {
  deps.mqtt.stop();
  ctl = null;
  const mcfg = deps.config.rawMqtt();
  if (mcfg) ctl = deps.mqtt.init(mcfg, { onNotify: deps.onNotify, onCommand: deps.onCommand });
  if (ctl) {
    ctl.announce({
      name: deps.identity.hostname(),
      hostname: deps.identity.hostname(),
      version: deps.version || "",
      // The command vocabulary the box answers. Home Assistant turns it into the
      // entity's supported_features, so a box on an older release doesn't advertise
      // a button that does nothing.
      commands: TV_COMMANDS,
    });
    // Read the volume now rather than waiting out the 20 s tick: MQTT may have been
    // configured minutes after boot, and a media_player whose slider starts blank
    // reads as broken.
    refreshSinkState();
    publish({ force: true });
    publishDiag(); // the fleet payload, now rather than at the first tick
    publishIrDiscovery();
  }
  // re-seed retained now-playing on the (possibly new) broker; the mqtt client
  // queues QoS-0 publishes made before "connect", so this is safe immediately
  const np = deps.nowPlaying();
  if (ctl && np) ctl.publish("nowplaying", np, { retain: true });
}

// Restate the HA button entities from what the blaster currently has mapped. Called
// when the bridge (re)connects and after an IR config save - the set is retained on the
// broker, so a button whose action was removed has to be actively deleted, which
// mqtt.js does by diffing against what it published last.
function publishIrDiscovery() {
  if (!ctl) return;
  let actions;
  try {
    actions = deps.irActions() || [];
  } catch (e) {
    // A blaster that cannot report is not a reason to drop the buttons that exist: an
    // empty list would delete every one of them.
    console.warn("[mqtt] ir actions unavailable:", (e && e.message) || e);
    return;
  }
  ctl.publishDiscovery(actions);
}

// The slow ticks. Started once, from the shell's bootstrap.
function startTicks() {
  setInterval(() => publish(), MEDIA_TICK_MS);
  refreshSinkState();
  setInterval(refreshSinkState, SINK_TICK_MS);
  setInterval(publishDiag, DIAG_TICK_MS);
}

module.exports = {
  init,
  publish,
  publishNowPlaying,
  publishDiag,
  setBoxVolume,
  refreshSinkState,
  applyConfig,
  publishIrDiscovery,
  startTicks,
  control,
  TV_COMMANDS,
  MEDIA_TICK_MS,
  SINK_TICK_MS,
  DIAG_TICK_MS,
  COALESCE_MS,
};
