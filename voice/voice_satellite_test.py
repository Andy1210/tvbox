#!/usr/bin/env python3
"""Offline tests for the satellite's session and run handling.

Run: python3 voice/voice_satellite_test.py

No remote, no Home Assistant and no audio device: what is covered here is the
bookkeeping that decides whether a run is opened at all and who owns the single
connection, which is where a stuck pipeline and a locked-out Home Assistant both
come from. The microphone and the decoder need real hardware and are not touched.
"""
import asyncio
import contextlib
import fcntl
import json
import os
import queue
import subprocess
import sys
import threading
import urllib.request
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voice_satellite as vs  # noqa: E402

# duck 1.0 and a toast-only answer keep the player away from wpctl and pw-cat.
CONFIG = {
    "enabled": True,
    "port": 10700,
    "name": "test-box",
    "area": "",
    "pipeline": None,
    "duck": 1.0,
    "answer": "toast",
}

HA = "192.168.1.19"
FRAME = b"\x00\x00" * vs.FRAME_SAMPLES

# Nothing in this suite may reach the shell. Several tests drive a `synthesize`
# without caring about the note, and the real `show_toast` POSTs to loopback -
# harmless on a dev host, but on a BOX it draws the test's text on the
# television, and the note now outlives the test that queued it. The tests that
# are about notes replace this again with something of their own.
DRAWN = []
_real_show_toast = vs.show_toast   # kept so one test can still exercise the HTTP path
vs.show_toast = DRAWN.append


class FakeWriter:
    def __init__(self, host=HA):
        self.host = host
        self.closed = False

    def get_extra_info(self, name):
        if name == "peername":
            return (self.host, 40000)
        return None  # no socket, so keepalive is a no-op

    def close(self):
        self.closed = True


class BlockingReader:
    """A peer that has stopped talking without closing."""

    async def readline(self):
        await asyncio.Event().wait()


class ScriptedReader:
    """Lines held back until the test releases them, then silence."""

    def __init__(self, lines):
        self._lines = list(lines)
        self._gate = asyncio.Event()

    def deliver(self):
        self._gate.set()

    async def readline(self):
        await self._gate.wait()
        if self._lines:
            return self._lines.pop(0)
        await asyncio.Event().wait()


def sent(satellite):
    """The event types queued so far, oldest first."""
    out = []
    while not satellite._out.empty():
        out.append(satellite._out.get_nowait()[0])
    return out


def connected(answer="toast"):
    satellite = vs.Satellite({**CONFIG, "answer": answer})
    writer = FakeWriter()
    satellite.writer = writer
    satellite._peer_host = HA
    return satellite, writer


async def stop(*tasks):
    for task in tasks:
        task.cancel()
    for task in tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await task


@contextlib.asynccontextmanager
async def watchdog_running(satellite, interval=0.01):
    """The watchdog, ticking fast enough for a test and put back afterwards."""
    was = vs.WATCHDOG_INTERVAL
    vs.WATCHDOG_INTERVAL = interval
    task = asyncio.create_task(satellite.watchdog())
    try:
        yield task
    finally:
        await stop(task)
        vs.WATCHDOG_INTERVAL = was


async def test_a_tap_with_no_audio_starts_nothing():
    satellite, _ = connected()
    satellite.on_press()
    satellite.on_release()
    assert sent(satellite) == [], "a press that produced no frame must not open a run"
    assert satellite._awaiting_since is None, "nothing was asked, so nothing is owed"


async def test_audio_opens_one_run_and_closes_it():
    satellite, _ = connected()
    satellite.on_press()
    satellite.on_audio(FRAME)
    satellite.on_audio(FRAME)
    satellite.on_release()
    assert sent(satellite) == [
        "run-pipeline",
        "audio-start",
        "audio-chunk",
        "audio-chunk",
        "audio-stop",
    ]
    assert satellite._run_open is False
    assert satellite._awaiting_since is not None, "the answer is owed from audio-stop"


async def test_a_run_cut_short_by_a_lost_connection_sends_no_stop():
    satellite, _ = connected()
    satellite.on_press()
    satellite.on_audio(FRAME)
    satellite._end_session()  # Home Assistant went away mid-sentence
    sent(satellite)
    satellite.on_release()
    assert sent(satellite) == [], "there is nobody left to send audio-stop to"


async def test_a_second_press_opens_a_second_run():
    satellite, _ = connected()
    for _ in range(2):
        satellite.on_press()
        satellite.on_audio(FRAME)
        satellite.on_release()
    assert sent(satellite).count("run-pipeline") == 2


async def test_home_assistant_reconnecting_takes_the_session_over():
    satellite, stale = connected()
    fresh = FakeWriter()
    task = asyncio.create_task(satellite.handle_client(BlockingReader(), fresh))
    for _ in range(5):
        await asyncio.sleep(0)
    assert stale.closed, "the connection that stopped answering must be dropped"
    assert satellite.writer is fresh, "the reconnect must own the session"
    await stop(task)


async def test_a_stranger_is_still_refused():
    satellite, held = connected()
    stranger = FakeWriter(host="192.168.1.99")
    await satellite.handle_client(BlockingReader(), stranger)
    assert stranger.closed
    assert satellite.writer is held, "an unknown address may not take the microphone"


async def test_the_takeover_leaves_the_new_connection_usable():
    """The displaced handler must not tear down the session it no longer owns."""
    satellite, stale = connected()
    fresh = FakeWriter()
    stale_task = asyncio.create_task(satellite.handle_client(BlockingReader(), stale))
    await asyncio.sleep(0)
    # Give the stale connection the session, then let a reconnect displace it.
    satellite.writer = stale
    fresh_task = asyncio.create_task(satellite.handle_client(BlockingReader(), fresh))
    for _ in range(10):
        await asyncio.sleep(0)
    assert satellite.writer is fresh
    satellite.on_press()
    satellite.on_audio(FRAME)
    assert sent(satellite)[:2] == ["run-pipeline", "audio-start"]
    await stop(stale_task, fresh_task)


