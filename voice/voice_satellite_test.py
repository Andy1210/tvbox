#!/usr/bin/env python3
"""Offline tests for the satellite's session and run handling.

Run: python3 voice/voice_satellite_test.py

No remote, no Home Assistant and no audio device: what is covered here is the
bookkeeping that decides whether a run is opened at all and who owns the single
connection, which is where a stuck pipeline and a locked-out Home Assistant both
come from. The microphone and the decoder need real hardware and are not touched.
"""
import asyncio
import os
import sys
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


def sent(satellite):
    """The event types queued so far, oldest first."""
    out = []
    while not satellite._out.empty():
        out.append(satellite._out.get_nowait()[0])
    return out


def connected():
    satellite = vs.Satellite(CONFIG)
    writer = FakeWriter()
    satellite.writer = writer
    satellite._peer_host = HA
    return satellite, writer


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
    task.cancel()


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
    stale_task.cancel()
    fresh_task.cancel()


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
    vs.WATCHDOG_INTERVAL = 0.01
    watchdog = asyncio.create_task(satellite.watchdog())
    await asyncio.sleep(0.05)
    watchdog.cancel()
    task.cancel()
    assert satellite.writer is fresh, "the reconnect must survive the old run's debt"


async def test_the_watchdog_drops_a_run_that_is_never_answered():
    satellite, writer = connected()
    satellite._awaiting_since = time.monotonic() - vs.RUN_TIMEOUT - 1
    vs.WATCHDOG_INTERVAL = 0.01
    task = asyncio.create_task(satellite.watchdog())
    await asyncio.sleep(0.05)
    task.cancel()
    assert satellite.writer is None, "a run nobody answers must not hold the session"
    assert writer.closed


async def test_the_watchdog_leaves_a_run_in_progress_alone():
    satellite, writer = connected()
    satellite._awaiting_since = time.monotonic()
    vs.WATCHDOG_INTERVAL = 0.01
    task = asyncio.create_task(satellite.watchdog())
    await asyncio.sleep(0.05)
    task.cancel()
    assert satellite.writer is writer
    assert not writer.closed


async def test_anything_home_assistant_says_clears_the_debt():
    satellite, _ = connected()
    satellite._awaiting_since = time.monotonic()
    await satellite._on_event({"type": "ping", "data": {}}, b"")
    assert satellite._awaiting_since is None


async def main():
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        await test()
        print("ok", test.__name__)
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    asyncio.run(main())
