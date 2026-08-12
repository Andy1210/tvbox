// Screen mirroring: the unprivileged half.
//
// The radio work - creating the Wi-Fi Direct group and handing out an address -
// is root's, and lives in /usr/local/sbin/tvbox-miracast, started through a
// systemd unit the box user is allowed to manage. Everything here runs as the
// box user with no rights at all: it dials TCP 7236 outbound and binds UDP 1028,
// and 1028 is above the privileged range.
//
// Re-opening the WPS push button also needs no root, which is not obvious: the
// supplicant's control socket is group `netdev` and the box user is in it, so
// wpa_cli reaches it directly. That is worth keeping, because the button has a
// two-minute walk time and someone waiting with a phone must be able to re-open
// it without restarting the group.
//
// The stream reaches the screen through the shared mpv, by way of a FIFO: we
// strip the RTP header and write the transport stream into it, mpv reads it as
// an ordinary file. One thing to know before "improving" that - the zero-copy
// video output in videoout.js shows NOTHING for a software-decoded stream, and
// Miracast is always H.264, which this Pi has no hardware decoder for. Mirroring
// must stay on `--vo=gpu`. It does so by itself today, because that output only
// engages from 1440p up and a mirrored phone arrives at 1080p or less.
const fs = require("fs");
const net = require("net");
const dgram = require("dgram");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const wfd = require("./wfd");

const STATE_DIR = "/run/tvbox-miracast";
const STATE_FILE = path.join(STATE_DIR, "state");
const CTRL = "/run/wpa_supplicant_tvbox_miracast";
const UNIT = "tvbox-miracast.service";
const WPA_CLI = "/usr/sbin/wpa_cli";
const RTSP_PORT = 7236;
const RTP_PORT = 1028;
// The pipe carries a live picture of someone's phone, so it does not belong in
// /tmp, where any local account can read it - or pre-create the path as a
// symlink and have us write through it. The per-user runtime directory is 0700
// and cleaned up with the session; ~/.tvbox is the fallback for a process that
// somehow has no XDG_RUNTIME_DIR.
const FIFO = path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".tvbox"), "tvbox-miracast.ts");

// How often to re-open the push button, and for how long in total.
//
// WPS push-button is open to WHOEVER presses it - that is the protocol, not our
// implementation - so the guard is that the window is short, deliberate, and
// closes the moment a phone is in. Holding it open for as long as mirroring is
// armed would let a neighbour in range join instead, without any credential.
// Re-arming is well inside the two-minute walk time so it never lapses mid-window.
const ACCEPT_EVERY_MS = 45000;
const PAIR_WINDOW_MS = 120000;
// A source keeps the RTSP session on a timeout it tells us in the SETUP reply
// (30 s from the Galaxy). Ping at a third of the smallest value seen, which is
// frequent enough to be safe and rare enough to be invisible.
const KEEPALIVE_MS = 10000;
// The phone appears in the lease file a moment before it listens for RTSP.
const DIAL_EVERY_MS = 1000;
// How long a silent stream is still a stream. A phone that is switched off or
// carried out of range does not close the RTSP connection - it just stops
// sending, and waiting for TCP to work that out leaves a frozen frame on the TV
// for a minute or more. Three seconds is far longer than any gap in a live
// stream and short enough that stopping feels like a consequence of leaving.
const STREAM_GONE_MS = 3000;
// How much unread stream to hold before dropping. About a second at the
// bitrates a phone mirrors at - enough to ride out a scheduling hiccup, far too
// little to matter if the reader has gone away entirely.
const MAX_QUEUED_BYTES = 256 * 1024;

