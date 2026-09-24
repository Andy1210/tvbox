// What an app's page may do to the shared mpv.
//
// This is a capability boundary and it has one exception, which is where the
// subtlety lives: the app that OWNS what is loaded may keep driving it after it
// leaves the screen, because a queue has to cross to its next track with nobody
// looking - but only for SOUND. Starting a picture from the background would take
// the output mode and the reveal from whatever is actually in front.
const test = require("node:test");
const assert = require("node:assert");

const playerapi = require("./playerapi");

function boot(opts) {
  const o = opts || {};
  const log = [];
  const state = {
    running: !!o.running,
    playing: o.playingUrl || null,
    owner: o.owner === undefined ? null : o.owner,
    audioOnly: !!o.audioOnly,
    pip: !!o.pip,
    pending: !!o.pending,
  };
  playerapi.init({
    player: {
      running: () => state.running,
      playing: () => state.playing,
      owner: () => state.owner,
      isAudioOnly: () => state.audioOnly,
      isPip: () => state.pip,
      startPending: () => state.pending,
      setOwner: (id) => (log.push(["setOwner", id]), (state.owner = id)),
      setPlaying: (u) => log.push(["setPlaying", u]),
      stop: () => log.push(["stop"]),
      cmd: (c) => log.push(["mpv", c.command.join(" ")]),
      launch: (url, pos, pip, rect, streams, o2) => log.push(["launch", url, pos, pip, (o2 || {}).audioOnly]),
      enqueue: (u) => (log.push(["enqueue", u]), { ok: true }),
      clearQueue: () => (log.push(["clearQueue"]), { ok: true }),
      query: () => Promise.resolve(o.tracks || []),
    },
    capsFor: (id) => (o.caps ? o.caps(id) : ["nav", "player"]),
    currentApp: () => (o.currentApp === undefined ? "plex" : o.currentApp),
    appWindow: (id) =>
      (o.windows || []).includes(id)
        ? { isDestroyed: () => false, webContents: { send: (c, p) => log.push(["send", id, c, p]) } }
        : null,
    setVideoMode: (on) => log.push(["video", on]),
    ensureAudio: (cb) => cb(),
    clearSoundWidget: (id) => log.push(["clearCard", id]),
  });
  // The queue is module state shared by every app; start each case from empty.
  playerapi.queued.url = null;
  playerapi.queued.startPos = 0;
  playerapi.queued.streams = null;
  playerapi.queued.kind = null;
  playerapi.queued.local = false;
  return { log, state };
}

const refused = (r) => r && r.ok === false && /not permitted/.test(r.error);

// ---- who may drive it ----

test("the foreground app with the capability may", () => {
  boot({ currentApp: "plex" });
  assert.deepEqual(playerapi.handle("plex", "pause"), { ok: true });
});

test("an app without the player capability may not, even in front", () => {
  boot({ currentApp: "plex", caps: () => ["nav"] });
  assert.ok(refused(playerapi.handle("plex", "pause")));
});

test("an unknown or stale sender may not", () => {
  boot({ currentApp: "plex" });
  assert.ok(refused(playerapi.handle(undefined, "pause")));
});

test("a backgrounded app that never played holds nothing", () => {
  boot({ currentApp: "plex", owner: null });
  assert.ok(refused(playerapi.handle("media", "pause")));
});

test("the app that OWNS what is loaded keeps driving it off screen", () => {
  const { log } = boot({ currentApp: null, owner: "media", running: true, audioOnly: true });
  assert.deepEqual(playerapi.handle("media", "pause"), { ok: true });
  assert.deepEqual(log[0], ["mpv", "set_property pause true"]);
});

test("...and NOT gated on the player still running - the gap between two tracks is exactly when mpv is gone", () => {
  boot({ currentApp: null, owner: "media", running: false });
  assert.deepEqual(playerapi.handle("media", "queue", { url: "http://h/next.mp3", kind: "audio" }), { ok: true });
});

