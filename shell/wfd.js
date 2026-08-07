// The Miracast (Wi-Fi Display) RTSP dialect, as a pure state machine.
//
// No sockets here on purpose: every message this exchanges was captured from a
// real Galaxy source, so the whole negotiation is testable by feeding those
// bytes in and asserting the bytes out. The transport lives in miracast.js.
//
// **The sink dials the source.** This is the single most misleading thing about
// the protocol: the receiver opens the TCP connection to the sender's port 7236,
// not the other way round. Get it backwards and there is no error anywhere - the
// phone joins the group, takes a DHCP lease, sits silent for thirty seconds and
// leaves, and nothing in any log says it was waiting for a connection.
//
// Once connected the SOURCE drives, and the message numbers below are the
// spec's: M1/M2 capability probes both ways, M3 asks what we can decode, M4 tells
// us what it picked, M5 tells us to set the stream up, and M6/M7 are ours to
// send. After that RTP arrives on the UDP port we named in M3.

// What we tell a source we can receive.
//
// The CEA bitmap is the full set minus bit 8 (1920x1080p60). The Pi 5 has no
// hardware H.264 decoder at all - it kept only HEVC - and Miracast mandates
// H.264, so every frame is decoded on the CPU. Measured on a real capture that
// is 15.5x realtime at 1080p30, about a fifth of one core, and there is no
// reason to invite twice that for a mirrored phone screen.
//
// Thirteen fields, not the ten some implementations send: frame-rate-control
// support is mandatory and max-hres/max-vres close the list.
const DEFAULT_CAPS = {
  wfd_video_formats: "00 00 02 10 0001FEFF 3FFFFFFF 00000FFF 00 0000 0000 11 none none",
  wfd_audio_codecs: "AAC 00000001 00",
  wfd_uibc_capability: "none",
  wfd_content_protection: "none",
  wfd_connector_type: "05",
  wfd_display_edid: "none",
  wfd_coupled_sink: "none",
  wfd_standby_resume_capability: "none",
  wfd_I2C: "none",
};

// Our own requests are numbered from here, well clear of the source's sequence.
const FIRST_LOCAL_CSEQ = 100;

// Split an RTSP message off the front of a buffer, or answer null when the
// buffer does not hold a whole one yet. RTSP frames like HTTP: a start line,
// headers, a blank line, then Content-Length bytes of body.
function parseMessage(text) {
  const headEnd = text.indexOf("\r\n\r\n");
  if (headEnd < 0) return null;
  const lines = text.slice(0, headEnd).split("\r\n");
  const headers = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  const length = parseInt(headers["content-length"] || "0", 10) || 0;
  const bodyStart = headEnd + 4;
  if (text.length < bodyStart + length) return null; // body still arriving
  return {
    message: {
      start: lines[0] || "",
      headers,
      body: text.slice(bodyStart, bodyStart + length),
    },
    rest: text.slice(bodyStart + length),
  };
}

function isResponse(message) {
  return message.start.startsWith("RTSP/");
}

function methodOf(message) {
  return message.start.split(" ")[0] || "";
}

// The body of a parameter message is `name: value` lines - except in M3, where a
// source lists bare parameter NAMES it wants the values of.
function parameterNames(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.split(":")[0].trim())
    .filter(Boolean);
}