async def test_a_fresh_connection_inherits_no_debt():
    """An expired debt from a lost run must not cut the reconnect down at once."""
    satellite, _ = connected()
    satellite.writer = None  # the previous connection went away mid-run
    satellite._run_open = True
    satellite._awaiting_since = time.monotonic() - vs.RUN_TIMEOUT - 1
    fresh = FakeWriter()
    task = asyncio.create_task(satellite.handle_client(BlockingReader(), fresh))
    for _ in range(5):
        await asyncio.sleep(0)
    assert satellite._awaiting_since is None
    assert satellite._run_open is False
    async with watchdog_running(satellite):
        await asyncio.sleep(0.05)
        assert satellite.writer is fresh, "the reconnect must survive the old run's debt"
    await stop(task)


async def test_the_watchdog_drops_a_run_that_is_never_answered():
    satellite, writer = connected()
    satellite._awaiting_since = time.monotonic() - vs.RUN_TIMEOUT - 1
    async with watchdog_running(satellite):
        await asyncio.sleep(0.05)
    assert satellite.writer is None, "a run nobody answers must not hold the session"
    assert writer.closed


async def test_a_liveness_event_does_not_pay_the_debt():
    """The failure this exists for: a pipeline that talks but never delivers.

    Measured on tvbox-livingroom, 2026-08-11: Home Assistant answered every press
    with `transcribe` and delivered no transcript for an hour. Each of those events
    cleared the debt, so the watchdog never reached RUN_TIMEOUT and the dead run
    kept the session.
    """
    satellite, writer = connected()
    owed = time.monotonic() - vs.RUN_TIMEOUT - 1
    for etype in ("transcribe", "voice-started", "voice-stopped", "ping", "run-satellite"):
        satellite._awaiting_since = owed
        await satellite._on_event({"type": etype, "data": {}}, b"")
        assert satellite._awaiting_since == owed, f"{etype} must not clear the debt"
    async with watchdog_running(satellite):
        await asyncio.sleep(0.05)
    assert satellite.writer is None, "a run that only gets chatter must not hold the session"
    assert writer.closed


async def test_real_output_pays_the_debt():
    """Anything Home Assistant actually produced means the run advanced."""
    for etype in sorted(vs.PROGRESS_EVENTS):
        satellite, writer = connected()
        satellite._awaiting_since = time.monotonic() - vs.RUN_TIMEOUT - 1
        # Read off PROGRESS_EVENTS rather than listed here: a name added there
        # without a test is exactly the regression this is meant to catch.
        payload = b"\x00\x00" if etype == "audio-chunk" else b""
        await satellite._on_event({"type": etype, "data": {"text": "x", "rate": 16000}}, payload)
        assert satellite._awaiting_since is None, f"{etype} must clear the debt"
        async with watchdog_running(satellite):
            await asyncio.sleep(0.05)
        assert satellite.writer is writer, f"{etype} means the run is alive"
        assert not writer.closed


async def test_the_watchdog_leaves_a_run_in_progress_alone():
    satellite, writer = connected()
    satellite._awaiting_since = time.monotonic()
    async with watchdog_running(satellite):
        await asyncio.sleep(0.05)
    assert satellite.writer is writer
    assert not writer.closed


async def test_ending_a_session_drops_what_it_had_queued():
    """The writer task may not run before a replacement connection arrives."""
    satellite, _ = connected()
    satellite.on_press()
    satellite.on_audio(FRAME)
    assert not satellite._out.empty()
    satellite._end_session()
    assert satellite._out.empty(), "a reconnect must not be handed the old run's audio"


async def test_a_displaced_handler_stops_acting_on_its_events():
    """An event buffered before the takeover must not reach the new session."""
    satellite = vs.Satellite(CONFIG)
    stale, fresh = FakeWriter(), FakeWriter()
    reader = ScriptedReader([b'{"type": "describe"}\n'])
    task = asyncio.create_task(satellite.handle_client(reader, stale))
    for _ in range(5):
        await asyncio.sleep(0)
    assert satellite.writer is stale
    satellite.writer = fresh  # a reconnect took the session mid-read
    reader.deliver()
    for _ in range(5):
        await asyncio.sleep(0)
    await stop(task)
    assert sent(satellite) == [], "the displaced handler must answer nothing"
    assert satellite.writer is fresh


def stop_reading(satellite):
    """Fill the outbound queue, as a peer that stopped reading would."""
    while not satellite._out.full():
        satellite._out.put_nowait(("audio-chunk", None, b""))


async def test_an_end_of_recording_that_cannot_be_queued_ends_the_session():
    satellite, writer = connected()
    satellite.on_press()
    satellite.on_audio(FRAME)
    stop_reading(satellite)
    satellite.on_release()
    assert satellite.writer is None, "a run with no end must not sit out the watchdog"
    assert writer.closed
    assert satellite._awaiting_since is None


async def test_a_dropped_control_event_ends_the_session():
    """Losing run-pipeline or audio-start leaves Home Assistant waiting too."""
    satellite, writer = connected()
    stop_reading(satellite)
    satellite.on_press()
    satellite.on_audio(FRAME)
    assert satellite.writer is None
    assert writer.closed
    assert satellite._run_open is False


async def test_a_dropped_audio_chunk_keeps_the_session():
    satellite, writer = connected()
    satellite.on_press()
    satellite.on_audio(FRAME)  # opens the run while there is still room
    stop_reading(satellite)
    satellite.on_audio(FRAME)
    assert satellite.writer is writer, "speech gives way, the session does not"
    assert not writer.closed