test("the launcher is never a background owner", () => {
  // Its id is null, and it is the thing in front when it plays anything.
  boot({ currentApp: "plex", owner: null });
  assert.ok(refused(playerapi.handle(null, "pause")));
});

// ---- what a background owner may do: sound, and only sound ----

test("a background owner may queue sound", () => {
  boot({ currentApp: null, owner: "media" });
  assert.deepEqual(playerapi.handle("media", "queue", { url: "http://h/a.mp3", kind: "audio" }), { ok: true });
  assert.equal(playerapi.queued.kind, "audio");
});

test("a background owner may not queue a picture", () => {
  // `queued` is one object shared by every app, so what it writes here is what the
  // FOREGROUND app's next play launches.
  boot({ currentApp: null, owner: "media" });
  assert.ok(refused(playerapi.handle("media", "queue", { url: "http://h/film.mkv" })));
  assert.equal(playerapi.queued.url, null);
});

test("a background owner may not START a picture either", () => {
  const { log } = boot({ currentApp: "plex", owner: "media" });
  playerapi.handle("plex", "queue", { url: "http://h/film.mkv" }); // the foreground app staged a film
  assert.ok(refused(playerapi.handle("media", "play")));
  assert.equal(log.filter((l) => l[0] === "launch").length, 0);
});

test("a background owner may start sound", () => {
  const { log } = boot({ currentApp: null, owner: "media" });
  playerapi.handle("media", "queue", { url: "http://h/a.mp3", kind: "audio" });
  assert.deepEqual(playerapi.handle("media", "play"), { ok: true });
  assert.deepEqual(
    log.find((l) => l[0] === "launch"),
    ["launch", "http://h/a.mp3", 0, false, true],
  );
});

test("PiP is refused from the background outright - it relaunches WITH video", () => {
  boot({ currentApp: null, owner: "media", running: true, playingUrl: "http://h/a.mp3" });
  assert.ok(refused(playerapi.handle("media", "pip", { on: true })));
});

// ---- starting, resuming and taking the player ----

test("a play with the same url and kind resumes rather than relaunching", () => {
  const { log } = boot({ currentApp: "plex", running: true, playingUrl: "http://h/film.mkv", owner: "plex" });
  playerapi.handle("plex", "queue", { url: "http://h/film.mkv" });
  playerapi.handle("plex", "play");
  assert.deepEqual(
    log.filter((l) => l[0] === "launch"),
    [],
  );
  assert.ok(log.find((l) => l[0] === "mpv" && l[1] === "set_property pause false"));
});

test("the same file asked for as SOUND after being played as a picture is a fresh launch", () => {
  const { log } = boot({
    currentApp: "plex",
    running: true,
    playingUrl: "http://h/x.mkv",
    owner: "plex",
    audioOnly: false,
  });
  playerapi.handle("plex", "queue", { url: "http://h/x.mkv", kind: "audio" });
  playerapi.handle("plex", "play");
  assert.ok(
    log.find((l) => l[0] === "launch"),
    "audio skips the mode handshake and the reveal",
  );
});

test("a play during the start handshake is left to finish", () => {
  const { log } = boot({
    currentApp: "plex",
    running: true,
    playingUrl: "http://h/film.mkv",
    owner: "plex",
    pending: true,
  });
  playerapi.handle("plex", "queue", { url: "http://h/film.mkv" });
  playerapi.handle("plex", "play");
  assert.equal(
    log.filter((l) => l[1] === "set_property pause false").length,
    0,
    "unpausing would put the switch INSIDE playback",
  );
});

test("taking the player from another app tells THAT app, and takes its card down", () => {
  const { log } = boot({ currentApp: "livetv", owner: "media", running: true, windows: ["media"] });
  playerapi.handle("livetv", "queue", { url: "http://h/stream.ts" });
  playerapi.handle("livetv", "play");
  assert.deepEqual(
    log.find((l) => l[0] === "send"),
    ["send", "media", "player-event", { type: "finished", reason: "replaced" }],
  );
  assert.deepEqual(
    log.find((l) => l[0] === "clearCard"),
    ["clearCard", "media"],
  );
});