function parameters(body) {
  const out = {};
  for (const line of body.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

function response(status, cseq, extra, body) {
  let text = "RTSP/1.0 " + status + "\r\nCSeq: " + cseq + "\r\n";
  for (const [k, v] of Object.entries(extra || {})) text += k + ": " + v + "\r\n";
  if (body) {
    text += "Content-Type: text/parameters\r\nContent-Length: " + body.length + "\r\n";
  }
  return text + "\r\n" + (body || "");
}

function request(line, cseq, extra) {
  let text = line + "\r\nCSeq: " + cseq + "\r\n";
  for (const [k, v] of Object.entries(extra || {})) text += k + ": " + v + "\r\n";
  return text + "\r\n";
}

/**
 * One negotiation with one source.
 *
 * `feed(text)` takes whatever arrived on the socket and returns the strings to
 * write back, in order. Everything else it learned is on the object: `session`,
 * `url`, `format`, and `playing` once the source has acknowledged PLAY.
 *
 * @param {object} opts
 * @param {object} [opts.caps]    what we claim to receive; DEFAULT_CAPS otherwise
 * @param {number} [opts.rtpPort] UDP port we want the stream on
 * @param {string} [opts.sourceIp] used to build the presentation URL until M4 gives us one
 * @param {function} [opts.log]
 */
function createSession(opts) {
  const o = opts || {};
  const caps = Object.assign({}, DEFAULT_CAPS, o.caps || {});
  const rtpPort = o.rtpPort || 1028;
  const log = o.log || (() => {});
  caps.wfd_client_rtp_ports = "RTP/AVP/UDP;unicast " + rtpPort + " 0 mode=play";

  const state = {
    session: null,
    url: o.sourceIp ? "rtsp://" + o.sourceIp + "/wfd1.0/streamid=0" : null,
    format: null,
    playing: false,
    torndown: false,
    cseq: FIRST_LOCAL_CSEQ,
    greeted: false,
    buffer: "",
  };

  function nextCseq() {
    return ++state.cseq;
  }

  function onRequest(message, out) {
    const method = methodOf(message);
    const cseq = message.headers.cseq || "0";

    if (method === "OPTIONS") {
      out.push(response("200 OK", cseq, { Public: "org.wfa.wfd1.0, GET_PARAMETER, SET_PARAMETER" }));
      // M2: the source expects us to ask the same question straight back, once.
      if (!state.greeted) {
        state.greeted = true;
        out.push(request("OPTIONS * RTSP/1.0", nextCseq(), { Require: "org.wfa.wfd1.0" }));
      }
      return;
    }

    if (method === "GET_PARAMETER") {
      const wanted = parameterNames(message.body);
      // An empty GET_PARAMETER is a keepalive, not a question.
      if (!wanted.length) return out.push(response("200 OK", cseq));
      // Answer EVERY name asked, in the order asked, and say "none" to the ones
      // we do not implement. A Galaxy source asks for five wfd_sec_* extensions
      // of its own and closes the session without a word if they are missing
      // from the reply - measured, and it looks exactly like a rejected format.
      const body = wanted.map((name) => name + ": " + (caps[name] || "none")).join("\r\n") + "\r\n";
      return out.push(response("200 OK", cseq, null, body));
    }

    if (method === "SET_PARAMETER") {
      out.push(response("200 OK", cseq));
      const params = parameters(message.body);
      if (params.wfd_presentation_URL) {
        const url = params.wfd_presentation_URL.split(/\s+/)[0];
        if (url.startsWith("rtsp://")) {
          state.url = url;
          log("presentation URL", url);
        }
      }
      if (params.wfd_video_formats) state.format = params.wfd_video_formats;
      // M5. The source does not set the stream up itself; it asks us to.
      if ((params.wfd_trigger_method || "").toUpperCase() === "SETUP" && state.url) {
        out.push(
          request("SETUP " + state.url + " RTSP/1.0", nextCseq(), {
            Transport: "RTP/AVP/UDP;unicast;client_port=" + rtpPort,
          }),
        );
      }
      if ((params.wfd_trigger_method || "").toUpperCase() === "TEARDOWN") {
        state.torndown = true;
      }
      return;
    }

    if (method === "TEARDOWN") {
      state.torndown = true;
      state.playing = false;
      return out.push(response("200 OK", cseq));
    }

    // Anything else: acknowledge rather than stall the negotiation.
    out.push(response("200 OK", cseq));
  }

  function onResponse(message, out) {
    const session = message.headers.session;
    if (!session) return;
    const id = session.split(";")[0].trim();
    if (!state.session) {
      // The SETUP came back: the stream exists, so start it.
      state.session = id;
      out.push(request("PLAY " + state.url + " RTSP/1.0", nextCseq(), { Session: id }));
      return;
    }
    // The PLAY came back. Frames are on their way to the UDP port.
    if (!state.playing) {
      state.playing = true;
      log("playing, session", id);
    }
  }

  return {
    state,
    caps,
    /** Bytes in, bytes out. Handles partial and coalesced messages. */
    feed(text) {
      state.buffer += text;
      const out = [];
      for (;;) {
        const parsed = parseMessage(state.buffer);
        if (!parsed) break;
        state.buffer = parsed.rest;
        const message = parsed.message;
        log("<<<", message.start);
        if (isResponse(message)) onResponse(message, out);
        else onRequest(message, out);
      }
      return out;
    },
    /** An empty GET_PARAMETER, which is how this protocol says "still here". */
    keepalive() {
      return request("GET_PARAMETER " + (state.url || "rtsp://localhost/wfd1.0") + " RTSP/1.0", nextCseq(), {
        Session: state.session || "",
      });
    },
    teardown() {
      state.torndown = true;
      return request("TEARDOWN " + (state.url || "rtsp://localhost/wfd1.0") + " RTSP/1.0", nextCseq(), {
        Session: state.session || "",
      });
    },
  };
}

// An RTP packet carrying MPEG-TS: a fixed 12-byte header, then the payload,
// plus 4 bytes per CSRC and a header extension when either is flagged. Real
// sources send neither, but a stream that silently loses its first bytes is
// impossible to diagnose from the far end, so this reads the header properly.
function rtpPayload(packet) {
  if (!packet || packet.length < 12) return null;
  const version = packet[0] >> 6;
  if (version !== 2) return null;
  let offset = 12 + (packet[0] & 0x0f) * 4; // CSRC count
  if (packet[0] & 0x10) {
    // extension: 2 bytes profile, 2 bytes length in 32-bit words
    if (packet.length < offset + 4) return null;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  if (packet.length <= offset) return null;
  let end = packet.length;
  if (packet[0] & 0x20) {
    // padding: the last byte counts the padding bytes, itself included
    const pad = packet[end - 1];
    if (!pad || pad > end - offset) return null;
    end -= pad;
  }
  return packet.subarray(offset, end);
}

module.exports = {
  DEFAULT_CAPS,
  parseMessage,
  parameterNames,
  parameters,
  isResponse,
  methodOf,
  createSession,
  rtpPayload,
};
