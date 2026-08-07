// The Miracast negotiation, replayed from a real one.
//
// Every message a source sends below was captured from a Galaxy S26 Ultra
// (`server: AllShareCast/Galaxy/Android16`) mirroring to a Pi 5 on 2026-08-07,
// so this is not a guess at the protocol - it is the exchange that worked, and
// the assertions are what our side actually has to put on the wire.
const test = require("node:test");
const assert = require("node:assert");

const wfd = require("./wfd");

// Content-Length has to be right or the far end waits forever for a body that
// already arrived, so the fixtures compute it rather than repeat it.
function msg(start, headers, body) {
  let text = start + "\r\n";
  for (const [k, v] of Object.entries(headers || {})) text += k + ": " + v + "\r\n";
  if (body) text += "Content-Type: text/parameters\r\nContent-Length: " + body.length + "\r\n";
  return text + "\r\n" + (body || "");
}

const M1 = msg("OPTIONS * RTSP/1.0", {
  CSeq: 1,
  server: "AllShareCast/Galaxy/Android16",
  require: "org.wfa.wfd1.0",
});

const M2_REPLY = msg("RTSP/1.0 200 OK", {
  CSeq: 101,
  public: "org.wfa.wfd1.0, SETUP, TEARDOWN, PLAY, PAUSE, GET_PARAMETER, SET_PARAMETER",
});

// The five wfd_sec_* names are Samsung's own extensions, and they are the reason
// this test exists: leaving them out of the reply made the phone close the
// session immediately after M3, with no error on either side.
const M3_NAMES = [
  "wfd_video_formats",
  "wfd_audio_codecs",
  "wfd_uibc_capability",
  "wfd_client_rtp_ports",
  "wfd_content_protection",
  "wfd_sec_screensharing",
  "wfd_sec_portrait_display",
  "wfd_sec_rotation",
  "wfd_sec_hw_rotation",
  "wfd_sec_framerate",
];
const M3 = msg("GET_PARAMETER rtsp://localhost/wfd1.0 RTSP/1.0", { CSeq: 2 }, M3_NAMES.join("\r\n") + "\r\n");

const M4 = msg(
  "SET_PARAMETER rtsp://localhost/wfd1.0 RTSP/1.0",
  { CSeq: 3 },
  [
    // What the phone PICKED out of what we offered: CEA bit 7 is 1920x1080p30.
    "wfd_video_formats: 00 00 02 04 00000080 00000000 00000000 00 0000 0000 00 none none",
    "wfd_audio_codecs: AAC 00000001 00",
    "wfd_presentation_URL: rtsp://192.168.49.14/wfd1.0/streamid=0 none",
    "wfd_client_rtp_ports: RTP/AVP/UDP;unicast 1028 0 mode=play",
  ].join("\r\n") + "\r\n",
);

const M5 = msg("SET_PARAMETER rtsp://localhost/wfd1.0 RTSP/1.0", { CSeq: 4 }, "wfd_trigger_method: SETUP\r\n");

const SETUP_REPLY = msg("RTSP/1.0 200 OK", {
  CSeq: 102,
  session: "1804289383;timeout=30",
  transport: "RTP/AVP/UDP;unicast;client_port=1028-1029;server_port=19000-19001",
});

const PLAY_REPLY = msg("RTSP/1.0 200 OK", { CSeq: 103, session: "1804289383;timeout=30", range: "npt=now-" });