/** The helper's state file: plain `key=value` lines, world-readable on purpose. */
function parseState(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/**
 * Addresses dnsmasq has leased and has not yet forgotten, newest first.
 *
 * A lease line is `<expiry> <mac> <ip> <hostname> <client-id>`, expiry being a
 * unix time in seconds (0 = never). Newest first matters: a phone that
 * reconnects can hold two leases, and the older one belongs to a socket nothing
 * is listening on.
 *
 * **Expired rows must go.** A lease outlives the phone that held it, and this
 * list answers two questions at once - whether anyone is here (which shuts the
 * pairing button and stops the give-up timer) and who to dial. Keeping a dead
 * lease therefore wedges the sink open forever while dialling an address nobody
 * answers on, from the first ordinary disconnect onwards.
 */
function peersFromLeases(text, nowSec) {
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const expiry = parseInt(parts[0], 10);
    if (!Number.isFinite(expiry)) continue;
    if (expiry !== 0 && expiry <= now) continue;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(parts[2])) rows.push({ expiry, ip: parts[2], name: parts[3] || "" });
  }
  return rows.sort((a, b) => b.expiry - a.expiry).map((r) => r.ip);
}

/**
 * When may the push button be open, and when has waiting become loitering?
 *
 * Pulled out of the timers deliberately: this is the guard that decides whether
 * a stranger in range can join, so it should be provable without waiting two
 * minutes for an interval to fire.
 */
function pairingGate(paired, now, deadline) {
  if (paired) return "shut"; // someone is in; nobody else gets a seat
  return now > deadline ? "expired" : "open";
}

/**
 * @param {object} deps
 * @param {function} [deps.run]      execFile, injectable for tests
 * @param {function} [deps.log]
 * @param {function} [deps.onEvent]  ({type, ...}) - "armed" | "peer" | "streaming" | "stopped" | "error"
 * @param {string}   [deps.fifo]
 */