async def test_a_ping_keeps_the_socket_but_not_the_run():
    """This test used to assert the opposite, and that is why the bug shipped.

    "Anything Home Assistant says clears the debt" reads as generous and is what a
    ping deserves - but a ping proves the socket, not the run, and the watchdog
    exists precisely to drop a live socket whose run is dead.
    """
    satellite, _ = connected()
    owed = time.monotonic()
    satellite._awaiting_since = owed
    await satellite._on_event({"type": "ping", "data": {}}, b"")
    assert satellite._awaiting_since == owed


class SlowPipePlayer:
    """A player whose writing takes real time, the way a full pipe to pw-cat does.

    pw-cat consumes in real time while Home Assistant delivers a whole answer in
    a couple of seconds, so this is the normal case for anything longer than the
    pipe and the player's own buffer hold - not an edge case. Same shape as the
    real one: the caller hands chunks over and never waits.
    """

    def __init__(self, delay=0.02):
        self.delay = delay
        self.written = []
        self.handed = []
        self.played = 0
        self.stopped = 0
        self._cmds = queue.Queue()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while True:
            cmd = self._cmds.get()
            if cmd is None:
                return
            if cmd[0] == "chunk":
                time.sleep(self.delay)  # the pipe backing up
                self.written.append(cmd[1])
            elif cmd[0] == "finish":
                self.played += 1
                cmd[1]()

    def start(self, *_args):
        pass

    def write(self, chunk):
        self.handed.append(chunk)
        self._cmds.put(("chunk", chunk))

    def finish(self, played):
        self._cmds.put(("finish", played))

    def stop(self):
        self.stopped += 1

    def close(self, timeout=None):
        self._cmds.put(None)


class FakeProc:
    """Just enough of Popen, writing into a pipe of our own size."""

    def __init__(self, pipe_bytes=4096):
        self.read_fd, write_fd = os.pipe()
        fcntl.fcntl(write_fd, 1031, pipe_bytes)  # F_SETPIPE_SZ
        self.stdin = os.fdopen(write_fd, "wb", buffering=0)
        self.stderr = None
        self.returncode = 0
        self.killed = 0
        self.waits = []

    def kill(self):
        self.killed += 1
        self.returncode = -9
        # The READ end, which is what killing pw-cat really does: a writer
        # blocked on a full pipe gets EPIPE. Closing the write end instead leaves
        # a blocked write blocked, because closing an fd does not unblock one.
        with contextlib.suppress(OSError):
            os.close(self.read_fd)

    def wait(self, timeout=None):
        self.waits.append(timeout)
        return 0

    def close(self):
        if not self.killed:
            with contextlib.suppress(OSError):
                os.close(self.read_fd)
        with contextlib.suppress(OSError):
            self.stdin.close()


@contextlib.contextmanager
def real_player(pipe_bytes=4096, wpctl=None):
    """The real Player, with pw-cat replaced by a pipe we can starve.

    The pipe is what the bug was made of, so the Player-level tests drive the
    real thing: a fake write cannot fail them.
    """
    player = vs.Player(duck=1.0)
    made = []
    was_popen, was_idle = vs.subprocess.Popen, vs.IDLE_TEARDOWN

    def popen(*_a, **_k):
        made.append(FakeProc(pipe_bytes))
        return made[-1]

    vs.subprocess.Popen = popen
    if wpctl is not None:
        player._wpctl = wpctl
    try:
        yield player, made
    finally:
        vs.subprocess.Popen, vs.IDLE_TEARDOWN = was_popen, was_idle
        player.close(timeout=2)
        for proc in made:
            proc.close()


