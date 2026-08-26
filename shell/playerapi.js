// The `player` capability: what an app's page may do to the shared mpv.
//
// The rules are the point of the module. Only the FOREGROUND window may drive the
// player, and only if its app holds the capability - a backgrounded app must never
// start playback, it would play behind an opaque foreground (invisible video +
// phantom audio) and keep the box from reporting idle. IPC is async, so a
// just-backgrounded app's late play() call arrives after the foreground has moved
// on, and is rejected.
//
// One exception, and it is sound: the app that OWNS what is loaded may keep driving
// it after it leaves the screen. A queue has to cross to its next track with nobody
// looking at the app, and pause/stop have to keep working from a phone or the house
// assistant. What a background sender still may not do is start a PICTURE.
const httpserver = require("./httpserver"); // originOf: a URL's origin, never the URL
const playeropts = require("./playeropts"); // stream terms -> mpv commands + the settable-property allowlist

let deps = {
  player: null,
  capsFor: () => [],
  currentApp: () => null,
  appWindow: () => null,
  setVideoMode: () => {},
  ensureAudio: (cb) => cb(),
  clearSoundWidget: () => {},
};

function init(d) {
  deps = { ...deps, ...d };
}

// `streams` is the app's own track decision (a media client that resolved which
// audio/subtitle stream to play server-side, e.g. Plex): 0-based ordinals within
// their type, `sub: -1` = subtitles off, `subFile` = a sidecar subtitle URL.
// null anywhere = "no opinion", which leaves mpv's own selection alone.
// `kind` is the app saying what this is, not the shell guessing: "audio" skips
// the output-mode handshake and the video reveal, which belong to a film and cost
// a screen blank and a round trip before the first note.
const queued = { url: null, startPos: 0, streams: null, kind: null };

/**
 * @param senderId the sender WINDOW's own app id: null = the launcher, a string =
 *   that app, undefined = an unknown or stale sender (no identity, no caps).
 */