test("the captured negotiation, start to playing", () => {
  const s = wfd.createSession({ sourceIp: "192.168.49.14" });

  const afterM1 = s.feed(M1);
  assert.strictEqual(afterM1.length, 2, "M1 is answered AND M2 asked straight back");
  assert.match(afterM1[0], /^RTSP\/1\.0 200 OK\r\nCSeq: 1\r\n/);
  assert.match(afterM1[0], /Public: org\.wfa\.wfd1\.0/);
  assert.match(afterM1[1], /^OPTIONS \* RTSP\/1\.0\r\nCSeq: 101\r\nRequire: org\.wfa\.wfd1\.0/);

  assert.deepStrictEqual(s.feed(M2_REPLY), [], "a plain response needs nothing back");

  const afterM3 = s.feed(M3);
  assert.strictEqual(afterM3.length, 1);
  const body = afterM3[0].split("\r\n\r\n")[1];
  for (const name of M3_NAMES) {
    assert.match(body, new RegExp("^" + name + ": .+$", "m"), name + " must be answered, even if only with none");
  }
  assert.match(body, /wfd_sec_rotation: none/, "an extension we do not implement still gets a value");
  assert.match(body, /wfd_client_rtp_ports: RTP\/AVP\/UDP;unicast 1028 0 mode=play/);
  const declared = parseInt(/Content-Length: (\d+)/.exec(afterM3[0])[1], 10);
  assert.strictEqual(declared, body.length, "a wrong Content-Length hangs the far end");

  assert.deepStrictEqual(s.feed(M4), [msgOk(3)], "M4 is just acknowledged");
  assert.strictEqual(s.state.url, "rtsp://192.168.49.14/wfd1.0/streamid=0", "M4 carries the URL to SETUP");
  assert.match(s.state.format, /00000080/, "and what it chose is worth keeping for the player");

  const afterM5 = s.feed(M5);
  assert.strictEqual(afterM5.length, 2, "the trigger is acknowledged, then we SETUP");
  assert.match(afterM5[1], /^SETUP rtsp:\/\/192\.168\.49\.14\/wfd1\.0\/streamid=0 RTSP\/1\.0/);
  assert.match(afterM5[1], /Transport: RTP\/AVP\/UDP;unicast;client_port=1028/);

  const afterSetup = s.feed(SETUP_REPLY);
  assert.strictEqual(afterSetup.length, 1);
  assert.match(afterSetup[0], /^PLAY rtsp:\/\/192\.168\.49\.14\/wfd1\.0\/streamid=0/);
  assert.match(afterSetup[0], /Session: 1804289383/, "the session id must come back on every later request");
  assert.strictEqual(s.state.playing, false, "not until the source says so");

  assert.deepStrictEqual(s.feed(PLAY_REPLY), []);
  assert.strictEqual(s.state.playing, true);
  assert.strictEqual(s.state.session, "1804289383");
});

function msgOk(cseq) {
  return "RTSP/1.0 200 OK\r\nCSeq: " + cseq + "\r\n\r\n";
}

test("a source that asks for something unknown gets a value, not a gap", () => {
  const s = wfd.createSession({ sourceIp: "10.0.0.1" });
  s.feed(M1);
  const out = s.feed(msg("GET_PARAMETER rtsp://x RTSP/1.0", { CSeq: 9 }, "wfd_invented_by_a_vendor\r\n"));
  assert.match(out[0], /wfd_invented_by_a_vendor: none/);
});

test("an empty GET_PARAMETER is a keepalive and gets a bare 200", () => {
  const s = wfd.createSession({ sourceIp: "10.0.0.1" });
  const out = s.feed(msg("GET_PARAMETER rtsp://x RTSP/1.0", { CSeq: 7 }, ""));
  assert.deepStrictEqual(out, [msgOk(7)]);
});

test("messages that arrive split, or several at once, are handled the same", () => {
  const split = wfd.createSession({ sourceIp: "192.168.49.14" });
  const half = Math.floor(M1.length / 2);
  assert.deepStrictEqual(split.feed(M1.slice(0, half)), [], "half a message is not a message");
  assert.strictEqual(split.feed(M1.slice(half)).length, 2);

  const coalesced = wfd.createSession({ sourceIp: "192.168.49.14" });
  coalesced.feed(M1);
  coalesced.feed(M2_REPLY);
  const out = coalesced.feed(M4 + M5); // TCP is a stream; two messages can share a read
  assert.strictEqual(out.length, 3, "both acknowledged, plus the SETUP the trigger asked for");
  assert.match(out[2], /^SETUP /);
});

test("a teardown ends the session rather than being acknowledged into nothing", () => {
  const s = wfd.createSession({ sourceIp: "10.0.0.1" });
  s.feed(M1);
  s.feed(msg("TEARDOWN rtsp://x RTSP/1.0", { CSeq: 5 }));
  assert.strictEqual(s.state.torndown, true);
  assert.strictEqual(s.state.playing, false);
});