def wait_for(what, predicate, timeout=3.0):
    """Poll until the player's thread has done something observable.

    Polling rather than a probe command, because every command the player takes
    changes its state - a "have you caught up" message would have to be one more
    thing the real code carries for the tests' benefit.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


def hand_over(write, count=32, size=2048, deadline=2.0):
    """Hand `count` chunks to `write`, FAILING if it blocks.

    Done on a thread with a join deadline on purpose: the whole bug was a call
    that blocked, and asserting it inline turns a regression into a suite that
    hangs rather than one that reports a failure.
    """
    done = threading.Event()

    def run():
        for _ in range(count):
            write(b"\x00" * size)
        done.set()

    worker = threading.Thread(target=run, daemon=True)
    started = time.monotonic()
    worker.start()
    worker.join(timeout=deadline)
    assert done.is_set(), f"handing over {count} chunks blocked for {deadline:.0f}s"
    return time.monotonic() - started


async def test_the_read_loop_never_waits_for_the_player():
    """The bug that cut every long answer in half, and its first fix's version.

    The write went straight to the player's pipe, which blocks once the pipe is
    full; then the first fix moved the write to a thread but still awaited the
    drain inside `_on_event` - and that coroutine is the only thing reading the
    socket, so nothing answered the `ping` Home Assistant sends every 2 s and
    gives up on after 5 for the whole of playback. Either way it dropped the
    satellite, the drop ended the session, and ending the session stopped the
    player.

    So this drives the whole answer through the real player with nothing draining
    its pipe, and with `wpctl` hanging for good measure - every branch that
    touches it has to return at once.
    """
    # "speak", so the answer really reaches the player - with "toast" the whole
    # audio-start branch is skipped and this test would pass on anything.
    satellite, _ = connected(answer="speak")
    hung = threading.Event()

    def wedged_wpctl(*_args):
        hung.wait(timeout=30)  # a box whose wpctl never answers
        return None

    with real_player(wpctl=wedged_wpctl) as (player, _procs):
        satellite.player = player
        try:
            started = time.monotonic()
            await satellite._on_event({"type": "audio-start", "data": {"rate": 22050}}, b"")
            for _ in range(64):  # 128 KiB into a 4 KiB pipe
                await satellite._on_event({"type": "audio-chunk", "data": {}}, b"\x00" * 2048)
            await satellite._on_event({"type": "audio-stop", "data": {}}, b"")
            await satellite._on_event({"type": "ping", "data": {"text": "x"}}, b"")
            spent = time.monotonic() - started
        finally:
            hung.set()
    assert spent < 0.5, f"the read loop spent {spent:.2f}s on the player"
    assert "pong" in sent(satellite), "a ping went unanswered during playback"


async def test_an_answer_that_is_never_spoken_reaches_no_player():
    """`toast` shows the text and plays nothing.

    The chunks still arrive, and handing them to a player that was never opened
    charges them to a budget nothing drains, so a long answer could fill it and
    have the `played` after it refused. And `played` is still owed: Home
    Assistant waits for it whether or not anything was audible.
    """
    satellite, _ = connected(answer="toast")
    player = SlowPipePlayer(delay=0.02)
    satellite.player = player
    try:
        await satellite._on_event({"type": "audio-start", "data": {"rate": 22050}}, b"")
        for _ in range(10):
            await satellite._on_event({"type": "audio-chunk", "data": {}}, b"\x00" * 2048)
        await satellite._on_event({"type": "audio-stop", "data": {}}, b"")
        assert player.handed == [], "a toast-only answer reached the player"
        assert "played" in sent(satellite), "a toast-only answer never finished"
    finally:
        player.close()


async def test_played_waits_for_the_answer_to_play_out():
    """`played` is a promise, and it used to be kept by accident.

    Home Assistant waits for this event before it considers an announcement over.
    With the blocking write the last chunk returned roughly when the sound ended,
    so sending it there happened to be true; once the writing moved off the read
    loop it is not, and it has to follow the sound instead.
    """
    satellite, _ = connected(answer="speak")
    player = SlowPipePlayer(delay=0.02)
    satellite.player = player
    try:
        await satellite._on_event({"type": "audio-start", "data": {"rate": 22050}}, b"")
        for _ in range(10):
            await satellite._on_event({"type": "audio-chunk", "data": {}}, b"\x00" * 2048)
        await satellite._on_event({"type": "audio-stop", "data": {}}, b"")
        assert "played" not in sent(satellite), "played was sent before the audio"
        for _ in range(200):
            await asyncio.sleep(0.01)
            if player.played:
                break
        await asyncio.sleep(0.05)  # the hop back to the loop
        assert len(player.written) == 10, "the answer was cut short"
        assert "played" in sent(satellite), "played never arrived"
    finally:
        player.close()


async def test_a_played_is_not_credited_to_the_connection_that_replaced_it():
    """Playing an answer out takes as long as the answer, and a reconnect can
    land inside that. Home Assistant ends an announcement's wait on this event,
    so handing it to the session that replaced ours closes a turn it never took.
    """
    satellite, _ = connected(answer="speak")
    player = SlowPipePlayer(delay=0.05)
    satellite.player = player
    try:
        await satellite._on_event({"type": "audio-start", "data": {"rate": 22050}}, b"")
        for _ in range(6):
            await satellite._on_event({"type": "audio-chunk", "data": {}}, b"\x00" * 2048)
        await satellite._on_event({"type": "audio-stop", "data": {}}, b"")
        satellite.writer = FakeWriter()  # Home Assistant reconnected while it played
        for _ in range(200):
            await asyncio.sleep(0.01)
            if player.played:
                break
        await asyncio.sleep(0.05)
        assert "played" not in sent(satellite), "a dead session's played reached the new one"
    finally:
        player.close()


def test_handing_a_chunk_over_never_blocks_the_caller():
    """The real Player, with a pipe far too small for what is handed to it."""
    with real_player() as (player, procs):
        player.start(22050, 2, 1)
        wait_for("the player to open", lambda: bool(procs) and player._proc is procs[0])
        hand_over(player.write)  # 64 KiB into a 4 KiB pipe

        # Draining the reader lets the thread get through it all.
        drained = 0
        while drained < 32 * 2048:
            drained += len(os.read(procs[0].read_fd, 4096))
        wait_for("the whole answer to reach the player", lambda: player._written == 32 * 2048)


def test_the_answer_is_played_out_before_played_is_said():
    """There is nothing to size a wait against, and that is the design.

    An earlier version waited for a deadline derived from the audio's length, and
    got it from the bytes the writer had FLUSHED - a couple of seconds whatever
    the answer was, so a 30 s answer was cut at 10 s. The commands are in order
    now, so by the time the thread reaches `finish` every chunk has been written
    and there is no arithmetic to get wrong.
    """
    with real_player() as (player, procs):
        player.start(22050, 2, 1)
        heard = threading.Event()
        hand_over(player.write, count=100)  # 200 KiB into a 4 KiB pipe
        player.finish(heard.set)
        assert not heard.wait(timeout=0.3), "played was said with the answer still queued"
        drained = 0
        while drained < 100 * 2048:
            drained += len(os.read(procs[0].read_fd, 8192))
        assert heard.wait(timeout=3), "played was never said"
        assert player._written == 100 * 2048, "the answer was cut short"
        # Closing stdin is what makes the player play out what it still holds, so
        # this wait is the tail of the answer rather than cleanup - `stop()` gets
        # the short one, because there nobody is listening for the rest.
        assert procs[0].waits == [vs.PLAYOUT_TAIL], f"played out with {procs[0].waits}"


def test_the_queue_ceiling_holds_for_every_chunk_shape():
    """The ceiling is a MEMORY bound, not an audio one.

    Counting only the payload made it useless against the shapes nothing real
    sends: a queued chunk costs a bytes object and a queue slot whatever its
    length, so one-byte chunks fitted 4 million of them inside a 4 MB budget
    (240 MB of RSS), and an empty chunk was charged nothing at all and could be
    sent for ever.
    """
    for size in (1, 4096, 256 * 1024, 0):
        with real_player() as (player, procs):
            player.start(22050, 2, 1)
            wait_for("the player to open", lambda: bool(procs) and player._proc is procs[0])
            # Wedge the thread inside a write, so nothing drains and what the
            # ceiling admits is exactly what it admitted.
            player.write(b"\x00" * 8192)
            wait_for("the thread to take it", lambda: player._cmds.empty())

            cost = size + vs.CHUNK_OVERHEAD
            chunk = b"\x00" * size
            hand_over(player.write, count=2 * vs.MAX_QUEUED_AUDIO // cost, size=size, deadline=20)
            assert player._queued <= vs.MAX_QUEUED_AUDIO, f"{size}: {player._queued} queued"
            if size:
                assert player._dropped > 0, f"{size}: nothing was refused"
            else:
                assert player._queued == 0, "an empty chunk was queued"


def test_the_ceiling_covers_commands_that_are_not_audio():
    """`audio-stop` is 26 bytes on the wire and a tuple plus a closure in here.

    Charging only the audio let a peer flood those while the thread was busy
    writing one chunk: 116 MB of wire became 1458 MB of resident memory, worse
    than sending audio. Everything the queue holds is charged now.
    """
    with real_player() as (player, procs):
        player.start(22050, 2, 1)
        wait_for("the player to open", lambda: bool(procs) and player._proc is procs[0])
        # Wedge the thread inside a write, so nothing is taken off the queue.
        player.write(b"\x00" * 8192)
        wait_for("the thread to take it", lambda: player._cmds.empty())

        rounds = 4 * vs.MAX_QUEUED_AUDIO // vs.CONTROL_COST
        hand_over(lambda _c: player.finish(lambda: None), count=rounds, size=0, deadline=20)
        assert player._queued <= vs.MAX_QUEUED_AUDIO, f"{player._queued} bytes queued"
        assert player._cmds.qsize() < rounds, "nothing was refused"
        assert player._dropped > 0, "nothing was refused"


def test_an_answer_long_enough_to_fill_the_queue_can_still_finish():
    """`finish` is what Home Assistant is waiting for, so audio may not crowd it out.

    Sharing one budget meant the case that fills it - an answer past the ceiling -
    was exactly the case where the event that ends it got refused: no `played`,
    and the player left open until the idle teardown.
    """
    with real_player() as (player, procs):
        player.start(22050, 2, 1)
        wait_for("the player to open", lambda: bool(procs) and player._proc is procs[0])
        player.write(b"\x00" * 8192)
        wait_for("the thread to take it", lambda: player._cmds.empty())

        # Small chunks, so the audio budget is filled to within less than one
        # command's worth: with 256 KiB chunks the leftover headroom is bigger
        # than a command and a shared budget would still have admitted it.
        chunk = 256
        rounds = 2 * vs.MAX_QUEUED_AUDIO // (chunk + vs.CHUNK_OVERHEAD)
        hand_over(player.write, count=rounds, size=chunk, deadline=30)
        assert player._dropped > 0, "the audio budget was not filled"
        headroom = vs.MAX_QUEUED_AUDIO - player._queued
        assert headroom < vs.CONTROL_COST, f"{headroom} bytes of headroom left"

        heard = threading.Event()
        player.finish(heard.set)
        assert player._queued_control > 0, "finish was refused by a full audio queue"


def test_a_played_from_an_abandoned_answer_is_not_said():
    """Playing the tail out takes real time, and a new answer can start inside it.

    The generation is checked when a command is taken off the queue, which is too
    early for this one: saying `played` after the teardown would mark the answer
    that REPLACED this one complete, on the same connection, while its own audio
    is still going.
    """
    playing = threading.Event()
    release = threading.Event()

    class Tail(FakeProc):
        def wait(self, timeout=None):
            self.waits.append(timeout)
            playing.set()
            release.wait(timeout=10)
            return self.returncode or 0

        def kill(self):
            FakeProc.kill(self)
            release.set()

    player = vs.Player(duck=1.0)
    made = []
    heard = threading.Event()
    was = vs.subprocess.Popen
    vs.subprocess.Popen = lambda *_a, **_k: (made.append(Tail()), made[-1])[1]
    try:
        player.start(22050, 2, 1)
        wait_for("the player to open", lambda: bool(made) and player._proc is made[0])
        player.finish(heard.set)
        assert playing.wait(timeout=3), "the play-out never began"
        player.start(22050, 2, 1)  # a new answer, inside the tail of the old one
        wait_for("the new answer to open", lambda: len(made) == 2)
        assert not heard.is_set(), "an abandoned answer said played"
    finally:
        release.set()
        vs.subprocess.Popen = was
        player.close(timeout=2)
        for proc in made:
            proc.close()


def test_stop_abandons_the_rest_of_the_answer():
    """A connection that went takes the rest of its answer with it.

    Playing out what is queued would talk over whatever the next connection does,
    so `stop()` kills the player - which is the opposite of `finish()`, where
    closing its stdin is what plays the tail out.

    **The reader keeps draining here, and that is the point**: with nothing
    reading the pipe the writer blocks at the first chunk whatever `stop()` does,
    so an earlier version of this test passed on code that drained the queue into
    the player. Draining leaves the kill as the only thing that can stop it.
    """
    with real_player() as (player, procs):
        player.start(22050, 2, 1)
        wait_for("the player to open", lambda: bool(procs) and player._proc is procs[0])
        stop_reading = threading.Event()

        def drain():
            while not stop_reading.is_set():
                try:
                    got = os.read(procs[0].read_fd, 4096)
                except OSError:
                    return
                if not got:
                    return
                time.sleep(0.005)  # real time, so the queue is what holds the rest

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        try:
            hand_over(player.write, count=64)
            player.stop()
            wait_for("the player to be closed", lambda: player._proc is None)
            assert procs[0].killed, "stop() did not kill the player"
            assert player._written < 64 * 2048, "stop() played out the rest"
        finally:
            stop_reading.set()
            reader.join(timeout=2)


def test_a_stop_beats_a_start_that_is_still_queued():
    """Order is not cancellation.

    A `stop` sent while an earlier `start` was still waiting used to be applied
    AFTER it - so the abandoned answer opened a player, wrote its chunks and went
    on playing into the next connection, which is the one thing `stop` promises
    not to do. Every command carries the answer it belongs to now.
    """
    player = vs.Player(duck=1.0)
    made = []
    gate = threading.Event()
    was = vs.subprocess.Popen

    def popen(*_a, **_k):
        gate.wait(timeout=10)  # hold the thread inside the FIRST start
        made.append(FakeProc())
        return made[-1]

    vs.subprocess.Popen = popen
    try:
        player.start(22050, 2, 1)
        wait_for("the thread to reach the player", lambda: player._cmds.empty())
        player.start(22050, 2, 1)  # a second answer, which will sit in the queue
        hand_over(player.write, count=4, size=2048)
        player.stop()  # ...and the connection goes before any of it is applied
        gate.set()
        wait_for("the thread to settle", lambda: player._cmds.empty())
        wait_for("the player to be closed", lambda: player._proc is None)
        assert len(made) == 1, f"an abandoned answer opened a player ({len(made)})"

        # The purge above is what usually drops it, but a command the thread had
        # ALREADY taken is past that - so the answer it belongs to is what
        # decides, and a stale one opens nothing.
        stale = player._gen
        player.stop()
        wait_for("the abandon to land", lambda: player._gen > stale)
        player._submit(("start", 22050, 2, 1), gen=stale)
        wait_for("the thread to settle", lambda: player._cmds.empty())
        time.sleep(0.1)
        assert len(made) == 1, f"a stale start opened a player ({len(made)})"
    finally:
        gate.set()
        vs.subprocess.Popen = was
        player.close(timeout=2)
        for proc in made:
            proc.close()


def test_a_player_that_dies_gives_the_volume_back_at_once():
    """A broken pipe used to be noted and nothing else.

    The ducked volume is only restored by a teardown, and a peer that keeps
    sending chunks keeps resetting the idle timeout - so the room stayed quiet for
    as long as it cared to keep sending.
    """
    with real_player() as (player, procs):
        player.start(22050, 2, 1)
        wait_for("the player to open", lambda: bool(procs) and player._proc is procs[0])
        procs[0].kill()  # the player goes away under the writer
        player.write(b"\x00" * 2048)
        wait_for("the dead player to be closed", lambda: player._proc is None)


def test_the_tail_of_an_answer_can_still_be_killed():
    """`finish` plays out what the player still holds, which takes real time.

    Clearing the process before that wait put it out of the caller's reach, so a
    lost connection could not stop it and the old answer played on into the next
    one for up to PLAYOUT_TAIL.
    """
    playing = threading.Event()
    release = threading.Event()

    class Tail(FakeProc):
        def wait(self, timeout=None):
            self.waits.append(timeout)
            playing.set()
            release.wait(timeout=10)
            return self.returncode or 0

        def kill(self):
            FakeProc.kill(self)
            release.set()  # a real player exits when it is killed

    player = vs.Player(duck=1.0)
    made = []
    was = vs.subprocess.Popen
    vs.subprocess.Popen = lambda *_a, **_k: (made.append(Tail()), made[-1])[1]
    try:
        player.start(22050, 2, 1)
        wait_for("the player to open", lambda: bool(made) and player._proc is made[0])
        player.finish(lambda: None)
        assert playing.wait(timeout=3), "the play-out never began"
        assert player._proc is made[0], "the player is out of reach while it plays out"
        player.stop()  # the connection goes during the tail
        wait_for("the player to be closed", lambda: player._proc is None)
        assert made[0].killed, "the tail could not be stopped"
    finally:
        release.set()
        vs.subprocess.Popen = was
        player.close(timeout=2)
        for proc in made:
            proc.close()


def test_the_volume_comes_back_when_the_player_cannot_start():
    """The duck happens before the player exists, so a failure to start it must
    still give the room back. A box left permanently quiet is the failure nobody
    connects to a missing pw-cat."""
    player = vs.Player(duck=0.3)
    calls = []

    class Got:
        returncode = 0
        stdout = "Streams:\n │  42. mpv\n"

    def wpctl(*args):
        calls.append(args)
        if args[0] == "get-volume":
            return type("R", (), {"returncode": 0, "stdout": "Volume: 0.65"})()
        return Got()

    player._wpctl = wpctl
    was = vs.subprocess.Popen
    vs.subprocess.Popen = lambda *_a, **_k: (_ for _ in ()).throw(OSError("no pw-cat"))
    try:
        player.start(22050, 2, 1)
        wait_for(
            "the volume to be put back",
            lambda: len([c for c in calls if c[0] == "set-volume"]) >= 2,
        )
    finally:
        vs.subprocess.Popen = was
        player.close(timeout=2)
    sets = [c for c in calls if c[0] == "set-volume"]
    assert len(sets) == 2, f"expected a duck and a restore, got {sets}"
    assert sets[-1] == ("set-volume", "42", "0.65"), f"the volume was not restored: {sets[-1]}"


def test_a_player_that_stops_reading_gives_the_volume_back():
    """The other end of the same fault.

    A player that is alive and no longer reading its pipe holds the thread inside
    a write, and every other bound here is checked somewhere the thread cannot
    reach while it is stuck - so the idle teardown never came, the queued `finish`
    never ran, and the room stayed quiet until a new answer or a lost connection.
    """
    with real_player() as (player, procs):
        vs.IDLE_TEARDOWN = 0.5
        player.start(22050, 2, 1)
        wait_for("the player to open", lambda: bool(procs) and player._proc is procs[0])
        # Nothing reads the pipe, so the first of these blocks and stays blocked.
        hand_over(player.write, count=8, size=8192)
        wait_for("the wedged player to be closed", lambda: player._proc is None, timeout=5)


def test_an_answer_that_stops_arriving_gives_the_volume_back():
    """One `audio-start` and then silence used to duck the room for as long as the
    peer held the socket: the watchdog cannot see it, because `audio-start` counts
    as the pipeline making progress."""
    with real_player() as (player, procs):
        vs.IDLE_TEARDOWN = 0.2
        player.start(22050, 2, 1)
        wait_for("the player to open", lambda: bool(procs) and player._proc is procs[0])
        wait_for(
            "the player to close itself with nothing arriving",
            lambda: player._proc is None,
        )


def test_the_player_is_waited_for_before_its_stderr_is_read():
    """A read to EOF does not return until the player exits.

    Doing it before the wait left the timeout bounding nothing: on the code this
    replaces, a `stop()` against a player that ignored its stdin closing was still
    blocked at 40 s. So the teardown waits, kills what did not exit, and only then
    reads - and this drives a player that never exits on its own.
    """

    class Stubborn:
        def __init__(self):
            read_fd, self._err_w = os.pipe()
            self.stderr = os.fdopen(read_fd, "rb")
            self._sink, w = os.pipe()
            self.stdin = os.fdopen(w, "wb", buffering=0)
            self.returncode = None
            self.waited = []

        def kill(self):
            self.returncode = -9
            os.close(self._err_w)  # only now can the stderr read ever return

        def wait(self, timeout=None):
            self.waited.append(timeout)
            if self.returncode is None:
                raise subprocess.TimeoutExpired("pw-cat", timeout)
            return self.returncode

    proc = Stubborn()
    player = vs.Player(duck=1.0)
    player._proc = proc
    done = threading.Event()

    def teardown():
        player._teardown(play_out=True)
        done.set()

    worker = threading.Thread(target=teardown, daemon=True)
    worker.start()
    assert done.wait(timeout=vs.PLAYOUT_TAIL + 5), "the teardown never returned - stderr read first?"
    assert proc.waited and proc.waited[0] == vs.PLAYOUT_TAIL, f"waited {proc.waited}"
    assert proc.returncode == -9, "a player that would not exit was not killed"
    with contextlib.suppress(OSError):
        os.close(proc._sink)


def test_a_refused_thread_does_not_end_playback_for_good():
    """The OS refusing a thread is a RuntimeError, not an OSError.

    Half-building the player left a Thread that was never started, and joining one
    of those raises for ever - so every later answer raised before it reached the
    player, and the box could not speak again until the service restarted.
    """
    player = vs.Player(duck=1.0)
    real = threading.Thread

    class Refusing(real):
        def start(self):
            raise RuntimeError("can't start new thread")

    threading.Thread = Refusing
    try:
        player.start(22050, 2, 1)  # must not raise
        player.write(b"\x00" * 64)
        player.finish(lambda: None)
        player.stop()
    finally:
        threading.Thread = real
    assert player._thread is None, "a thread that never started was kept"

    # ...and the next answer still gets one.
    with real_player() as (live, procs):
        live.start(22050, 2, 1)
        wait_for("the next answer to get a thread", lambda: bool(procs) and live._proc is procs[0])


# ---------------------------------------------------------------- the note


@contextlib.contextmanager
def toaster_calling(behaviour):
    """`show_toast` replaced, and put back afterwards."""
    real = vs.show_toast
    vs.show_toast = behaviour
    try:
        yield
    finally:
        vs.show_toast = real


async def test_the_note_never_holds_up_the_socket():
    """The read loop is the only thing that answers a ping.

    Home Assistant pings every 2 s and drops a satellite silent for 5, and the
    note is an HTTP round trip to another process on this box - which used to be
    awaited here, bounded by `urlopen`'s own five-second timeout, i.e. exactly
    the budget. Same shape as the answer's audio before the player got a thread.
    """
    satellite, _ = connected(answer="toast")
    shown = []
    slow = threading.Event()

    def hold(text):
        slow.wait(2.0)
        shown.append(text)

    with toaster_calling(hold):
        started = time.monotonic()
        await satellite._on_event({"type": "synthesize", "data": {"text": "Kész."}}, b"")
        took = time.monotonic() - started
        assert took < 0.5, f"the read loop waited {took:.2f}s for the note"
        # ...and a ping is still answered while the note is in flight.
        await satellite._on_event({"type": "ping", "data": {"text": None}}, b"")
        assert sent(satellite) == ["pong"], "a ping went unanswered during a note"
        slow.set()
        wait_for("the note to reach the shell", lambda: shown == ["Kész."])


async def test_a_shell_that_will_not_answer_drops_notes_rather_than_queue_them():
    satellite, _ = connected(answer="both")
    held = threading.Event()
    seen = []

    def hold(text):
        seen.append(text)
        if len(seen) == 1:
            held.wait(3.0)

    with toaster_calling(hold):
        # One note first, so the thread is busy with it before the rest arrive -
        # otherwise the eviction below reaches it before it is ever picked up.
        satellite.toaster.show("note 0")
        wait_for("the first note to be taken", lambda: seen == ["note 0"])
        for i in range(1, vs.MAX_QUEUED_NOTES + 6):
            started = time.monotonic()
            satellite.toaster.show(f"note {i}")
            assert time.monotonic() - started < 0.2, "show() blocked"
        assert satellite.toaster._dropped > 0, "a full queue must drop, not wait"
        assert vs.MAX_QUEUED_NOTES <= 8, "the queue is a freshness bound, not a buffer"
        held.set()
        # Delivered, not merely dequeued, before `show_toast` goes back: this
        # toaster's thread outlives the test, and the ring empties
        # while the thread is still between `get()` and the call - so a note
        # would land in whatever the NEXT test has put in that global.
        wait_for("every queued note to be delivered",
                 lambda: len(seen) == vs.MAX_QUEUED_NOTES + 1)


async def test_a_note_that_raises_does_not_end_the_notes():
    satellite, _ = connected(answer="toast")
    seen = []

    def once(text):
        seen.append(text)
        if len(seen) == 1:
            raise RuntimeError("the shell went away")

    with toaster_calling(once):
        satellite.toaster.show("első")
        satellite.toaster.show("második")
        wait_for("the note after the failing one", lambda: seen == ["első", "második"])


async def test_an_empty_answer_is_not_put_on_screen():
    satellite, _ = connected(answer="both")
    seen = []
    with toaster_calling(seen.append):
        satellite.toaster.show("")
        satellite.toaster.show("   ")
        await asyncio.sleep(0.05)
        assert seen == [], "an empty note reached the shell"
        assert satellite.toaster._thread is None, "an empty note started a thread"


async def test_a_spoken_only_answer_shows_nothing():
    satellite, _ = connected(answer="speak")
    seen = []
    with toaster_calling(seen.append):
        await satellite._on_event({"type": "synthesize", "data": {"text": "Kész."}}, b"")
        await asyncio.sleep(0.05)
        assert seen == [], "an answer configured as speech-only was drawn anyway"


async def test_a_full_queue_keeps_the_newest_note():
    """A note is about the question just asked, so the STALE one goes.

    Dropping the arrival instead left a queue of old answers on screen and
    silently lost the current one - the opposite of what audio wants, where a
    hole belongs at the end.
    """
    satellite, _ = connected(answer="both")
    held = threading.Event()
    seen = []

    def hold(text):
        seen.append(text)
        if len(seen) == 1:
            held.wait(3.0)

    with toaster_calling(hold):
        # The first note is taken BEFORE the rest arrive, so the thread is busy
        # and the queue really fills - pushing everything at once would let the
        # eviction reach note 0 before it was ever picked up.
        satellite.toaster.show("note 0")
        wait_for("the first note to be taken", lambda: seen == ["note 0"])
        for i in range(1, vs.MAX_QUEUED_NOTES + 4):
            satellite.toaster.show(f"note {i}")
        held.set()
        wait_for("the queue to be delivered", lambda: len(seen) == vs.MAX_QUEUED_NOTES + 1)
        newest = f"note {vs.MAX_QUEUED_NOTES + 3}"
        assert seen[-1] == newest, f"the newest note was dropped: {seen}"


async def test_a_refused_thread_does_not_end_the_session():
    """`show()` is called from the task that answers Home Assistant's pings.

    The player learned this the hard way: raising there takes the connection
    with it, so a box that cannot start a thread must merely stop drawing notes.
    """
    satellite, _ = connected(answer="both")
    real = threading.Thread

    class Refusing(real):
        def start(self):
            raise RuntimeError("can't start new thread")

    threading.Thread = Refusing
    try:
        satellite.toaster.show("nem indul szál")  # must not raise
    finally:
        threading.Thread = real
    assert satellite.toaster._thread is None, "a thread that never started was kept"

    seen = []
    with toaster_calling(seen.append):
        satellite.toaster.show("a következő viszont igen")
        wait_for("the note after the refused thread", lambda: seen == ["a következő viszont igen"])


async def test_an_answer_that_is_not_a_string_is_still_survivable():
    """The text comes off a port with no authentication.

    `(123 or "").strip()` raised out of `_on_event`, and an exception there ends
    the session - so one malformed event cost the microphone until Home
    Assistant reconnected.
    """
    satellite, _ = connected(answer="both")
    seen = []
    with toaster_calling(seen.append):
        await satellite._on_event({"type": "synthesize", "data": {"text": 123}}, b"")
        wait_for("the number to be drawn as text", lambda: seen == ["123"])
        await satellite._on_event({"type": "synthesize", "data": {"text": None}}, b"")
        await asyncio.sleep(0.05)
        assert seen == ["123"], "an empty answer was drawn"


async def test_the_note_really_is_an_http_post_to_the_shell():
    """The one test that exercises `show_toast` itself.

    Everything else in this file replaces it, so without this the request - the
    endpoint, the body, the timeout - is not covered at all, and a regression
    there would leave the suite green while no box ever drew a note.
    `urlopen` is mocked; nothing leaves this process.
    """
    seen = {}

    class Answer:
        def read(self):
            return b'{"ok":true}'

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url
        seen["method"] = req.get_method()
        seen["type"] = req.headers.get("Content-type")
        seen["body"] = json.loads(req.data.decode("utf-8"))
        seen["timeout"] = timeout
        return Answer()

    real_urlopen = urllib.request.urlopen
    urllib.request.urlopen = fake_urlopen
    try:
        _real_show_toast(" Kész a válasz. ")
    finally:
        urllib.request.urlopen = real_urlopen

    assert seen["url"] == vs.SHELL_NOTIFY_URL, seen["url"]
    assert seen["method"] == "POST", seen["method"]
    assert seen["type"] == "application/json", seen["type"]
    assert seen["body"]["message"] == "Kész a válasz.", seen["body"]
    assert seen["body"]["duration"] > 0, seen["body"]
    assert seen["timeout"] == vs.NOTIFY_TIMEOUT, seen["timeout"]
    assert vs.NOTIFY_TIMEOUT < 5, "the wait must stay well inside a ping budget"


async def test_a_shell_that_refuses_the_note_is_survivable():
    """A box with no shell running is an ordinary state, not a failure."""
    real_urlopen = urllib.request.urlopen

    def refuse(req, timeout=None):
        raise OSError("connection refused")

    urllib.request.urlopen = refuse
    try:
        _real_show_toast("nincs shell")  # must not raise
    finally:
        urllib.request.urlopen = real_urlopen


async def main():
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        got = test()
        if asyncio.iscoroutine(got):
            await got
        print("ok", test.__name__)
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    asyncio.run(main())
