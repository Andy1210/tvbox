// A control command arrived from outside the box - the assistant's tv_control tool
// (voice), a Home Assistant automation, a phone. Shell-native actions are answered
// here; media transport is also FORWARDED, because what shuffle, repeat and the
// lyrics mean belongs to the app holding the queue.
//
// Its own module because routing a command is a set of rules rather than wiring:
// which windows hear it, which app the shell believes is making the sound, and the
// order a play_media does its two things in. Everything Electron is injected.
let deps = {
  player: null,
  ir: null,
  remotefinder: null,
  mediastate: null,
  apps: null, // ./install - manifestById
  launchurl: null, // ./launchurl - playQuery + hasUsableLaunch
  // The shell's own state and windows.
  nowPlaying: () => null,
  currentApp: () => null,
  appWindow: () => null, // (id) -> BrowserWindow | null
  launcherWebContents: () => null,
  // Denies: `showLyrics` reads this as "the screen is free", so an unwired module
  // must not answer that a native app is absent.
  nativeRunning: () => true,
  navTo: () => false,
  showLauncher: () => {},
  cecPower: () => {},
  setVideoMode: () => {},
  setBoxVolume: () => {},
};

function init(d) {
  deps = { ...deps, ...d };
}

// Which app is making the sound, or "" when nothing is. The rule itself lives in
// mediastate.js, where it is unit-tested next to the state machine that already
// asks the same question of the same field.
function soundingApp() {
  return deps.mediastate.soundingApp(deps.nowPlaying());
}

/**
 * Hand a transport command to every window that could act on it.
 *
 * The active app runs in its own window - it gets the transport too (remote and
 * sandboxed windows deliberately have no tv-command listener). So does the app
 * making the SOUND, which is often not the one on screen: music deliberately
 * survives a return to the launcher (`soundOutlivesTheScreen`), and showLauncher
 * nulls the foreground app. So the commonest "pause the music" there is - asked
 * minutes after the screen moved on - reached the launcher and nothing else, and
 * the app that was playing never heard it.
 *
 * `nowPlaying.app` is the app's own claim. Two bounds on trusting it, both
 * because it is a claim: the same two states the sound card requires
 * (`playing`/`paused` - a payload with no state at all used to qualify), and a
 * LIVE window, so the target is an app that is running here and now. A wrong
 * claim can then at most send a pause to a local app that is not playing.
 *
 * Every target is told WHICH app the shell believes is sounding, because the
 * command goes to more than one window: with a queue paused in the media client
 * and Spotify playing, a spoken "next song" reached both and skipped Spotify
 * while starting house music over it. Only the shell knows; an app cannot see
 * past its own state. Empty means the shell does not know either, and then an
 * app falls back to judging for itself.
 */
function forwardCommand(cmd) {
  const targets = new Set();
  const launcher = deps.launcherWebContents();
  if (launcher) targets.add(launcher);
  const current = deps.currentApp();
  const fg = current && deps.appWindow(current);
  if (fg) targets.add(fg.webContents);
  // Liveness-checked, and the VALUE is checked too, not just the target: an app
  // whose window is gone can still be named by the claim (nothing else clears
  // it), and broadcasting that id makes every live app stand down while the
  // assistant reports the publish.
  const claimed = soundingApp();
  const sounding = claimed && (claimed === current || deps.appWindow(claimed)) ? claimed : "";
  const owner = sounding && sounding !== current ? deps.appWindow(sounding) : null;
  if (owner) targets.add(owner.webContents);
  const payload = { ...(cmd || {}), sounding };
  for (const wc of targets) {
    try {
      wc.send("tv-command", payload);
    } catch (e) {}
  }
  return sounding;
}

/**
 * The lyrics are the one forwarded command that needs a SCREEN, so the app
 * holding the words may have to be brought forward first - it is usually playing
 * in the background, where it can show nothing at all.
 *
 * The screen is only taken when it is FREE: the launcher, or the app itself.
 * Something else on screen is something somebody is watching, and navTo ends a
 * running native app outright (it takes the box's one video plane), so the lyrics
 * are never worth that. The command is forwarded either way: the app sets its own
 * state and has them up when its screen does come back.
 */
function showLyrics(cmd) {
  const state = String((cmd && cmd.state) || "").toLowerCase();
  const sounding = soundingApp();
  const current = deps.currentApp();
  const target = sounding || current || "";
  // A RUNNING app only: navTo would otherwise launch one, and an app that is not
  // running is not the one playing the song whose words were asked for. It is
  // also what keeps a stale claim from opening an app nobody has used since the
  // last boot.
  const running = target ? deps.appWindow(target) : null;
  const screenFree = !deps.nativeRunning() && (!current || current === target);
  // Hiding them needs no screen, so "off" never navigates.
  if (running && state !== "off" && screenFree && current !== target) deps.navTo(target);
  // Nothing is playing and no app is up, so the only window this reaches is the
  // launcher, which has no transport listener: the request cannot land anywhere.
  // Said out loud rather than dropped in silence, because the assistant will have
  // reported the publish and this log is the only place the difference shows.
  else if (!running) console.warn("[mqtt] lyrics: nothing is playing here, nobody to show them");
  forwardCommand(cmd);
}

