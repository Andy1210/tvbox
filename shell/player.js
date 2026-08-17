// The shared player: one mpv, driven over its JSON IPC, playing BEHIND the shell's
// transparent window.
//
// It is a service rather than a library. Only one thing plays at a time on a TV, so
// there is one process, one display-mode claim and one HDR claim, and every path
// that stops playback has to come through here or the box keeps reporting a film
// nobody is watching.
//
// Two sequences of events are load-bearing and easy to break:
//
//   • A fullscreen film starts PAUSED. The output mode and the colour space are
//     chosen from what the file turns out to be, and a mode change blanks HDMI for
//     a second or two - that belongs before the first frame, not three seconds into
//     the film. `startMpvPlayback` is that handshake, with a 6 s failsafe so a
//     wedged read can never leave a film paused forever.
//   • Every launch carries a sequence number. Reading mpv's properties takes
//     seconds, and an answer that arrives after the film was stopped must not claim
//     a mode for the NEXT one.
//
// PiP switches nothing: the browse UI owns the screen there, and the compositor
// places the small window (a Wayland client cannot place itself).
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const apps = require("./install"); // manifests + what is on PATH
const compositor = require("./compositor"); // window placement for PiP
const config = require("./config");
const hdrout = require("./hdr"); // whether the output should be in PQ for this film
const playeropts = require("./playeropts"); // app stream terms -> mpv args
const videoout = require("./videoout"); // which mpv renderer a stream needs

// One IPC socket per launch, named for the launch counter. With a single fixed
// path an mpv that was still shutting down removed the socket the NEXT launch had
// just created: that film's observer never connected, so no position reached the
// app and the paused start waited out its failsafe instead of the handshake.
const ipcFor = (seq) => "/tmp/tvbox-mpv-" + seq + ".sock";
let ipc = ipcFor(0);
const MPV_CLAIM = "shell:mpv"; // claim id for the shell's own player

// What the shell owns and the player has to reach: its windows, the display-mode
// arbiter, the TV's power, and the panel's own answers.
let deps = {
  sendEvent: () => {}, // player-event to the launcher and the foreground app
  setVideoMode: () => {}, // reveal the video (make the window transparent) or restore
  raiseWindow: () => {}, // pull the app UI back over mpv
  cecPower: () => {}, // wake the TV for a film that starts while it sleeps
  publishMediaState: () => {}, // the retained now-playing topic
  dmode: { claim: (_id, _c, cb) => cb && cb(null), release: () => {} },
  panelHdr: () => false, // the set accepts BT2020 + PQ (EDID)
  outputSize: () => null, // what the output is CURRENTLY at, for a PiP rectangle
  audioSink: () => null, // the HDMI sink mpv should play to
  childEnv: () => process.env,
};
function init(d) {
  deps = { ...deps, ...d };
}

let mpv = null;
let mpvPip = false; // mpv is in PiP (small top-right) mode, not fullscreen
let playingUrl = null;
let mpvOwnerId = null; // app id whose player broker call launched mpv (video-mode target)
let mpvStartPending = false; // fullscreen mpv launched paused, waiting for the display-mode switch
let mpvSeq = 0; // launch counter, so a stale start-gate timer can't touch a newer launch
let mpvStartedSeq = 0; // the launch whose start handshake already ran
// This launch plays sound only, so none of the screen's machinery applies: no
// output-mode handshake, no HDR claim, no revealing the video behind the UI.
let mpvAudioOnly = false;
let mpvPlaylistPos = -1; // which playlist entry is playing, for the "track" event
/**
 * The URLs behind the playlist entries, in order, so `playingUrl` can follow the
 * queue.
 *
 * Without this the shell's idea of what is playing only ever moves on an explicit
 * play or stop, and a queue advances without either. Measured on the box: once
 * the player had crossed to the second entry, asking for the FIRST one again
 * logged "resume (already loaded)" and carried on with the second - the check
 * compared against a URL that had stopped being true. The same stale value is
 * what a PiP toggle relaunches, so it would have brought back the wrong item.
 */
let mpvQueueUrls = [];

/**
 * How many entries an app may keep queued behind the one playing.
 *
 * A bound rather than a policy: a queue entry is a URL that usually carries a
 * credential, it sits in another process's memory, and an app with a library of
 * thousands would otherwise hand all of them over at once. Apps top the list up
 * as it advances, which is what makes a small number enough.
 */