test("we never SETUP before we know where to", () => {
  const s = wfd.createSession({}); // no source IP, no M4 yet
  s.feed(M1);
  const out = s.feed(M5);
  assert.strictEqual(out.length, 1, "acknowledged, but there is no URL to set up");
});

test("the RTP header is read, not assumed to be twelve bytes", () => {
  const payload = Buffer.from("plain transport stream");

  const plain = Buffer.concat([Buffer.from([0x80, 0x21, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]), payload]);
  assert.deepStrictEqual(wfd.rtpPayload(plain), payload);

  // Two CSRCs: four bytes each, after the fixed header.
  const csrc = Buffer.concat([Buffer.from([0x82, 0x21, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(8), payload]);
  assert.deepStrictEqual(wfd.rtpPayload(csrc), payload);

  // Extension: a 4-byte header declaring one 32-bit word of extension data.
  const ext = Buffer.concat([
    Buffer.from([0x90, 0x21, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0xbe, 0xde, 0x00, 0x01]),
    Buffer.alloc(4),
    payload,
  ]);
  assert.deepStrictEqual(wfd.rtpPayload(ext), payload);

  // Padding: the last byte counts the padding, itself included.
  const padded = Buffer.concat([
    Buffer.from([0xa0, 0x21, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
    payload,
    Buffer.from([0, 0, 3]),
  ]);
  assert.deepStrictEqual(wfd.rtpPayload(padded), payload);

  assert.strictEqual(wfd.rtpPayload(Buffer.alloc(4)), null, "a runt packet is not a frame");
  assert.strictEqual(wfd.rtpPayload(Buffer.alloc(20)), null, "and neither is RTP version 0");
});

test("a parameter name that is really a prototype member gets none, not a function", () => {
  // `caps[name]` would reach Object.prototype, and the peer asking is
  // unauthenticated - push-button admits whoever presses it - so a source could
  // ask for "constructor" and be handed a function's source as a value.
  const s = wfd.createSession({ sourceIp: "10.0.0.1" });
  s.feed(M1);
  const out = s.feed(
    msg("GET_PARAMETER rtsp://x RTSP/1.0", { CSeq: 9 }, "constructor\r\ntoString\r\nvalueOf\r\n__proto__\r\n"),
  );
  const body = out[0].split("\r\n\r\n")[1];
  for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
    assert.match(body, new RegExp("^" + name.replace(/[_$]/g, "\\$&") + ": none$", "m"), name);
  }
  assert.strictEqual(/function|\[native code\]/.test(body), false, "nothing from the prototype leaks into the reply");
});

test("a peer that never finishes a message is dropped rather than buffered", () => {
  // Unauthenticated again, and the buffer only releases on a complete message:
  // a source that omits the header terminator, or declares a Content-Length it
  // never sends, would grow it without limit.
  const s = wfd.createSession({ sourceIp: "10.0.0.1" });
  const out = s.feed("OPTIONS * RTSP/1.0\r\nCSeq: 1\r\nX: " + "A".repeat(70000));
  assert.deepStrictEqual(out, [], "nothing is answered");
  assert.strictEqual(s.state.torndown, true, "and the caller is told to hang up");
  assert.strictEqual(s.state.buffer.length, 0, "the buffer does not keep it either");
});

test("what we advertise stays inside what this box can actually decode", () => {
  const caps = wfd.createSession({}).caps;
  // CEA bit 8 is 1920x1080p60. The Pi 5 decodes H.264 on the CPU - it kept only
  // a HEVC decoder - so offering 60 fps invites twice the load for a phone screen.
  const cea = caps.wfd_video_formats.split(" ")[4];
  assert.strictEqual((parseInt(cea, 16) & 0x100) === 0, true, "1080p60 must stay out of the CEA bitmap");
  assert.strictEqual(caps.wfd_video_formats.split(" ").length, 13, "all thirteen fields, or the source rejects it");
});