/**
 * A play_media is a CLAIM on the room's audio, so whatever else is playing stops.
 *
 * `soundOutlivesTheScreen` deliberately keeps audio-only playback through a
 * screen change, which is right for pressing Home and wrong for this: measured
 * on the box, a song asked for by voice that fell through to Spotify started
 * over the media client's album and both played at once. This is the other half
 * of that rule as it is already written - what ends music is something else
 * claiming the player - said out loud for the one caller that means it.
 *
 * Not when the app being asked is the one already playing: it is about to be
 * handed a new song and stopping first would only add a gap.
 */
function silenceForPlayMedia(id) {
  const player = deps.player;
  if (!player.running() || player.owner() === id) return;
  player.setPlaying(null);
  player.stop();
  deps.setVideoMode(false);
  // With a reason, so the app that owned it does not read the end of its file as
  // "the track finished" and start the next one over what is about to play.
  player.emit({ type: "finished", reason: "stopped" });
}

/**
 * Open an app and hand it something to play.
 *
 * Two shapes, because the two kinds of app can be reached in two different ways:
 *
 * - A LOCAL app is ours and has the SDK, so it gets the request as an ordinary
 *   `tv-command` and answers it with its own code. It is delivered after the
 *   page has loaded, and the preload holds it until the page registers a
 *   listener - a window that was opened BY this command is still booting, and a
 *   send into a page that is not there yet is a command that never happened.
 * - A REMOTE app is a site we cannot script, so all there is to give it is its
 *   own url with the launch data on it - the same path, and the same bounds, a
 *   cast from a phone goes through (`withLaunchQuery`, at most a few short
 *   parameters).
 *
 * Nothing here decides WHAT to play. The caller names an app that is installed
 * and ready, or nothing happens: an id that is not one must not silently take
 * the television somewhere else.
 */
function playMediaIn(cmd) {
  const { playQuery, hasUsableLaunch } = deps.launchurl;
  // Through the same cleaner as the words: an app id that is not one still
  // reaches the log, and a newline in it forges a line in a file people read
  // and `tvbox-diag.sh` quotes.
  const id = playQuery(cmd && cmd.app).slice(0, 64);
  const m = id && deps.apps.manifestById(id);
  if (!m || m.status !== "ready") return console.warn("[mqtt] play_media: no such app:", id);
  const rt = m.runtime || {};
  if (rt.serve === "remote") {
    // `launch` is a url query string (e.g. "v=<id>"), not a phrase: a site we do
    // not control has no other way in. withLaunchQuery is what keeps it to a few
    // short, ordinary parameters on the app's OWN url.
    //
    // A caller that sent only `query` - the field the SDK type documents for this
    // command - is asking a site we cannot script to search for something.
    // Opening its front page after stopping the music is the worst answer
    // available, so it is refused before anything is taken away.
    // `hasUsableLaunch` rather than a non-empty test: withLaunchQuery drops what
    // it cannot use and hands the base url back, so "   " or "a b" would open
    // the app's front page and silence the room to do it.
    const launch = String((cmd && cmd.launch) || "");
    if (!hasUsableLaunch(launch))
      return console.warn("[mqtt] play_media: " + id + " is a remote app and needs `launch`");
    // Silenced AFTER, not before: navTo can refuse - an unconfigured remote app,
    // or launch data past withLaunchQuery's caps - and the rule this shell
    // already keeps is that a refusal must not cost the current stream.
    if (!deps.navTo(id, { query: launch })) return console.warn("[mqtt] play_media: not opened:", id);
    silenceForPlayMedia(id);
    return;
  }
  const query = playQuery(cmd && cmd.query);
  if (!query) return console.warn("[mqtt] play_media: nothing to look for");
  // Same order as the remote branch above, and for the same reason.
  if (!deps.navTo(id)) return console.warn("[mqtt] play_media: not opened:", id);
  silenceForPlayMedia(id);
  const w = deps.appWindow(id);
  if (!w || w.isDestroyed()) return console.warn("[mqtt] play_media: no window for", id);
  // Only an app that LISTENS for `play_media` can answer it; one that does not
  // simply comes forward on whatever screen it was left on. Nothing here can tell
  // the two apart - `onCommand` is ungated and unannounced - so the sender is the
  // one that has to know which apps implement it. Logged so a box where nothing
  // happened says why.
  console.log("[mqtt] play_media ->", id, JSON.stringify(query).slice(0, 80));
  const send = () => {
    try {
      w.webContents.send("tv-command", { action: "play_media", app: id, query });
    } catch (e) {}
  };
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
  else send();
}