test("nothing is said when the player was not somebody else's", () => {
  const { log } = boot({ currentApp: "plex", owner: "plex", running: true, windows: ["plex"] });
  playerapi.handle("plex", "queue", { url: "http://h/a.mkv" });
  playerapi.handle("plex", "play");
  assert.equal(log.filter((l) => l[0] === "send").length, 0);
});

test("a play with nothing queued launches nothing", () => {
  const { log } = boot({ currentApp: "plex" });
  assert.deepEqual(playerapi.handle("plex", "play"), { ok: false, error: "nothing queued" });
  assert.equal(log.filter((l) => l[0] === "launch").length, 0);
});

test("a refused url does not take the player from the app that is playing", () => {
  const { log, state } = boot({
    currentApp: "livetv",
    owner: "music",
    running: true,
    playingUrl: "http://h/song.mp3",
    audioOnly: true,
    windows: ["music"],
  });
  assert.equal(playerapi.handle("livetv", "queue", { url: "http://127.0.0.1:8097/x" }).ok, false);
  assert.equal(playerapi.handle("livetv", "play").ok, false);
  assert.equal(state.owner, "music", "the music keeps its owner");
  assert.equal(log.filter((l) => l[0] === "setOwner" || l[0] === "send" || l[0] === "clearCard").length, 0);
  assert.equal(log.filter((l) => l[0] === "launch").length, 0);
});

// ---- the rest of the surface ----

test("stop, seek and the two pauses reach mpv", () => {
  const { log } = boot({ currentApp: "plex" });
  playerapi.handle("plex", "stop");
  playerapi.handle("plex", "seek", { posSec: 42 });
  playerapi.handle("plex", "resume");
  assert.ok(log.find((l) => l[0] === "stop"));
  assert.ok(log.find((l) => l[1] === "seek 42 absolute"));
  assert.ok(log.find((l) => l[1] === "set_property pause false"));
});

test("a track switch takes an id, `no` or `auto`, and nothing else", () => {
  const { log } = boot({ currentApp: "plex" });
  playerapi.handle("plex", "track", { type: "sub", id: 2 });
  playerapi.handle("plex", "track", { type: "audio", id: "no" });
  playerapi.handle("plex", "track", { type: "audio", id: "second one" });
  assert.deepEqual(
    log.filter((l) => l[0] === "mpv").map((l) => l[1]),
    ["set_property sid 2", "set_property aid no"],
  );
});

test("a property outside the allowlist is REPORTED, not swallowed", () => {
  boot({ currentApp: "plex" });
  const r = playerapi.handle("plex", "prop", { name: "input-ipc-server", value: "/tmp/x" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not allowed/);
});

test("a stream selection is remembered as well as applied - PiP relaunches from it", () => {
  boot({ currentApp: "plex" });
  playerapi.handle("plex", "queue", { url: "http://h/f.mkv", streams: { audio: 0, sub: 1 } });
  playerapi.handle("plex", "select", { sub: -1 });
  assert.equal(
    playerapi.queued.streams.audio,
    0,
    "a call that changes only the subtitle must not clear the audio choice",
  );
  assert.equal(playerapi.queued.streams.sub, -1);
});

test("the track list is filtered to audio and subtitles", async () => {
  boot({
    currentApp: "plex",
    tracks: [
      { type: "video", id: 1 },
      { type: "audio", id: 2, lang: "hu", selected: true },
      { type: "sub", id: 3 },
    ],
  });
  const r = await playerapi.handle("plex", "tracks");
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.tracks.map((t) => t.id),
    [2, 3],
  );
});

test("enqueue and queueclear pass straight through", () => {
  const { log } = boot({ currentApp: "plex" });
  playerapi.handle("plex", "enqueue", { urls: ["b.mp3"] });
  playerapi.handle("plex", "queueclear");
  assert.ok(log.find((l) => l[0] === "enqueue"));
  assert.ok(log.find((l) => l[0] === "clearQueue"));
});