function handle(senderId, action, payload) {
  const player = deps.player;
  const current = deps.currentApp();
  const background = senderId !== current;
  // `!= null` on purpose: the launcher's id is null, and the launcher is never a
  // background owner - it is the thing in front when it plays anything.
  // Deliberately NOT gated on the player still running. The gap between two
  // tracks is exactly the moment mpv is gone: the app hears the end, asks for
  // the next one, and there is nothing loaded while it does - so requiring a
  // live player refused every advance and an album in the background stopped
  // after one track. Measured, twice.
  //
  // What that leaves is "the last app to have played keeps the exemption", and
  // the bound on it is not time but KIND: everything a background sender may do
  // with it is sound (`queue` and `play` both refuse anything else, `pip` is
  // refused outright), and the app holding it is the one whose music the person
  // was listening to. An app that has never played holds nothing.
  const ownsPlayer = senderId != null && player.owner() === senderId;
  if (senderId === undefined || (background && !ownsPlayer) || !deps.capsFor(senderId).includes("player")) {
    return { ok: false, error: "player not permitted (not the foreground app)" };
  }
  payload = payload || {};
  // Where it plays FROM, never the URL. A slice of one looked safe because a Plex
  // token sits late in the query string, but an IPTV URL carries its username and
  // password as PATH segments - right after the host, inside any slice - and this
  // log is what `tvbox-diag --logs` copies onto the boot partition, which any
  // laptop can read. The origin is what a diagnosis actually needs.
  console.log("[player] action", action, payload && payload.url ? httpserver.originOf(payload.url) : "");
  if (action === "queue") {
    // `queued` is one object shared by every app, so what a background sender
    // writes here is what the FOREGROUND app's next play launches - including a
    // plain resume, which does not re-queue. Sound is all a background sender
    // may stage, for the same reason it is all one may start.
    if (background && payload.kind !== "audio") {
      return { ok: false, error: "player not permitted (a background app may only queue sound)" };
    }
    queued.url = payload.url;
    queued.startPos = payload.startPos || 0;
    queued.streams = payload.streams || null;
    queued.kind = payload.kind === "audio" ? "audio" : null;
  } else if (action === "enqueue") {
    // Entries behind the one playing, so the player crosses to the next itself.
    // Refused unless something is already playing: an empty player has nothing
    // to append to, and starting one from a queue call would hide which entry
    // the app actually asked for.
    return player.enqueue(payload.urls);
  } else if (action === "queueclear") {
    return player.clearQueue();
  } else if (action === "play") {
    // The half of the background rule that needs to know WHAT is being started.
    // Sound may begin off screen - the next track of a queue nobody is watching
    // - but a picture may not: it would take the output mode and the reveal from
    // whatever is actually in front, and play where nobody can see it.
    if (background && queued.kind !== "audio") {
      return { ok: false, error: "player not permitted (a background app may only play sound)" };
    }
    // remember whose window the video belongs to: the first-frame reveal
    // (setVideoMode(true) in observeMpv) must hit THAT window, not the launcher
    const previousOwner = player.running() ? player.owner() : null;
    player.setOwner(senderId || null);
    // Tell the app that just lost the player. Nothing used to: leaving an app
    // sends `finished{reason}` because the shell stops the player, but one app
    // TAKING it from another was silent - so a media client whose music had been
    // replaced by Live TV went on reporting itself as playing, to the house and
    // to a phone, with a position that never moved. Its own card on HOME went
    // with it, since the app can no longer be the one to clear it.
    if (previousOwner != null && previousOwner !== player.owner()) {
      // Sent to THAT window rather than through the player's own emit, which
      // reaches the launcher and the foreground app - and the app being told is
      // by definition neither. It answers a `finished` WITH a reason by
      // stopping rather than advancing, and its own stop is refused by the
      // guard above (it is a background non-owner now), so it cannot take the
      // player back from the app that just claimed it.
      const prevWin = deps.appWindow(previousOwner);
      if (prevWin && !prevWin.isDestroyed()) {
        try {
          prevWin.webContents.send("player-event", { type: "finished", reason: "replaced" });
        } catch (e) {}
      }
      deps.clearSoundWidget(previousOwner);
    }
    // The KIND has to match as well as the URL. The same file asked for as
    // sound after being played as a picture is a different launch - audio skips
    // the mode handshake and the reveal - and resuming here would silently keep
    // the mode the caller just said it did not want.
    const sameKind = player.isAudioOnly() === (queued.kind === "audio");
    if (player.running() && player.playing() === queued.url && sameKind && !player.isPip()) {
      if (player.startPending()) {
        // Still in the paused-start handshake: the mode switch starts it in a
        // moment. Unpausing here would put the switch INSIDE playback.
        console.log("[player] play during the start handshake - letting it finish");
      } else {
        console.log("[player] resume (already loaded)");
        player.cmd({ command: ["set_property", "pause", false] });
      }
    } else if (queued.url) {
      player.setPlaying(queued.url);
      deps.setVideoMode(false);
      deps.ensureAudio(() =>
        player.launch(queued.url, queued.startPos, false, null, queued.streams, {
          audioOnly: queued.kind === "audio",
        }),
      );
    } // fullscreen (also un-PiPs)
  } else if (action === "pause") player.cmd({ command: ["set_property", "pause", true] });
  else if (action === "resume") player.cmd({ command: ["set_property", "pause", false] });
  else if (action === "stop") {
    player.setPlaying(null);
    player.stop();
    deps.setVideoMode(false);
  } else if (action === "seek") player.cmd({ command: ["seek", payload.posSec || 0, "absolute"] });
  else if (action === "tracks") {
    // audio/subtitle tracks of the playing stream, for an in-playback picker
    return player.query(["get_property", "track-list"]).then((list) => ({
      ok: Array.isArray(list),
      tracks: (Array.isArray(list) ? list : [])
        .filter((t) => t && (t.type === "audio" || t.type === "sub"))
        .map((t) => ({
          type: t.type,
          id: t.id,
          lang: t.lang || "",
          title: t.title || "",
          selected: !!t.selected,
        })),
    }));
  } else if (action === "track") {
    // { type: "audio"|"sub", id: <track id> | "no" | "auto" } - aid/sid switch
    const prop = payload.type === "sub" ? "sid" : "aid";
    const v = payload.id === "no" || payload.id === "auto" ? payload.id : Number(payload.id);
    if (typeof v === "string" || Number.isFinite(v)) player.cmd({ command: ["set_property", prop, v] });
  } else if (action === "select") {
    // Mid-playback version of the queue's `streams`, in the SAME ordinal terms
    // (`track` above speaks mpv track ids, which an app that never saw the track
    // list can't produce). Remembered as well as applied: going to PiP and back
    // RELAUNCHES mpv from `queued.streams`, so a selection only sent to the live
    // player would be quietly undone by the next toggle. Merged per axis - a
    // call that changes only the subtitle must not clear the audio choice.
    for (const command of playeropts.streamCommands(payload)) player.cmd({ command });
    queued.streams = playeropts.mergeStreams(queued.streams, payload);
  } else if (action === "prop") {
    // One allowlisted playback property (subtitle/audio sync, speed, volume,
    // subtitle look). A refusal is reported, not swallowed: an app that gets
    // "ok" for a setting that never landed has no way to notice.
    const v = playeropts.propValue(payload.name, payload.value);
    if (v === null) return { ok: false, error: "property not allowed or value out of range" };
    player.cmd({ command: ["set_property", payload.name, v] });
  } else if (action === "pip") {
    // Toggle the current channel between a PiP (at the launcher-measured rect) and
    // fullscreen. PiP needs the window transparent (so mpv behind shows through the
    // hole); fullscreen starts opaque and observeMpv reveals on the first frame.
    //
    // Never from the background: this relaunches the stream WITH video and claims
    // the video mode, which is the one thing the background exemption exists to
    // withhold - the exemption is for sound.
    if (background) return { ok: false, error: "player not permitted (not the foreground app)" };
    if (player.playing()) {
      deps.setVideoMode(!!payload.on);
      deps.ensureAudio(() => player.launch(player.playing(), 0, !!payload.on, payload.rect, queued.streams));
    }
  }
  return { ok: true };
}

module.exports = { init, handle, queued };