const QUEUE_MAX = 32;

/**
 * What may be handed to the player as a queue entry.
 *
 * http(s) only, and the same rule the sidecar-subtitle path already applies: the
 * URL reaches another process, and `loadfile` will open anything mpv can open -
 * a local path, or a protocol like `avdevice://`. The first play() is argv, where
 * `--` already stops a URL being read as an option; a queued one is not, so this
 * is where it is bounded.
 */
function playableUrl(u) {
  if (typeof u !== "string" || u.length > 4096) return false;
  return /^https?:\/\//i.test(u);
}

// What mpv is doing right now. Kept here rather than read on demand: the observer
// already streams it (observeMpv), and asking mpv over its socket per publish would
// turn a state topic into a round trip.
const mpvMedia = { active: false, paused: false, position: null, duration: null };
// The clock stops with the process. Both ways mpv can go away have to come through
// here - our own stopMpv AND mpv exiting on its own, which is what the end of a
// film is - or a retained state topic keeps reporting a position for something
// nobody is watching.
function clearMpvMedia() {
  if (!mpvMedia.active) return;
  mpvMedia.active = false;
  mpvMedia.paused = false;
  mpvMedia.position = null;
  mpvMedia.duration = null;
  deps.publishMediaState({ force: true });
}

// ---- mpv control ----
// Player events go to the launcher (now-playing state) and the FOREGROUND app
// only - never a backgrounded app; which windows those are is the shell's answer.
// A hidden app receiving "finished" and auto-advancing would start mpv behind an
// opaque foreground (invisible video + phantom audio) and keep the box from ever
// reporting idle.
function emit(ev) {
  deps.sendEvent(ev);
}
// One request/response round-trip on the mpv IPC socket (mpvCmd is fire-and-
// forget). Resolves null on any failure - callers treat that as "no tracks".
function mpvQuery(command) {
  return new Promise((resolve) => {
    const s = net.connect(ipc);
    const to = setTimeout(() => {
      try {
        s.destroy();
      } catch (e) {}
      resolve(null);
    }, 2500);
    s.on("error", () => {
      clearTimeout(to);
      resolve(null);
    });
    let buf = "";
    s.on("connect", () => {
      try {
        s.write(JSON.stringify({ command, request_id: 77 }) + "\n");
      } catch (e) {}
    });
    s.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (m.request_id === 77) {
          clearTimeout(to);
          try {
            s.end();
          } catch (e) {}
          return resolve(m.error === "success" ? m.data : null);
        }
      }
    });
  });
}