test("an unknown action is not an error - it simply does nothing", () => {
  const { log } = boot({ currentApp: "plex" });
  assert.deepEqual(playerapi.handle("plex", "teleport"), { ok: true });
  assert.equal(log.filter((l) => l[0] === "mpv").length, 0);
});

test("the log records where a stream plays FROM, never the url", () => {
  // An IPTV url carries its username and password as PATH segments, and this log
  // is what tvbox-diag copies onto the boot partition.
  const said = [];
  const realLog = console.log;
  console.log = (...a) => said.push(a.join(" "));
  try {
    boot({ currentApp: "plex" });
    playerapi.handle("plex", "queue", { url: "http://host/user/pass/stream.ts" });
  } finally {
    console.log = realLog;
  }
  assert.ok(said.some((l) => l.includes("http://host")));
  assert.equal(
    said.some((l) => l.includes("pass")),
    false,
  );
});

test("only network streams and absolute paths may be queued", () => {
  for (const ok of ["http://h/a.mkv", "https://h/a", "rtsp://cam/1", "udp://239.0.0.1:1234", "/media/stick/a.mkv"])
    assert.ok(playerapi.queueTarget(ok), ok);
  for (const bad of ["file:///etc/passwd", "av://v4l2:/dev/video0", "lavfi://sine", "relative.mkv", "", null])
    assert.strictEqual(playerapi.queueTarget(bad), null, String(bad));
  boot();
  assert.deepEqual(playerapi.handle("plex", "queue", { url: "file:///etc/passwd" }), {
    ok: false,
    error: "not a playable url",
  });
});

test("a local path is launched only once the shell has placed it inside a root", () => {
  const { log } = boot();
  const asked = [];
  let answer;
  playerapi.init({
    localFile: (p, cb) => {
      asked.push(p);
      answer = cb;
    },
  });
  playerapi.handle("plex", "queue", { url: "/media/stick/../x.mkv" });
  playerapi.handle("plex", "play");
  assert.deepEqual(asked, ["/media/stick/../x.mkv"]);
  assert.ok(!log.some((l) => l[0] === "launch"), "nothing starts before the answer");
  answer({ ok: true, path: "/media/x.mkv" });
  assert.ok(log.some((l) => l[0] === "launch" && l[1] === "/media/x.mkv"));
});

test("a sidecar subtitle has to be a network URL", () => {
  const { log } = boot();
  playerapi.handle("plex", "queue", { url: "http://h/a.mkv", streams: { sub: 0, subFile: "file:///etc/shadow" } });
  assert.strictEqual(playerapi.queued.streams.subFile, undefined);
  assert.strictEqual(playerapi.queued.streams.sub, 0);
  assert.ok(log);
});

test("a stream aimed at the box itself is refused, since mpv would fetch it as the box", () => {
  const os = require("os");
  for (const bad of [
    "http://127.0.0.1:8097/tvbox/api/tv/standby",
    "http://localhost:8097/x",
    "http://[::1]:8097/x",
    "http://[::ffff:127.0.0.1]:8097/x",
    "http://0.0.0.0:8099/",
    "http://" + os.hostname().toLowerCase() + ".local:8100/",
  ])
    assert.strictEqual(playerapi.queueTarget(bad), null, bad);
  assert.strictEqual(playerapi.queueTarget("http://media.example/a.mkv"), "net");
});

test("a refused url empties the queue, so the next play launches nothing stale", () => {
  const { log } = boot();
  playerapi.handle("plex", "queue", { url: "http://media.example/a.mkv" });
  assert.deepEqual(playerapi.handle("plex", "queue", { url: "http://127.0.0.1:8097/x" }), {
    ok: false,
    error: "not a playable url",
  });
  playerapi.handle("plex", "play");
  assert.ok(!log.some((l) => l[0] === "launch"), "the earlier item must not start");
  assert.strictEqual(playerapi.queued.url, null);
});