function create(deps) {
  const d = deps || {};
  const run = d.run || execFile;
  const log = d.log || (() => {});
  const emit = d.onEvent || (() => {});
  const fifoPath = d.fifo || FIFO;
  const stateFile = d.stateFile || STATE_FILE;

  let timers = [];
  let socket = null; // RTSP to the source
  let rtp = null; // UDP from the source
  let fifo = null; // write stream into the player's FIFO
  let session = null;
  let dialing = null;
  let armed = false;
  let pairDeadline = 0;
  let lastRtp = 0;
  let peerIp = null; // the only address whose RTP counts

  const now = d.now || (() => Date.now());

  /** Someone is in the group, so the push button has no business being open. */
  function paired() {
    return !!socket || peers().length > 0;
  }

  /**
   * Start (or restart) the window in which a phone may pair. Restarting it after
   * a disconnect is deliberate: a phone that drops mid-film should be able to
   * come back from the sofa, without a trip to the remote.
   */
  function openPairing() {
    pairDeadline = now() + (d.pairWindowMs || PAIR_WINDOW_MS);
    accept();
  }

  function every(ms, fn) {
    const t = setInterval(fn, ms);
    timers.push(t);
    return t;
  }

  function clearTimers() {
    timers.forEach(clearInterval);
    timers = [];
  }

  function state() {
    try {
      return parseState(fs.readFileSync(stateFile, "utf8"));
    } catch (e) {
      return {};
    }
  }

  function peers() {
    const leases = state().leases;
    if (!leases) return [];
    try {
      return peersFromLeases(fs.readFileSync(leases, "utf8"));
    } catch (e) {
      return [];
    }
  }

  /**
   * Re-open the WPS push button. No root: the control socket is group netdev -
   * but only because the helper chgrps the group's socket, which wpa_supplicant
   * creates root:root whatever the config says.
   *
   * The failure is logged rather than discarded, and that is not tidiness. When
   * this call silently failed, the symptom was a phone that found the box, asked
   * to pair three times and got no answer - a bug that reads entirely as the
   * phone's fault, with nothing anywhere to say otherwise.
   */
  function accept() {
    const iface = state().iface;
    if (!iface) return log("no group interface to accept on");
    run(WPA_CLI, ["-p", CTRL, "-i", iface, "wps_pbc"], { timeout: 5000 }, (err, out, errOut) => {
      const said = String(errOut || out || "").trim();
      if (err || /FAIL/.test(said)) log("could not open the push button:", said || (err && err.message));
    });
  }

  // A FIFO rather than a file: mpv reads it as it is written, and nothing has to
  // grow on the SD card while someone mirrors a two-hour film from their phone.
  function openFifo(cb) {
    try {
      const found = fs.existsSync(fifoPath) && fs.lstatSync(fifoPath);
      // Something is there but it is not a pipe - a stale regular file, or a
      // symlink pointing somewhere else entirely. Writing a live picture of
      // someone's phone through it is not a risk worth taking, so replace it.
      if (found && !found.isFIFO()) fs.unlinkSync(fifoPath);
      else if (found) return cb(null);
    } catch (e) {
      return cb(e);
    }
    run("mkfifo", [fifoPath], { timeout: 5000 }, (err) => cb(err));
  }

  function startRtp() {
    rtp = dgram.createSocket("udp4");
    let bytes = 0;
    rtp.on("message", (packet, from) => {
      // Frames from anywhere else are not this session's. The port is open on
      // every interface, and a box mirroring over ethernet keeps its LAN - so
      // without this, anything that can reach UDP 1028 can put a picture on
      // someone's television.
      if (!peerIp || from.address !== peerIp) return;
      const payload = wfd.rtpPayload(packet);
      if (!payload || !fifo) return;
      lastRtp = now();
      if (!bytes) {
        log("first frames arrived");
        emit({ type: "streaming", fifo: fifoPath });
      }
      bytes += payload.length;
      // This is live: a player that has gone away, or is reading slowly, must
      // cost us frames rather than memory. So watch the queue and DROP when it
      // is over the mark. (Emitting "drain" by hand, which is what this did
      // first, tells the stream a full buffer is empty - which defeats
      // backpressure entirely and lets it grow without bound.)
      if (fifo.writableLength > MAX_QUEUED_BYTES) return;
      fifo.write(payload);
    });
    rtp.on("error", (err) => log("rtp:", err.message));
    rtp.bind(RTP_PORT);
  }

  function dial(ip) {
    const s = net.connect({ host: ip, port: RTSP_PORT });
    s.setTimeout(15000);
    s.on("connect", () => {
      s.setTimeout(0);
      log("connected to source", ip);
      socket = s;
      peerIp = ip;
      session = wfd.createSession({ sourceIp: ip, rtpPort: RTP_PORT, log });
      emit({ type: "peer", ip });
    });
    s.on("data", (chunk) => {
      if (!session) return;
      for (const out of session.feed(chunk.toString("latin1"))) s.write(out);
      if (session.state.torndown) stopSession();
    });
    s.on("timeout", () => s.destroy());
    s.on("error", () => {});
    s.on("close", () => {
      if (socket === s) {
        socket = null;
        peerIp = null;
        session = null;
        log("source closed the session");
        emit({ type: "peer-gone" });
        // The phone may simply have walked out of range. Re-open the window
        // rather than make someone fetch the remote - still bounded, still shut
        // the moment anyone is back in.
        if (armed) openPairing();
      }
    });
  }

  function stopSession() {
    if (socket) {
      try {
        if (session) socket.write(session.teardown());
      } catch (e) {}
      socket.destroy();
      socket = null;
    }
    session = null;
  }

  /** Bring the radio up as a sink and start waiting for a phone. */
  function start(cb) {
    const done = cb || (() => {});
    if (armed) return done(null, state());
    // `--no-ask-password`: without it a missing polkit grant does not fail, it
    // FREEZES the box - systemctl spawns pkttyagent, which reads a terminal and
    // takes SIGTTIN, stopping the whole process group with the respawn loop in it.
    run("systemctl", ["--no-ask-password", "start", UNIT], { timeout: 45000 }, (err, out, errOut) => {
      if (err) {
        // `systemctl start` reports its own boilerplate - "the control process
        // exited with error code" - and the helper's actual sentence goes to the
        // journal. It leaves that sentence in the state file for exactly this
        // reason: there is one refusal that really happens (the radio is carrying
        // the box's network) and it tells the viewer what to do about it.
        const why = state().error || String(errOut || err.message || "").trim();
        log("could not arm:", why);
        emit({ type: "error", message: why });
        return done(new Error(why));
      }
      const s = state();
      if (s.state !== "running") {
        emit({ type: "error", message: "the group did not come up" });
        return done(new Error("group did not come up"));
      }
      armed = true;
      log("armed as", s.name, "on channel", s.channel);
      emit({ type: "armed", name: s.name, channel: s.channel, ssid: s.ssid });

      openFifo((err2) => {
        if (err2) {
          emit({ type: "error", message: "no fifo: " + err2.message });
          return done(err2);
        }
        // Opening a FIFO for writing blocks until a reader arrives, so this must
        // not be on the path that answers the caller.
        fifo = fs.createWriteStream(fifoPath, { flags: "a" });
        fifo.on("error", (e) => log("fifo:", e.message));
        startRtp();
        openPairing();
        every(KEEPALIVE_MS, () => {
          if (socket && session && session.state.playing) socket.write(session.keepalive());
        });
        every(ACCEPT_EVERY_MS, () => {
          if (pairingGate(paired(), now(), pairDeadline) === "open") accept();
        });
        // Nobody came. Give the radio back rather than leave a group owner
        // beaconing at an empty room - it holds an antenna this board shares
        // with Bluetooth, and an unattended open push button is the one thing
        // here a stranger could walk into.
        every(1000, () => {
          if (pairingGate(paired(), now(), pairDeadline) !== "expired") return;
          log("nobody paired within the window");
          emit({ type: "pair-timeout" });
          stop();
        });
        // Frames stopped: the phone is off, or out of range. Tear the session
        // down ourselves rather than leave its last frame on the TV until TCP
        // gives up on a peer that never said goodbye.
        every(1000, () => {
          if (!lastRtp || now() - lastRtp < STREAM_GONE_MS) return;
          log("frames stopped arriving");
          lastRtp = 0;
          stopSession(); // clears `socket`, so its close handler stays quiet
          emit({ type: "peer-gone" });
          if (armed) openPairing();
        });
        // Try each lease in turn rather than only the newest. A phone can hold
        // more than one at a time - same MAC, new address - and dnsmasq keeps a
        // lease well past the phone that held it, so always dialling the newest
        // means one dead entry can hide the live one for as long as it lasts.
        // Measured: a lease left from an earlier session swallowed the whole of
        // the next one.
        let next = 0;
        every(DIAL_EVERY_MS, () => {
          if (socket || dialing) return;
          const list = peers();
          if (!list.length) return;
          const ip = list[next % list.length];
          next += 1;
          dialing = ip;
          dial(ip);
          setTimeout(() => {
            dialing = null;
          }, 3000);
        });
        done(null, s);
      });
    });
  }

  /** Give the radio back, exactly as it was found. */
  function stop(cb) {
    const done = cb || (() => {});
    clearTimers();
    stopSession();
    lastRtp = 0;
    dialing = null;
    peerIp = null;
    pairDeadline = 0;
    if (rtp) {
      try {
        rtp.close();
      } catch (e) {}
      rtp = null;
    }
    if (fifo) {
      try {
        fifo.end();
      } catch (e) {}
      fifo = null;
    }
    armed = false;
    run("systemctl", ["--no-ask-password", "stop", UNIT], { timeout: 45000 }, (err) => {
      emit({ type: "stopped" });
      done(err || null);
    });
  }

  return {
    start,
    stop,
    accept,
    peers,
    state,
    isArmed: () => armed,
    isStreaming: () => !!(session && session.state.playing),
    fifoPath,
  };
}

module.exports = {
  create,
  parseState,
  peersFromLeases,
  pairingGate,
  PAIR_WINDOW_MS,
  STATE_FILE,
  RTSP_PORT,
  RTP_PORT,
  FIFO,
  UNIT,
};