function mpvCmd(obj) {
  const s = net.connect(ipc);
  s.on("error", () => {});
  s.on("connect", () => {
    try {
      s.write(JSON.stringify(obj) + "\n");
    } catch (e) {}
    s.end();
  });
}
// keepMode: launchMpv's own pre-launch stop, where releasing the display claim
// would put the UI mode back for a second only for the new file to claim again.
function stopMpv(keepMode) {
  // (mpvOwnerId is NOT cleared here: launchMpv calls this on relaunch right
  // after "play" set the owner. Every play re-assigns it, and without a running
  // mpv no first-frame reveal can consume a stale value.)
  if (!keepMode) {
    setHdr(false);
    deps.dmode.release(MPV_CLAIM);
  }
  clearMpvMedia(); // the clock stops with the process (see clearMpvMedia)
  mpvStartPending = false; // no paused-start handshake outlives the process
  if (mpv) {
    const pid = mpv.pid;
    mpv.removeAllListeners("exit"); // our own kill must NOT signal "finished" to the app
    try {
      process.kill(-pid, "SIGTERM");
    } catch (e) {
      try {
        mpv.kill("SIGTERM");
      } catch (e2) {}
    }
    console.log("[player] stopMpv pid", pid);
    mpv = null;
  }
  try {
    fs.unlinkSync(ipc);
  } catch (e) {}
}
// mpv logs its own COMMAND LINE, and the file it plays is on it - so this file
// gets the media URL with whatever credentials it carries, and nothing here can
// stop that: it is mpv writing, not us. What can be done is who may read it, so
// the file is created 0600 first (mpv truncates an existing file and keeps its
// mode). It is deliberately NOT one of the logs tvbox-diag copies to the boot
// partition.
function mpvLogPath() {
  const p = path.join(os.homedir(), ".tvbox", "mpv.log");
  try {
    // O_NOFOLLOW, so a SYMLINK at this path is refused by the kernel rather than
    // followed - checking with lstat first would leave the gap between the check
    // and the open. It matters because mpv writes wherever this path leads and we
    // would have chmodded that target on the way: ~/.tvbox is reachable through
    // the file server, so "nobody can put a link there" is not a given.
    const fd = fs.openSync(
      p,
      fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      // A fifo or a device would take mpv's writes somewhere of its own too.
      if (!fs.fstatSync(fd).isFile()) return null;
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null; // no log rather than a log we are not sure of; playback is unaffected
  }
  return p;
}

// Where a small player goes when the caller measured no placeholder: the top-right
// quarter, inset. Only a caller that skipped the rect lands here - the Live TV app
// measures its own hole - so this is a shape that looks deliberate rather than one
// anybody depends on.
function pipFallbackRect() {
  const output = deps.outputSize();
  if (!output) return null; // no mode read yet: fullscreen is better than a guess
  const w = Math.round(output.width * 0.26);
  const h = Math.round((w * 9) / 16);
  const margin = Math.round(output.width * 0.03);
  return { x: output.width - w - margin, y: margin, w, h };
}

function launchMpv(url, startPos, pip, rect, streams, opts) {
  // Fullscreen relaunch keeps the claim (the next file re-claims immediately, and
  // releasing in between would blank the TV twice); going to PiP gives it back,
  // because there the browse UI is what's on screen.
  stopMpv(!pip);
  const seq = ++mpvSeq; // this launch's identity for every async gate below
  ipc = ipcFor(seq);
  // An mpv that was killed hard leaves its socket file behind, and mpv will not
  // bind over an existing one - that launch would then have no IPC at all.
  try {
    fs.unlinkSync(ipc);
  } catch (e) {}
  mpvPip = !!pip;
  mpvAudioOnly = !!(opts && opts.audioOnly);
  mpvPlaylistPos = -1;
  mpvQueueUrls = [url];
  // mpv is a shared, dep-gated player service - spawned lazily only when a
  // player-capable app actually plays, and only if the binary is present. A box
  // that never opted into an mpv app (fresh install) has no mpv; degrade with a
  // clear event instead of an ENOENT spawn. (Tiles are already greyed via the
  // manifest's requires.bin, so this is the belt-and-suspenders path.)
  if (!apps.onPath("mpv")) {
    console.warn("[player] mpv not installed - cannot play (run: tvbox deps <app>)");
    emit({ type: "error" });
    emit({ type: "finished" });
    return;
  }
  emit({ type: "buffering", on: true });
  const args = [
    "--no-config",
    "--no-osc",
    "--no-input-default-bindings",
    // The renderer that works for anything, including software-decoded streams.
    // adaptMpvMode swaps it for the zero-copy output where that one cannot keep
    // up (videoout.js) - the property is settable, so no relaunch.
    "--vo=gpu",
    "--gpu-api=opengl",
    "--hwdec=auto-safe",
    "--input-ipc-server=" + ipc,
    "--start=" + startPos,
    // (the log file is appended below, when there is one we trust)
    "--msg-level=all=error",
  ];
  // Sound with no picture is a different job, not a film with the screen off.
  //
  // `--vid=no` also keeps an embedded cover out of the way: mpv treats album art
  // as a video track, so without it a tagged mp3 opens a window over the app's
  // own UI. `--audio-display=no` is the same guard from the other side.
  //
  // The two that earn this feature its name: `gapless-audio=yes` rather than the
  // default `weak`, because a queue mixes formats and `weak` only bridges files
  // that match; and `prefetch-playlist`, without which the next entry is only
  // opened once the current one ends - which over the network is most of the
  // silence this is meant to remove.
  if (mpvAudioOnly) {
    args.push("--vid=no", "--audio-display=no", "--gapless-audio=yes", "--prefetch-playlist=yes", "--keep-open=no");
  }
  // PiP (Live TV "browse while watching"): a small window. A Wayland client cannot
  // place itself, so the COMPOSITOR places it - `rect` (device px, measured by the
  // launcher from the on-screen placeholder) makes it match the placeholder exactly
  // at any resolution, and a top-right quarter is the fallback when a caller sends
  // none. It is set before mpv starts, so the window is never fullscreen first.
  //
  // mpv sits BEHIND the (transparent) Electron window and shows through a
  // box-shadow "hole" the browse UI punches, so the launcher keeps keyboard focus
  // (D-pad works) while the video is visible in the hole. The compositor keeps our
  // windows in front for the same reason.
  if (pip) {
    compositor.placeWindow("mpv", rect && rect.w > 0 ? rect : pipFallbackRect());
    args.push("--no-border");
  } else {
    compositor.placeWindow("mpv", null);
    args.push("--no-border");
    // Fullscreen starts PAUSED so the output can be switched to match the video
    // BEFORE it plays (adaptMpvMode -> startMpvPlayback below): a mode change
    // blanks HDMI for a second or two, which belongs before the first frame, not
    // three seconds into the film. PiP never switches - the UI owns the screen there.
    //
    // Sound has no frame to be early for. Pausing it would cost the handshake's
    // whole round trip before the first note, and the mode change it exists for
    // would blank a screen that is showing the app rather than a film.
    if (!mpvAudioOnly) {
      args.push("--pause=yes");
      mpvStartPending = true;
    }
  }
  const logFile = mpvLogPath();
  if (logFile) args.push("--log-file=" + logFile);
  if (deps.audioSink()) args.push("--audio-device=pipewire/" + deps.audioSink());
  // Track selection, per axis: what the app decided for itself (Plex resolves
  // audio/subtitle server-side and ships the choice with the item) wins, and
  // Settings > Picture & sound fills in the rest. The app's choice has to be
  // spelled out because mpv's default `sid=auto` turns on any subtitle track
  // carrying the container's default flag, which is how a film played with "no
  // subtitles" in Plex came up with Hungarian subs anyway.
  args.push(...playeropts.streamArgs(streams, config.rawPlayer()));
  // "--" ends option parsing: a URL starting with "-" (or a crafted playlist
  // entry) must always be argv's file position, never an mpv option.
  args.push("--", url);
  mpv = spawn("mpv", args, { env: deps.childEnv(), detached: true, stdio: "ignore" });
  const child = mpv;
  console.log("[player] mpv launched pid", mpv.pid, pip ? "(pip)" : "");
  // A spawn that never got off the ground (EACCES, fork failure - ENOENT is already
  // guarded above) emits "error" and no usable "exit". Unhandled it would take the
  // shell down, and it must not leave a paused-start flag or a claim behind either.
  child.on("error", (e) => {
    console.error("[player] mpv spawn failed:", e.message);
    child.removeAllListeners("exit"); // don't report "finished" twice
    if (mpv === child) mpv = null;
    playingUrl = null;
    mpvStartPending = false;
    deps.setVideoMode(false);
    setHdr(false);
    deps.dmode.release(MPV_CLAIM);
    emit({ type: "error" });
    emit({ type: "finished" });
  });
  // One-touch wake: video starting while the TV sleeps should light it up
  // (voice/HA "play X" with the TV off). "on 0" is a no-op on a TV that's
  // already on. The one exception: right after the USER put the TV on standby -
  // the stop we emit as "finished" can make an app auto-play the next item
  // (Plex on-deck), which must not switch the TV back on.
  if (Date.now() - lastTvStandbyAt > 30 * 1000) deps.cecPower(true);
  // Never leave a paused-start film stuck: if the file hasn't loaded (or the IPC
  // observer never came up) within 8s, do the mode handshake anyway. Tied to this
  // launch's sequence number so a stale timer can't shortcut the NEXT film.
  if (!pip) {
    setTimeout(() => {
      if (mpvSeq === seq && mpvStartPending) {
        // The file hasn't loaded (a slow Plex/HLS start) or the IPC observer never
        // came up: play rather than sit on a black screen. Deliberately NOT running
        // the handshake here - it would claim a mode from a stream mpv hasn't opened
        // yet. If the file does load later, the first-frame path still switches.
        console.warn("[player] start gate timed out - playing anyway");
        mpvStartPending = false;
        mpvCmd({ command: ["set_property", "pause", false] });
      }
    }, 8000);
  }
  mpv.on("exit", (code, sig) => {
    console.log("[player] mpv exited code", code, "sig", sig);
    emit({ type: "finished" });
    mpv = null;
    playingUrl = null;
    deps.setVideoMode(false);
    mpvStartPending = false;
    setHdr(false);
    deps.dmode.release(MPV_CLAIM); // film over -> UI mode back (stopMpv covers our own kills)
    // The END of a film is an exit, not a stopMpv - mpv runs without --keep-open.
    // Without this the retained state topic keeps saying "playing" with a frozen
    // position, so Home Assistant shows a film nobody is watching until the next
    // playback, and `seek` would still be aimed at a dead socket.
    clearMpvMedia();
  });
  // mpv grabs keyboard focus when its window maps (and can do so late), which
  // would break D-pad nav - so keep pulling the launcher back to the front +
  // focus for a few seconds. This works for both modes: fullscreen mpv is behind
  // the transparent overlay, and PiP mpv is behind the transparent window showing
  // through the browse UI's hole, so raising the launcher never hides the video.
  [500, 1200, 2000, 3000, 4000].forEach((ms) => setTimeout(deps.raiseWindow, ms));
  setTimeout(() => observeMpv(seq, 0), 900);
}
// What the video actually is, per mpv. `container-fps` is the stream's declared
// rate (not the drifting measured one); dwidth/dheight are the display size after
// aspect correction, with the decoded size as fallback - on the box dwidth came
// back "property unavailable" at the very moment dheight was already readable.
function readVideoProps() {
  const props = ["container-fps", "dwidth", "dheight", "width", "height", "hwdec-current", "video-params/gamma"];
  return Promise.all(props.map((p) => mpvQuery(["get_property", p]))).then(([fps, dw, dh, w, h, hwdec, gamma]) => ({
    fps: Number(fps) || 0,
    width: Number(dw) || Number(w) || 0,
    height: Number(dh) || Number(h) || 0,
    hwdec: typeof hwdec === "string" ? hwdec : "",
    // The transfer function the file was mastered with; "pq" is HDR10/DV.
    gamma: typeof gamma === "string" ? gamma : "",
  }));
}

// The output's colour space rides with the display mode: claimed for a PQ film
// that reaches the plane, released when it ends. Releasing matters as much as
// claiming - an SDR film left on a PQ output looks wrong, and the UI on its
// overlay plane is read as PQ for as long as the claim is held.
// null, not false: the shell restarts on its own (the session's respawn loop) while
// the compositor keeps running, so at startup the output may be in PQ from a film
// this process never played. "I have not said anything yet" and "I said no" are
// different, and only the first one makes the startup release actually go out.
let hdrClaimed = null;
function setHdr(on, cb) {
  const next = cb || (() => {});
  if (!!on === hdrClaimed) return next();
  hdrout.claim(on, (ok, err) => {
    if (ok) hdrClaimed = !!on;
    else console.warn("[player] hdr claim failed:", err);
    next();
  });
}

// Match the output to the video, then hand control back to the caller (which
// unpauses). A stream with no declared fps (some live HLS) leaves the mode alone.
// `seq` is the launch this belongs to: reading mpv's properties can take seconds,
// and a claim landing after that film was stopped would leave the launcher (or the
// NEXT film) at the dead one's mode with nothing left to release it.
function adaptMpvMode(seq, done) {
  const claim = (content) => {
    // Stopped, superseded, or already playing: reading mpv's properties can take
    // longer than the 6 s failsafe that starts the film without us, and a mode
    // change blanks HDMI for a second or two. That belongs before the first frame
    // or not at all.
    if (mpvSeq !== seq || !mpv || !mpvStartPending) return done();
    const zeroCopy = videoout.zeroCopyVideo(content, mpvPip);
    if (zeroCopy) {
      // `vo` is settable while paused, so this costs nothing visible - it lands in
      // the same paused window as the mode switch, before the first frame.
      mpvCmd({ command: ["set_property", "vo", videoout.ZERO_COPY_VO] });
    }
    // And the output's colour space, before the claim below. Order matters for a
    // reason that outlives any one compositor: the colour space covers the whole
    // output, so it has to be in place before the film's first frame reaches a
    // plane, and the caller unpauses in done().
    setHdr(hdrout.wants(content, zeroCopy, deps.panelHdr()), () => {
      if (!(content.fps > 0)) {
        console.log("[player] no container-fps - leaving the display mode alone");
        return done();
      }
      deps.dmode.claim(MPV_CLAIM, content, (r) => {
        // Nothing on this panel divides into the content's rate (a 60Hz-only set and
        // a 24p film): resample instead of juddering. This is what the old manual
        // "match content framerate" toggle did, decided per file now.
        if (r && r.reason === "no-matching-mode") {
          mpvCmd({ command: ["set_property", "video-sync", "display-resample"] });
        }
        done();
      });
    });
  };
  // Nothing in this chain rejects today (mpvQuery resolves null on every failure),
  // but playback must not hang on that staying true: anything thrown in here starts
  // the film immediately instead of waiting for the failsafe.
  const failed = (e) => {
    console.warn("[player] display mode adapt failed:", (e && e.message) || e);
    // We never learned what this file is, and a relaunch keeps the previous
    // claim - so without this an SDR film following an HDR one would play on a
    // PQ output. SDR is the safe answer to a question that got no answer.
    setHdr(false);
    done();
  };
  // Properties that settle late get a few more goes, keeping whatever each read
  // already learned: dwidth/fps come back "property unavailable" for the first
  // second or so after a paused start, and hwdec-current stays unavailable until
  // the decoder has actually run - which is what decides the renderer. Re-read
  // only while something we act on is still missing, so an ordinary file is not
  // held up: below 4K the hwdec answer changes nothing, so it is not waited for.
  const settle = (prev, tries) =>
    readVideoProps().then((c) => {
      const merged = {
        fps: c.fps || prev.fps,
        width: c.width || prev.width,
        height: c.height || prev.height,
        hwdec: c.hwdec || prev.hwdec,
        gamma: c.gamma || prev.gamma,
      };
      // Height counts as missing too: the renderer is chosen from it, and the two
      // axes settle independently (dwidth has come back unavailable at the very
      // moment dheight was already readable, so the reverse can happen as well).
      const missing =
        !(merged.fps > 0 && merged.width > 0 && merged.height > 0) ||
        videoout.hwdecPending(merged, mpvPip) ||
        hdrout.gammaPending(merged, videoout.zeroCopyCandidate(merged, mpvPip));
      if (!missing || tries <= 0) return merged;
      return new Promise((r) => setTimeout(() => r(settle(merged, tries - 1)), 250));
    });
  settle({ fps: 0, width: 0, height: 0, hwdec: "" }, 6).then(claim).catch(failed);
}

// Paused-start handshake: switch the mode, then play. The 6s failsafe is
// load-bearing - if the compositor wedges or the claim never answers, the film must
// still start. (launchMpv arms a second one for "the observer never connected".)
function startMpvPlayback(seq) {
  if (mpvStartedSeq === seq) return; // exactly one handshake per launch
  mpvStartedSeq = seq;
  const go = () => {
    if (mpvSeq !== seq || !mpvStartPending) return; // newer launch, or already playing
    mpvStartPending = false;
    mpvCmd({ command: ["set_property", "pause", false] });
    // A mode switch remaps windows, so pull the app UI back over mpv again.
    [200, 700, 1500].forEach((ms) => setTimeout(deps.raiseWindow, ms));
  };
  setTimeout(go, 6000);
  adaptMpvMode(seq, go);
}

function observeMpv(seq, tries) {
  // Its own launch's socket: a retry chain from a dead launch then cannot attach to
  // the next mpv and emit a second stream of playing/position/duration events.
  const s = net.connect(ipcFor(seq));
  let connected = false;
  let firstPos = false;
  s.on("error", (e) => {
    console.log("[player] observer error", e.code);
    // The observer is what starts playback now (paused launch), so an IPC socket
    // that isn't up yet must be retried rather than dropped - but only for the
    // launch it was started for, or a dead launch's retry chain would attach a
    // second observer to the NEXT mpv.
    if (!connected && mpv && mpvSeq === seq && (tries || 0) < 5)
      setTimeout(() => observeMpv(seq, (tries || 0) + 1), 400);
  });
  s.on("connect", () => {
    connected = true;
    console.log("[player] observer connected");
    // `paused-for-cache`, NOT `core-idle`: core-idle is also true while the USER
    // has it paused, so reporting it as buffering told a client the player was
    // stuck loading for as long as the film sat paused. Plex then spun its loader
    // over the frozen frame and killed the session on its own 120 s
    // BufferingTimeout ("Playback error"), measured on the box.
    // `playlist-pos` is what makes a queue visible to the app: with entries
    // appended, mpv moves to the next one itself instead of exiting, so the
    // "finished" that used to mark every track now only marks the end of the
    // whole list.
    ["time-pos", "duration", "pause", "eof-reached", "paused-for-cache", "playlist-pos"].forEach((p, i) =>
      s.write(JSON.stringify({ command: ["observe_property", i + 1, p] }) + "\n"),
    );
  });
  let buf = "";
  s.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (m.event !== "property-change") continue;
      if (m.name === "time-pos" && m.data != null) {
        // reveal the video (make the Electron window transparent) only in
        // fullscreen; in PiP the browse UI stays opaque and mpv floats on top.
        if (!firstPos) {
          firstPos = true;
          // None of this belongs to sound. Revealing the video makes the shell's
          // window TRANSPARENT, so doing it for a song would clear the screen the
          // app is drawing on; and there is no mpv window to raise or unpause.
          if (!mpvAudioOnly) {
            if (!mpvPip) {
              console.log("[player] first frame -> reveal video");
              deps.setVideoMode(true);
            }
            // mpv maps its window and grabs keyboard focus exactly when playback
            // actually starts. For a slow-to-buffer source (a Plex movie can take
            // well over 5s to start) that happens AFTER the fixed post-launch raise
            // retries ended, leaving mpv focused so the remote stops reaching the
            // app UI. Re-raise on the real playback-start event (and a short burst
            // after, since the focus grab can trail the first frame) - this covers
            // any buffer delay, unlike the fixed launch-time window.
            [0, 250, 700, 1500].forEach((ms) => setTimeout(deps.raiseWindow, ms));
            // The file is loaded now (that's what a time-pos means), so its real
            // fps/size are readable: pick a mode for it, then let it play.
            if (!mpvPip) startMpvPlayback(seq);
          }
        }
        emit({ type: "playing" });
        emit({ type: "position", ms: Math.round(m.data * 1000) });
        mpvMedia.active = true;
        mpvMedia.position = m.data;
        deps.publishMediaState();
      } else if (m.name === "duration" && m.data != null) {
        emit({ type: "duration", ms: Math.round(m.data * 1000) });
        mpvMedia.duration = m.data;
        deps.publishMediaState();
      } else if (m.name === "pause") {
        // Observed for the media state only - the renderer learns about pausing
        // from its own player calls.
        mpvMedia.paused = !!m.data;
        deps.publishMediaState({ force: true });
      } else if (m.name === "playlist-pos") {
        // The queue moved on by itself. Reported as its own event rather than as
        // a "finished": an app that treats finished as "the item ended, start the
        // next" would react to this by starting something, which is exactly the
        // relaunch a queue exists to avoid.
        const at = typeof m.data === "number" ? m.data : -1;
        if (at !== mpvPlaylistPos) {
          const previous = mpvPlaylistPos;
          mpvPlaylistPos = at;
          // Only an advance, and never the first entry: the property also fires
          // when the list is created, and that entry is the one the app just
          // asked to play - it does not need to be told.
          if (at >= 0 && previous >= 0 && at !== previous) {
            // What the shell believes is playing has to move with the queue, or
            // the "already loaded" check and the PiP relaunch both act on the
            // entry this one replaced.
            if (mpvQueueUrls[at]) playingUrl = mpvQueueUrls[at];
            emit({ type: "track", index: at });
          }
        }
      } else if (m.name === "paused-for-cache") emit({ type: "buffering", on: !!m.data });
      else if (m.name === "eof-reached" && m.data) {
        // Logged, not emitted: mpv runs without --keep-open, so the end of a file is
        // also the end of the process, and the exit handler is what reports it. Two
        // "finished" events milliseconds apart make an app auto-advancing on the
        // event (Plex on-deck) skip the item after this one.
        console.log("[player] eof-reached");
      }
    }
  });
}