function handle(cmd) {
  const player = deps.player;
  const action = String((cmd && cmd.action) || "").toLowerCase();
  // The state is logged as well as the app: a state the box does not recognise is
  // dropped in silence, and this log is where that is diagnosed.
  console.log("[mqtt] command", action, (cmd && (cmd.app || cmd.state)) || "");
  switch (action) {
    case "launch":
    case "open":
      if (cmd && cmd.app) deps.navTo(String(cmd.app));
      break;
    case "home":
      deps.showLauncher();
      break;
    case "pause":
      player.cmd({ command: ["set_property", "pause", true] });
      forwardCommand(cmd);
      break;
    case "play":
    case "resume":
      player.cmd({ command: ["set_property", "pause", false] });
      forwardCommand(cmd);
      break;
    case "stop":
      player.setPlaying(null);
      player.stop();
      deps.setVideoMode(false);
      // With a reason, because this is a stop and not the end of the item: an app
      // that auto-advances on `finished` (Plex on-deck) would otherwise start the
      // next episode for someone who just pressed stop on their phone.
      player.emit({ type: "finished", reason: "stopped" });
      forwardCommand(cmd);
      break;
    case "next":
    case "previous":
      forwardCommand(cmd);
      break; // no mpv analogue; the app that owns the sound routes it
    // Three the shell has no analogue of at all: what shuffle, repeat and the
    // lyrics mean belongs to the app holding the queue, so they are only
    // forwarded. `state` travels in the house's own vocabulary (on/off/toggle,
    // and off/one/all for repeat) and each app translates it into its own -
    // Spotify's API wants "context"/"track", the mediaclient's queue "all"/"one".
    case "shuffle":
    case "repeat":
      forwardCommand(cmd);
      break;
    case "lyrics":
      // The one of the three that needs a SCREEN. An app playing in the
      // background has no way to show anything, so the command has to bring it
      // forward first - and the forward must happen before the command, or the
      // app answers it while still hidden and the screen never changes.
      showLyrics(cmd);
      break;
    // Music asked for by voice. The assistant knows what to play but cannot
    // reach what plays it: the Spotify account lives in that app's own plugin,
    // behind an HTTP server bound to loopback, and YouTube's TV page is
    // somebody else's site. So the box is told which APP and what to look for,
    // and the app does the searching with the credentials it already has.
    //
    // THE RELEASE THIS SHIPS IN MUST BE 3.8.0 OR HIGHER. A publish to an action
    // an older shell does not know succeeds - the broker accepts the topic and
    // this switch logs "unknown command" - so the assistant refuses to send one
    // to a box below `PLAY_MEDIA_SINCE` (assistant-stack tools/music.py), read
    // from the box's own version sensor. Cutting a 3.7.x release with this in it
    // would leave that gate refusing a box that can in fact hear it.
    case "play_media":
      playMediaIn(cmd);
      break;
    case "tv_on":
      deps.cecPower(true);
      break;
    case "tv_off":
    case "standby":
      deps.cecPower(false);
      break;
    case "volume_up":
    case "volume_down":
    case "mute":
      // TV volume over the IR blaster (ir.js) - CEC volume doesn't reach every
      // TV. steps repeats the send ("volume up by 3"); ir.js clamps it.
      deps.ir
        .send(action, cmd && cmd.steps)
        .catch((e) => console.warn("[ir]", action, "failed:", (e && e.message) || e));
      break;
    // The box's OWN output volume, deliberately separate from the three above:
    // those drive the TV's amplifier over IR and have no absolute value to set,
    // this is the sink the box plays through. A media_player entity's volume
    // slider means this one.
    case "volume_set":
    case "volume_mute":
      deps.setBoxVolume(action, cmd);
      break;
    case "seek": {
      // Absolute, in seconds - only meaningful while WE hold the clock (mpv);
      // an app playing its own audio has no position for us to move. A non-numeric
      // position would reach mpv as JSON `null` (NaN does not survive stringify),
      // so it is rejected here rather than sent. A real number, not a coercion:
      // Number(null) and Number("") are both 0, i.e. a silent seek to the start.
      const pos = cmd && typeof cmd.position === "number" ? cmd.position : NaN;
      if (player.media.active && Number.isFinite(pos) && pos >= 0) player.cmd({ command: ["seek", pos, "absolute"] });
      else if (!Number.isFinite(pos)) console.warn("[mqtt] seek: bad position", cmd && cmd.position);
      break;
    }
    case "find_remote":
    case "find_remote_stop": {
      // The one control that CANNOT sensibly live on the remote: you are asking
      // because you cannot find it. A phone, Home Assistant or a voice command
      // is the whole point, so it is here rather than only in Settings.
      const warn = (err) => err && console.warn("[mqtt] find_remote:", err.message || err);
      const ring = (mac) => deps.remotefinder.ring(mac, true, warn);
      // A stop needs no mac - it targets whatever the box believes is ringing,
      // which is also why an unvalidated payload can never reach a write here.
      if (action !== "find_remote") deps.remotefinder.stop(warn);
      else if (cmd && typeof cmd.mac === "string") ring(cmd.mac);
      else
        deps.remotefinder.capableRemotes((macs) => {
          if (macs.length) ring(macs[0]);
          else console.warn("[mqtt] find_remote: no remote here can ring");
        });
      break;
    }
    default:
      console.warn("[mqtt] unknown command:", action);
  }
}

module.exports = { init, handle, forwardCommand, showLyrics, playMediaIn, silenceForPlayMedia, soundingApp };