// TV turned off (signalled by the CEC bridge): stop active playback so a stream
// doesn't keep running after the screen is off. Only the playback is stopped,
// nothing is killed; the app's UI updates via the "finished" event.
//
// The event carries a REASON, because "the film ended" and "something stopped it"
// are different things to the app on top: Plex answers the end of an item with its
// post-play screen, which on a series starts the next episode a few seconds later.
// With the screen off that is a box working its way through a season. An app that
// does not read the reason behaves as it did.
let lastTvStandbyAt = 0; // launchMpv suppresses its CEC wake right after this
// How long ago the USER put the TV on standby. Anything that wakes the panel by
// itself - the one-touch wake here, a cast arriving from a phone - has to respect
// the person who just turned the television off, and the timestamp is here because
// this is the module the CEC bridge reports standby to.
function msSinceTvStandby() {
  return Date.now() - lastTvStandbyAt;
}
function onTvStandby() {
  lastTvStandbyAt = Date.now();
  if (!mpv) return;
  console.log("[tv] standby -> stop playback");
  playingUrl = null;
  stopMpv();
  deps.setVideoMode(false);
  emit({ type: "finished", reason: "tv-standby" });
}

// What the shell asks about a running film.
const running = () => !!mpv;
// Mid paused-start handshake: a "play" arriving now must let the switch finish
// rather than unpause INSIDE it.
const startPending = () => mpvStartPending;
/** Whether what is loaded was started as sound rather than as a picture. */
const isAudioOnly = () => mpvAudioOnly;
const isPip = () => mpvPip;
const playing = () => playingUrl;
const setPlaying = (url) => {
  playingUrl = url;
};
const owner = () => mpvOwnerId;
const setOwner = (id) => {
  mpvOwnerId = id;
};

/**
 * Append entries behind what is playing, so the player moves on by itself.
 *
 * This is the whole of "gapless" from the shell's side. Today the end of a file
 * is the end of the process - mpv runs without `--keep-open` - so an app hears
 * "finished" and asks for another launch, and the silence in between is a
 * process teardown, a start, and a network connection. With a list, mpv crosses
 * from one entry to the next inside one process.
 *
 * Deliberately dumb: nothing here knows what the entries are, which app sent
 * them, or what they mean. An app hands over URLs and tops the list up as it
 * advances, which is what keeps the bound below small enough to be honest.
 */
function enqueueMpv(urls) {
  if (!mpv) return { ok: false, error: "nothing is playing" };
  // Sound only, and that is a correctness bound rather than a policy. An advance
  // does not re-run the per-item startup: no output-mode choice, no HDR claim, no
  // stream selection. A queued FILM would therefore play under the mode and the
  // track choices of the entry before it, which is a wrong picture reported as
  // success. Video wants a queue that carries all of that per entry; this one
  // does not pretend to be it.
  if (!mpvAudioOnly) return { ok: false, error: "the queue is for audio playback" };
  // A bare string is what the published type allows, and it used to fall
  // through as an empty list - answering ok with nothing queued, which is the
  // one shape a caller cannot tell from success.
  const wanted = Array.isArray(urls) ? urls : typeof urls === "string" ? [urls] : [];
  // The cap counts what is ALREADY waiting, not what one call asks for: capping
  // per call bounds nothing, since ten calls of thirty-two are three hundred
  // entries held in another process, each a URL that usually carries a credential.
  const behind = Math.max(0, mpvQueueUrls.length - (mpvPlaylistPos < 0 ? 1 : mpvPlaylistPos + 1));
  const room = Math.max(0, QUEUE_MAX - behind);
  const list = wanted.filter(playableUrl).slice(0, room);
  const refused = wanted.length - list.length;
  for (const u of list) {
    mpvCmd({ command: ["loadfile", u, "append"] });
    mpvQueueUrls.push(u);
  }
  // Counted, not silent: an app whose entries are all being refused would
  // otherwise see a queue that simply never advances.
  if (refused > 0) console.warn("[player] queue: refused " + refused + " of " + wanted.length + " entries");
  return { ok: true, added: list.length, refused };
}

/**
 * Drop what is queued BEHIND the current entry; what is playing keeps playing.
 *
 * `playlist-pos` is reset here rather than left to the observer: after the clear
 * the surviving entry IS position 0, and without this that reads as an advance
 * and the app would be told a track started that has been playing all along.
 */
function clearMpvQueue() {
  if (!mpv) return { ok: false, error: "nothing is playing" };
  mpvCmd({ command: ["playlist-clear"] });
  mpvPlaylistPos = -1;
  // `playlist-clear` keeps the entry being played, and it becomes index 0.
  mpvQueueUrls = playingUrl ? [playingUrl] : [];
  return { ok: true };
}

module.exports = {
  init,
  setHdr,
  pipFallbackRect,
  startPending,
  isAudioOnly,
  MPV_CLAIM,
  launch: launchMpv,
  enqueue: enqueueMpv,
  clearQueue: clearMpvQueue,
  playableUrl,
  stop: stopMpv,
  cmd: mpvCmd,
  query: mpvQuery,
  emit,
  media: mpvMedia,
  clearMedia: clearMpvMedia,
  onTvStandby,
  msSinceTvStandby,
  running,
  isPip,
  playing,
  setPlaying,
  owner,
  setOwner,
};
