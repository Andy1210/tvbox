#!/usr/bin/env python3
"""The box as a Home Assistant voice satellite, listening through the TV remote.

The remote you are already holding has a microphone, and this turns it into the
same thing a Voice PE puck is to Home Assistant: an `assist_satellite` entity.
Press and hold the mic key, speak, release; Home Assistant runs ITS pipeline
(speech to text, whatever conversation agent is configured, text to speech) and
sends the spoken answer back here to play. Nothing about the assistant lives on
the box - no endpoint, no token, no model - which is the point: whoever owns the
Home Assistant decides what answers.

Three things are worth knowing before changing anything here.

**The remote's microphone protocol.** It is not a Bluetooth audio device; the
audio arrives as vendor HID reports on the same node the buttons come from
(see docs/voice-satellite.md for how it was worked out):

    consumer report 0x02 with usage 0x221  ->  the mic key is down
    write output report {0xF2, 0x01}       ->  the remote starts streaming
    input reports 0xF0                     ->  one Opus frame each, 80 bytes
    write output report {0xF2, 0x00}       ->  stop

The order matters: the start command means nothing before the key press. Each
frame is CELT wideband, 20 ms, mono, decoded here to 16 kHz PCM - which is
exactly what Assist wants, so nothing is resampled.

**Home Assistant connects to US.** The satellite is a TCP server speaking the
Wyoming protocol; the Wyoming integration is pointed at this box's address. That
is why there is no Home Assistant URL in the config: the box advertises a
microphone and a speaker and answers what it is asked. It also means the port is
open on the LAN with no authentication, which is how every Wyoming satellite
works - so the service is OFF until someone turns it on.

**Which room the answer acts on is Home Assistant's business, not ours.** The
satellite belongs to a device there, that device belongs to an area, and the
conversation agent resolves "the light" against it - the same mechanism the pucks
use. The area is not sent from here beyond a hint in the info message, so
assigning the box to a room in Home Assistant is what makes "turn off the light"
mean this room.
"""

import asyncio
import collections
import ctypes
import glob
import json
import logging
import os
import queue
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request

LOG = logging.getLogger("tvbox-voice")

HOME = os.path.expanduser("~")
CONFIG_PATH = os.path.join(HOME, ".tvbox", "config.json")

# The remote, as HID
AMAZON_HID_MATCH = ":0171:"  # Amazon's vendor id, as it appears in the HID device name
SEARCH_KEY = 0x0221  # consumer usage of the mic key
CONSUMER_REPORT = 0x02
OPUS_AUDIO_REPORT = 0xF0
AUDIO_STATE_REPORT = 0xF2
AUDIO_START = bytes([AUDIO_STATE_REPORT, 0x01])
AUDIO_STOP = bytes([AUDIO_STATE_REPORT, 0x00])

# The microphone's own format. The remote encodes CELT wideband at 20 ms, so the
# decoder is told 16 kHz mono and every frame yields 320 samples.
MIC_RATE = 16000
MIC_WIDTH = 2
MIC_CHANNELS = 1
FRAME_SAMPLES = 320

# What we ask Home Assistant to send the spoken answer back as. Anything it can
# produce it will resample to this, so the number only has to suit the player.
SND_RATE = 22050
SND_WIDTH = 2
SND_CHANNELS = 1

DEFAULT_PORT = 10700

# The port takes unauthenticated connections from the LAN, so a declared length is
# a stranger's number: reading it blindly lets one header allocate the Pi's memory.
# Both are far above anything Assist sends (a chunk is a few kilobytes).
MAX_DATA = 1 << 16
MAX_PAYLOAD = 1 << 20
# Audio is the only thing that arrives faster than it can be sent, so the outbound
# queue is bounded and chunks are what gets dropped when a peer stops reading.
MAX_QUEUED = 256

# How long a run may owe an answer before the connection is dropped. A stuck
# pipeline is not necessarily a silent one: measured on 2026-08-11, Home Assistant
# kept answering every press with `transcribe` while delivering no transcript for
# an hour, so what times out here is the absence of OUTPUT, not of traffic (see
# PROGRESS_EVENTS).
# Closing our side is what lets its satellite reconnect into a working run.
# Generously above a real turn, which is seconds even with a local model.
RUN_TIMEOUT = 60.0
WATCHDOG_INTERVAL = 5.0

# What counts as this run making progress, i.e. what clears the debt the watchdog
# collects on. Everything here is Home Assistant handing over something it
# produced; `transcribe`, `voice-started`, `ping` and the rest are it saying it is
# alive, which is exactly the state the watchdog exists to end.
PROGRESS_EVENTS = frozenset(
    {"transcript", "synthesize", "audio-start", "audio-chunk", "audio-stop", "error"}
)


def _number(value, default, cast):
    """A config value is hand-edited JSON: a typo must not take the service down."""
    try:
        return cast(value)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- config


def load_config():
    """The `voice` section of the box's config, with defaults.

    Off by default on purpose: turning it on opens an unauthenticated port on the
    LAN, which is a decision for whoever owns the box rather than a default.
    """
    cfg = {}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            cfg = json.load(fh).get("voice") or {}
    except (OSError, ValueError):
        cfg = {}
    return {
        "enabled": bool(cfg.get("enabled")),
        "port": _number(cfg.get("port") or DEFAULT_PORT, DEFAULT_PORT, int),
        "name": str(cfg.get("name") or socket.gethostname()),
        "area": str(cfg.get("area") or ""),  # a hint for Home Assistant's setup dialog
        "pipeline": cfg.get("pipeline") or None,  # a named Assist pipeline, else the default
        # How far to pull the OTHER stream down while the answer plays, so a film
        # does not talk over it. 1.0 leaves it alone.
        "duck": _number(cfg.get("duck", 0.3), 0.3, float),
        # How the answer reaches the room: spoken, as a note on the screen, or
        # both. A toast is the one that does not interrupt a film, which is why it
        # is part of the default.
        "answer": str(cfg.get("answer") or "both").lower(),
    }


# ---------------------------------------------------------------- Wyoming wire


async def read_event(reader):
    """One Wyoming event: a JSON header line, then optional data and payload."""
    line = await reader.readline()
    if not line:
        return None, None
    try:
        header = json.loads(line.decode("utf-8"))
    except ValueError:
        LOG.warning("unreadable event header: %r", line[:120])
        return None, None
    data = header.get("data") or {}
    data_length = header.get("data_length") or 0
    payload_length = header.get("payload_length") or 0
    if data_length > MAX_DATA or payload_length > MAX_PAYLOAD:
        # Not a peer worth reading: nothing Assist sends is anywhere near this, and
        # honouring the number is how one header empties the box's memory.
        LOG.warning("refusing an event claiming %d + %d bytes", data_length, payload_length)
        return None, None
    if data_length:
        extra = await reader.readexactly(data_length)
        try:
            data = {**data, **json.loads(extra.decode("utf-8"))}
        except ValueError:
            pass
    payload = await reader.readexactly(payload_length) if payload_length else b""
    return {"type": header.get("type"), "data": data}, payload


async def write_event(writer, event_type, data=None, payload=b""):
    header = {"type": event_type}
    if data:
        header["data"] = data
    if payload:
        header["payload_length"] = len(payload)
    writer.write(json.dumps(header, ensure_ascii=False).encode("utf-8") + b"\n")
    if payload:
        writer.write(payload)
    await writer.drain()


# ---------------------------------------------------------------- Opus


class OpusDecoder:
    """The remote's frames into PCM, through libopus directly.

    ctypes rather than a binding: libopus is already on the box (mpv pulls it in)
    and a pip dependency would have to be installed on a device that deliberately
    has no build tools.
    """

    def __init__(self, rate=MIC_RATE, channels=MIC_CHANNELS):
        self._lib = ctypes.CDLL("libopus.so.0")
        self._lib.opus_decoder_create.restype = ctypes.c_void_p
        self._lib.opus_decoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        self._lib.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
        self._lib.opus_decode.restype = ctypes.c_int
        self._lib.opus_decode.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_short),
            ctypes.c_int,
            ctypes.c_int,
        ]
        err = ctypes.c_int()
        self._dec = self._lib.opus_decoder_create(rate, channels, ctypes.byref(err))
        if err.value != 0 or not self._dec:
            raise RuntimeError("opus_decoder_create failed: %d" % err.value)
        self._channels = channels
        # Room for the longest frame Opus can hand back (60 ms), per channel: the
        # decoder writes interleaved samples, so a buffer sized for one channel
        # would be written past on anything but mono.
        self._max_samples = FRAME_SAMPLES * 3
        self._pcm = (ctypes.c_short * (self._max_samples * channels))()

    def decode(self, frame):
        got = self._lib.opus_decode(self._dec, frame, len(frame), self._pcm, self._max_samples, 0)
        if got <= 0:
            return b""
        return ctypes.string_at(self._pcm, got * 2 * self._channels)

    def close(self):
        if self._dec:
            self._lib.opus_decoder_destroy(ctypes.c_void_p(self._dec))
            self._dec = None


# ---------------------------------------------------------------- the remote


def find_remote_node():
    """The hidraw node of an Amazon remote, or None while it is disconnected."""
    for link in glob.glob("/sys/class/hidraw/hidraw*/device"):
        try:
            if AMAZON_HID_MATCH in os.path.basename(os.path.realpath(link)):
                return "/dev/" + link.split("/")[4]
        except OSError:
            continue
    return None


class RemoteMic:
    """Push to talk on the remote's mic key.

    The node comes and goes with the link - a remote that has been quiet for a
    while drops off and returns on the next press - so this reopens rather than
    holding one descriptor, which is the difference between a satellite that works
    all evening and one that works once.
    """

    def __init__(self, loop, on_press, on_audio, on_release):
        self._loop = loop
        self._on_press = on_press
        self._on_audio = on_audio
        self._on_release = on_release
        self._fd = None
        self._node = None
        self._streaming = False
        self._decoder = OpusDecoder()
        self._closed = False

    async def run(self):
        while not self._closed:
            if self._fd is None:
                node = find_remote_node()
                if node is None:
                    await asyncio.sleep(1.0)
                    continue
                try:
                    # read/write: the start command goes back out on this same fd,
                    # which is why provision.sh grants the group 0660 on it.
                    self._fd = os.open(node, os.O_RDWR | os.O_NONBLOCK)
                    self._node = node
                    self._loop.add_reader(self._fd, self._readable)
                    LOG.info("remote microphone on %s", node)
                except OSError as e:
                    LOG.warning("cannot open %s: %s", node, e)
                    self._fd = None
                    await asyncio.sleep(2.0)
                    continue
            await asyncio.sleep(1.0)

    def _readable(self):
        try:
            data = os.read(self._fd, 512)
        except BlockingIOError:
            return
        except OSError as e:
            LOG.info("remote went away (%s)", e.strerror)
            self._drop()
            return
        if not data:
            # End of file, and the descriptor stays readable: returning here means
            # the event loop calls this again at once, forever. Let `run` reopen it.
            self._drop()
            return
        report = data[0]
        if report == CONSUMER_REPORT and len(data) >= 3:
            usage = int.from_bytes(data[1:3], "little")
            if usage == SEARCH_KEY and not self._streaming:
                self._start()
            elif usage == 0x0000 and self._streaming:
                self._stop()
        elif report == OPUS_AUDIO_REPORT and self._streaming:
            pcm = self._decoder.decode(data[1:])
            if pcm:
                self._on_audio(pcm)

    def _start(self):
        try:
            os.write(self._fd, AUDIO_START)
        except OSError as e:
            # Almost always the udev grant: without write access the key is seen
            # but the remote is never asked to stream, and nothing else says why.
            LOG.error("cannot start the microphone (%s) - is the hidraw rule 0660?", e.strerror)
            return
        self._streaming = True
        self._on_press()

    def _stop(self):
        self._streaming = False
        try:
            os.write(self._fd, AUDIO_STOP)
        except OSError:
            pass
        self._on_release()

    def _drop(self):
        if self._fd is not None:
            try:
                self._loop.remove_reader(self._fd)
                os.close(self._fd)
            except OSError:
                pass
        self._fd = None
        if self._streaming:
            self._streaming = False
            self._on_release()

    def close(self):
        self._closed = True
        self._drop()
        self._decoder.close()


# ---------------------------------------------------------------- on screen


SHELL_NOTIFY_URL = "http://127.0.0.1:8097/tvbox/api/notify"


# How long to wait for the shell to take a note.
#
# **The reply says the shell's main loop reached the request, not that anything
# is on screen**: the route hands the note on and answers in the same tick, and
# drawing it is asynchronous from there. Measured with a shell held for 3.5 s:
# the wait timed out three times and all three notes were drawn anyway, because
# the request had already been delivered. So a shorter wait costs a note
# nothing - it only frees the thread sooner - and five seconds bought nothing at
# all while costing a whole ping budget on the read loop.
NOTIFY_TIMEOUT = 2.0

# How many notes may wait for it. One answer produces one note, so this only
# fills when several turns land while the shell is not taking them; four is the
# depth at which the oldest is already stale enough to be worth losing.
MAX_QUEUED_NOTES = 4


def show_toast(text):
    """Put the answer on the TV as a note.

    A spoken answer talks over whatever is playing; a toast does not, which is why
    both are offered and both are the default. The shell draws it - the same note
    Home Assistant can already push over MQTT - and it is on loopback, so a box
    with no shell running simply gets a failed connection and carries on.

    Called only from `Toaster`'s thread: this is an HTTP round trip to another
    process, and the reason it may not happen on the read loop is written there.
    """
    text = str(text or "").strip()
    if not text:
        return
    body = json.dumps({"message": text, "duration": 8000}).encode("utf-8")
    req = urllib.request.Request(SHELL_NOTIFY_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=NOTIFY_TIMEOUT).read()
    except Exception as e:  # the shell may be restarting; an answer is not worth a crash
        # Deliberately not "could not show": a timeout here means the reply did
        # not come back, and the shell may well draw the note regardless - see
        # NOTIFY_TIMEOUT. Only a refused connection really means no note.
        LOG.warning("the shell did not answer about the note: %s", e)


class Toaster:
    """Draws the answer on screen, from a thread of its own.

    **`show()` is called by the task that reads the socket, and that task is the
    only thing that answers a ping.** Home Assistant pings every 2 s and drops a
    satellite that has not answered in 5, and the drop ends the session - which
    stops the player mid-answer. Awaiting the note there put an HTTP round trip
    to another process on that path, bounded by `urlopen`'s own timeout, which
    was five seconds: exactly the budget. Reading an event out of a buffer that
    already holds data never yields, so it was one unbroken stall rather than
    many short ones. Same shape, and the same reason, as the answer's audio in
    `Player`.

    Measured against a shell held at a chosen latency, with Home Assistant's own
    discipline on the other end: before, a 6 s shell produced the whole failure
    at once - the note on screen, the answer never spoken, and the connection
    dropped at 5.01 s. It also delayed the SPEECH one for one, since the audio
    could not be read until the note came back. After, the longest silence is a
    flat 2.00 s at every latency - the ping cadence and nothing else - and the
    first audio is handed over in 0.37 s.

    One thread and a small queue rather than a task per note, for the reason the
    player has one: `asyncio.to_thread` shares a pool of `cpu + 4` workers, and a
    wait that can last seconds parks one of them.

    **Which the room gets first, the note or the sound, is no longer fixed.** The
    note used to be awaited before any audio was read, so it always won; now the
    two race, and the winner depends on the shell and on how long the audio
    player takes to start. Nothing downstream depends on the order - each is
    complete on its own - and the alternative is the stall above.
    """

    def __init__(self):
        # A ring rather than a `queue.Queue`, because the eviction has to be
        # ATOMIC with the append: doing it as "the put failed, so take one out
        # and put again" races the thread that is draining, and a note it had
        # already taken meanwhile cost a second, live one. `deque(maxlen=)`
        # drops the oldest as part of the append, under one lock.
        self._notes = collections.deque(maxlen=MAX_QUEUED_NOTES)
        self._ready = threading.Condition()
        self._thread = None
        self._dropped = 0

    def show(self, text):
        """Queue one note. Never blocks, never raises.

        `str()` because the text comes off an unauthenticated port: a
        `synthesize` carrying a number made `.strip()` raise, and an exception
        here leaves `_on_event` and ends the session.
        """
        text = str(text or "").strip()
        if not text:
            return
        thread = self._thread
        if thread is None or not thread.is_alive():
            # Lazily, and re-created if it ever died - a box that stops showing
            # notes until the service restarts is the worse failure.
            try:
                thread = threading.Thread(
                    target=self._run, name="tvbox-voice-toast", daemon=True
                )
                thread.start()
            except RuntimeError as e:
                LOG.error("cannot start the toast thread: %s", e)
                return
            self._thread = thread
        # **The OLDEST goes, not the newest.** A note is about the question that
        # was just asked, so the one still waiting behind the others is the one
        # nobody wants any more - dropping the arrival instead showed a queue of
        # stale answers and silently lost the current one. (Audio wants the
        # opposite, which is why `Player` drops what arrives.)
        #
        # Nothing here waits, whatever else it costs: the caller is the task that
        # answers Home Assistant's pings. On `answer: "toast"` the box says
        # nothing either, so a dropped note is that whole turn lost - still
        # better than a satellite that stops responding.
        with self._ready:
            dropped = len(self._notes) == MAX_QUEUED_NOTES
            self._notes.append(text)
            self._ready.notify()
        if dropped:
            self._dropped += 1
            if self._dropped % 10 == 1:
                LOG.warning(
                    "the shell is not taking notes - dropping the oldest (%d so far)",
                    self._dropped,
                )

    def _run(self):
        while True:
            with self._ready:
                while not self._notes:
                    self._ready.wait()
                text = self._notes.popleft()
            try:
                show_toast(text)
            except Exception as e:  # noqa: BLE001 - this thread may never die
                LOG.exception("toast: %s", e)


# ---------------------------------------------------------------- playback


# What the answer queue may hold, counted as MEMORY rather than as audio: a
# queued chunk costs a bytes object and a queue slot whatever its length, so
# charging only the payload let a 4 MB budget hold 245 MB of RSS at one byte per
# chunk, and an empty chunk cost nothing at all and was never refused.
#
# It is also, now that nothing blocks the reader, the only cap on how long an
# answer may be: 16 MB is about 6 minutes of 22050 Hz mono, or 87 s if a text to
# speech engine hands Home Assistant 48 kHz stereo (the pipeline forwards the
# engine's own rate; only the announce path is converted to 22050 mono). Past it
# audio is dropped with a warning, which is the same doctrine as the outbound
# queue - a hole in a sentence beats a box with no memory left.
MAX_QUEUED_AUDIO = 16 * 1024 * 1024
CHUNK_OVERHEAD = 128

# What a queued command that is not audio costs. `audio-stop` is 26 bytes on the
# wire and becomes a tuple and a closure: measured 442 bytes resident each, so a
# peer that floods them while the thread is busy writing turned 116 MB of wire
# into 1458 MB of RSS - worse than the audio it was sending. Everything the queue
# holds is charged to the one budget for that reason.
CONTROL_COST = 512

# ...and they get a budget of their own rather than sharing the audio's. A
# `finish` refused for want of room is a protocol event Home Assistant is waiting
# on, and an answer long enough to fill the audio budget is exactly when it would
# have been refused - so a full answer must never be able to crowd out the event
# that ends it. 1 MB is about 2000 commands.
MAX_QUEUED_CONTROL = 1024 * 1024

# How long the player may still be holding after its stdin closes: the pipe,
# which is 16 PAGES - 64 KiB on an ordinary host and 256 KiB on the box, whose
# kernel uses 16 KiB pages - plus the player's own buffer. Closing stdin is what
# makes it play that out, so this bounds the tail of the answer.
PLAYOUT_TAIL = 10.0

# An answer that stops moving, whichever end has stopped: a peer that opens one
# and goes quiet, or a player that is alive and no longer reading its pipe. The
# volume of whatever else is playing is pulled down for the duration of an answer,
# so either would otherwise leave the room quiet for as long as it lasted - and a
# write with no deadline is outside the reach of every other bound here, because
# nothing else runs on this thread while it is stuck.
IDLE_TEARDOWN = 30.0


class Player:
    """Plays the answer through pw-cat, ducking whatever else is playing.

    The reference is the television: a spoken answer during a film should be
    audible without stopping the film, and restoring the exact level afterwards
    is what keeps this from being noticed.

    **Everything happens on one thread of its own, and nothing here blocks the
    caller.** pw-cat consumes in real time while Home Assistant delivers a whole
    answer in a couple of seconds, so the pipe fills and `stdin.write` blocks.
    Writing from the task that reads the socket ties that task to real time for
    the rest of the answer - and reading an event out of a buffer that already
    holds data never yields, so it is one unbroken stall rather than many short
    ones, ending only when the player has caught up.

    Home Assistant pings every 2 s and drops a satellite that has not answered in
    **5**, and the drop ends the session, which stops this player. So the same
    blocking write both cut the answer off mid-sentence and flapped the
    connection. Measured as the worst uninterrupted stall seen by a task of its
    own on the same loop, across three harnesses that disagree on the seconds and
    agree on the shape: a 3 s answer costs 1.5-3.0 s and survives, a 6 s answer
    4.5-6.0 s and is on the threshold, and by 12 s every measurement is past it.
    Which is why this was only ever seen on long answers.

    So the event loop only ever puts a command on a queue, and this thread owns
    every piece of player state there is. **One thread rather than a task per
    answer**, because `asyncio.to_thread` shares a pool of `cpu + 4` workers -
    8 on a Pi 5 - and a wait that can legitimately last as long as the answer
    parks one of them: measured, thirty `audio-stop` events in ~700 bytes parked
    every worker and left the read loop unable to answer a ping for 99 s. It also
    means `start`, the chunks and the drain cannot interleave, so none of them
    needs a guard against acting on another answer's player. What order alone
    does not give is CANCELLATION, so every command carries the answer it belongs
    to and the thread discards the ones that have been abandoned.
    """

    def __init__(self, duck=0.3):
        self._duck = duck
        self._cmds = queue.Queue()
        self._thread = None
        self._lock = threading.Lock()
        # Bytes of queued audio plus their per-chunk overhead, so the ceiling is
        # a memory bound. Incremented by the caller, decremented by the thread.
        self._queued = 0
        self._queued_control = 0
        self._dropped = 0
        # Which answer a command belongs to. `start` and `stop` bump it, and the
        # thread discards anything older - because the queue's ORDER is not
        # enough: a `stop` sent while an earlier `start` is still queued would
        # otherwise be applied after that start had opened a player and written
        # its chunks, so an abandoned answer went on playing into the next
        # connection, which is the one thing `stop` promises not to do.
        self._gen = 0
        # From here down: the thread's own state, touched nowhere else.
        self._proc = None
        self._written = 0
        self._restore = None
        self._node = None

    # ---- the audio sink, read and set through wpctl

    def _wpctl(self, *args):
        if not shutil.which("wpctl"):
            return None
        try:
            return subprocess.run(["wpctl", *args], capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return None

    def _playing_node(self):
        """The id of whatever is playing right now - the film, not us.

        Ducking the SINK was wrong and silent-looking: the answer comes out of the
        same sink, so pulling that down pulls the answer down with it. What has to
        drop is the other stream, so find it by name in `wpctl status`.
        """
        got = self._wpctl("status")
        if not got or got.returncode != 0:
            return None
        in_streams = False
        for line in got.stdout.splitlines():
            if "Streams:" in line:
                in_streams = True
                continue
            if in_streams:
                if not line.strip(" │└├─"):
                    break
                m = re.search(r"(\d+)\.\s+(.+)", line)
                if m and "pw-cat" not in m.group(2):
                    return int(m.group(1))
        return None

    def _duck_start(self):
        self._node = None
        self._restore = None
        if self._duck >= 1.0:
            return
        node = self._playing_node()
        if node is None:
            return  # nothing else is playing, so nothing to get out of the way of
        got = self._wpctl("get-volume", str(node))
        if not got or got.returncode != 0:
            return
        try:
            self._restore = float(got.stdout.strip().split()[1])
        except (ValueError, IndexError):
            self._restore = None
            return
        self._node = node
        self._wpctl("set-volume", str(node), str(round(self._restore * self._duck, 3)))

    def _duck_end(self):
        if self._node is not None and self._restore is not None:
            self._wpctl("set-volume", str(self._node), str(self._restore))
        self._node = None
        self._restore = None

    # ---- the caller's side: the event loop, so none of this may block

    def start(self, rate, width, channels):
        """Begin an answer. Whatever was playing is abandoned."""
        gen = self._abandon_queued()
        self._submit(("start", int(rate), int(width), int(channels)), gen=gen)

    def write(self, chunk):
        """Hand one chunk over, or refuse it.

        `MAX_QUEUED_AUDIO` is the only refusal and it is far above any answer a
        pipeline produces. It is here because the thread drains in real time while
        the port takes a connection with no credentials, so the blocking write it
        replaced was the only backpressure there was: without a ceiling a peer
        claimed 1.5 GB in a second, bounded by nothing but its link rate.
        """
        if not chunk:
            return
        self._submit(("chunk", chunk), len(chunk) + CHUNK_OVERHEAD, audio=True)

    def finish(self, played):
        """Play the answer out, then call `played` - from the player's thread.

        `played` is a promise Home Assistant waits on before it considers an
        announcement over, so it has to follow the sound rather than the last
        chunk being handed over. Nothing is waited for here: the commands are in
        order, so by the time the thread reaches this one every chunk has been
        written, and all that is left is the buffered tail.
        """
        self._submit(("finish", played))

    def stop(self):
        """Abandon the answer, because the connection went.

        Not `finish()`: nobody is waiting for the rest of it, and letting the
        player play out what it holds would talk over whatever the next connection
        does. The player is killed here rather than on the thread, so the chunks
        still queued are discarded instead of being written first.
        """
        gen = self._abandon_queued()
        self._submit(("stop",), gen=gen)

    def close(self, timeout=5.0):
        """Stop for good, and wait for the thread. Only for shutdown."""
        self.stop()
        thread = self._thread
        if thread is not None:
            self._cmds.put(None)
            thread.join(timeout=timeout)

    def _abandon_queued(self):
        """End the current answer: kill its player and drop what it left queued.

        Returns the generation the caller's own command must carry. Dropping here
        rather than leaving it to the thread is what guarantees that command a
        place: the queue may be full of the answer being abandoned, and a `stop`
        refused for want of room would leave the room ducked until the idle
        teardown noticed.
        """
        with self._lock:
            self._gen += 1
            gen = self._gen
        proc = self._proc
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass
        while True:
            try:
                item = self._cmds.get_nowait()
            except queue.Empty:
                break
            if item is None:
                # The shutdown sentinel is not ours to drop.
                self._cmds.put(None)
                break
            with self._lock:
                if item[3]:
                    self._queued -= item[0]
                else:
                    self._queued_control -= item[0]
        return gen

    def _submit(self, cmd, cost=CONTROL_COST, gen=None, audio=False):
        """Queue one command, or refuse it because the queue is full.

        Audio and commands are counted separately, so that a long answer cannot
        crowd out the `finish` that ends it. Only a peer that is flooding reaches
        the command ceiling, and refusing one there is safe: `start` and `stop`
        have already killed the player from this side, and a player nothing is
        feeding closes itself after `IDLE_TEARDOWN`.
        """
        with self._lock:
            if audio:
                over = self._queued + cost > MAX_QUEUED_AUDIO
                if not over:
                    self._queued += cost
            else:
                over = self._queued_control + cost > MAX_QUEUED_CONTROL
                if not over:
                    self._queued_control += cost
            if over:
                self._dropped += 1
                dropped = self._dropped
        if over:
            # One line per fifty, like the outbound queue: a peer flooding this
            # would otherwise flood the journal with it.
            if dropped % 50 == 1:
                LOG.warning(
                    "the player's queue is full - dropping %s (%d so far)", cmd[0], dropped
                )
            return
        thread = self._thread
        if thread is None or not thread.is_alive():
            # Lazily, and re-created if it ever died: a box that cannot speak
            # until the service restarts is the worse failure. RuntimeError is
            # the OS refusing a thread, which is what memory pressure looks like.
            try:
                thread = threading.Thread(target=self._run, name="tvbox-voice-audio", daemon=True)
                thread.start()
            except RuntimeError as e:
                LOG.error("cannot start the audio thread: %s", e)
                with self._lock:
                    if audio:
                        self._queued -= cost
                    else:
                        self._queued_control -= cost
                return
            self._thread = thread
        if gen is None:
            with self._lock:
                gen = self._gen
        self._cmds.put((cost, gen, cmd, audio))

    # ---- the player's own thread

    def _run(self):
        while True:
            try:
                # The timeout only matters while a player is open, which is what
                # bounds a half-finished answer - see IDLE_TEARDOWN.
                item = self._cmds.get(timeout=IDLE_TEARDOWN if self._proc else None)
            except queue.Empty:
                LOG.warning("no audio for %.0f s - closing the player", IDLE_TEARDOWN)
                self._teardown()
                continue
            if item is None:
                return
            cost, gen, cmd, audio = item
            with self._lock:
                if audio:
                    self._queued -= cost
                else:
                    self._queued_control -= cost
                stale = gen != self._gen
            if stale:
                # An answer that was abandoned while this was queued.
                continue
            try:
                self._apply(cmd, gen)
            except Exception as e:  # noqa: BLE001 - this thread may never die
                LOG.exception("audio thread: %s", e)

    def _apply(self, cmd, gen):
        kind = cmd[0]
        if kind == "chunk":
            self._write(cmd[1])
        elif kind == "start":
            self._teardown()
            self._open(cmd[1], cmd[2], cmd[3])
        elif kind == "finish":
            self._teardown(play_out=True)
            with self._lock:
                stale = gen != self._gen
            if stale:
                # Playing the tail out takes real time, and this answer was
                # abandoned during it. Saying `played` now would mark the answer
                # that REPLACED it complete, on the same connection, while its own
                # audio is still going.
                return
            cmd[1]()
        elif kind == "stop":
            self._teardown()

    def _open(self, rate, width, channels):
        fmt = {1: "u8", 2: "s16", 4: "s32"}.get(width, "s16")
        cmd = [
            "pw-cat",
            "--playback",
            "--format",
            fmt,
            "--rate",
            str(rate),
            "--channels",
            str(channels),
            "--raw",
            "-",
        ]
        self._duck_start()
        try:
            # bufsize=0: the chunks are the answer arriving in real time, and
            # Python's default buffering would hold the first seconds of it back.
            # stderr is KEPT: throwing it away is what made a silent player look
            # like nothing happening at all.
            self._proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, bufsize=0
            )
            # Non-blocking, so `_write` can put a deadline on a player that has
            # stopped reading. A blocking write is the one thing on this thread
            # that nothing could interrupt.
            os.set_blocking(self._proc.stdin.fileno(), False)
        except OSError as e:
            # The volume is already down - `_duck_start` runs before this - and
            # nothing else will put it back, because with no player open there is
            # no teardown to come. A room left quiet is the failure nobody
            # connects to a missing pw-cat.
            LOG.error("cannot play audio: %s", e)
            self._proc = None
            self._duck_end()
            return
        self._written = 0

    def _write(self, chunk):
        proc = self._proc
        if proc is None or proc.stdin is None:
            return
        left = memoryview(chunk)
        deadline = time.monotonic() + IDLE_TEARDOWN
        try:
            while left:
                wrote = proc.stdin.write(left)
                if wrote:
                    left = left[wrote:]
                    self._written += wrote
                    continue
                # Nothing could be written: the pipe is full, which is the normal
                # case - the player consumes in real time. Wait for room, but not
                # for ever: a player that is alive and no longer reading would
                # otherwise hold this thread, and every bound here is checked
                # somewhere this thread cannot reach while it is stuck.
                budget = deadline - time.monotonic()
                if budget <= 0 or not select.select([], [proc.stdin], [], budget)[1]:
                    LOG.warning(
                        "the player stopped reading after %d bytes - closing it", self._written
                    )
                    self._teardown()
                    return
        except (BrokenPipeError, OSError, ValueError) as e:
            # ValueError is a stdin this thread has closed; a broken pipe is a
            # player that went. Tear down rather than only noting it: the rest of
            # this answer has nowhere to go, and a peer that keeps sending chunks
            # keeps resetting the idle timeout - so the room would stay ducked
            # for as long as it cared to.
            LOG.warning("playback pipe closed after %d bytes: %s", self._written, e)
            self._teardown()

    def _teardown(self, play_out=False):
        """Close the player, optionally letting it play out what it holds.

        `_proc` is cleared only after the wait, not before it: the caller's kill
        reads that field, and clearing it first meant a lost connection could not
        reach a player that was in the middle of playing out its tail - the old
        answer went on for up to `PLAYOUT_TAIL` into the next one.
        """
        proc = self._proc
        if proc is None:
            return
        LOG.info("played %d bytes", self._written)
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        # Waiting BEFORE reading stderr is the order that matters: a read to EOF
        # does not return until the player exits, so doing it first left the
        # timeout bounding nothing - measured 20 s on a player that ignored its
        # stdin closing.
        try:
            proc.wait(timeout=PLAYOUT_TAIL if play_out else 2.0)
        except (OSError, subprocess.SubprocessError):
            try:
                proc.kill()
                proc.wait(timeout=2)  # kill without reaping leaves a zombie behind
            except (OSError, subprocess.SubprocessError):
                pass
        self._proc = None
        err = b""
        try:
            if proc.stderr:
                err = proc.stderr.read()
        except (OSError, ValueError):
            pass
        # A signal is how `stop()` ends a player on purpose, so it is not a fault.
        if proc.returncode not in (0, None, -signal.SIGKILL, -signal.SIGTERM) or err.strip():
            LOG.warning("player exited %s: %s", proc.returncode, err.decode("utf-8", "replace").strip()[:300])
        # Whatever happened to the player, the film's volume is not ours to keep.
        self._duck_end()


# ---------------------------------------------------------------- satellite


def _keepalive(writer):
    """Ask the kernel to notice a peer that vanishes without closing.

    A box that loses power mid-run leaves a socket nothing will ever close, and
    the session is single: without this the port stays claimed by a machine that
    is no longer there.
    """
    sock = writer.get_extra_info("socket")
    if sock is None:
        return
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        for name, value in (("TCP_KEEPIDLE", 30), ("TCP_KEEPINTVL", 10), ("TCP_KEEPCNT", 3)):
            option = getattr(socket, name, None)
            if option is not None:
                sock.setsockopt(socket.IPPROTO_TCP, option, value)
    except OSError as e:
        LOG.warning("could not set keepalive: %s", e)


class Satellite:
    """One Home Assistant connection at a time, which is all it ever opens."""

    def __init__(self, config):
        self.config = config
        self.writer = None
        self._peer_host = None
        # A run is open from the first audio chunk sent to the audio-stop that
        # ends it; `_awaiting_since` is when that stop went out, and is cleared by
        # the next thing Home Assistant PRODUCES - a transcript, an answer, audio,
        # an error. Chatter that only says it is alive leaves the debt standing.
        self._run_open = False
        self._awaiting_since = None
        self.player = Player(duck=config["duck"])
        self.toaster = Toaster()
        # Whether an answer is spoken at all. `toast` shows the text and plays
        # nothing, so its audio must not reach the player: the chunks would be
        # charged to a budget nothing ever drains them from.
        self._speaks = config["answer"] in ("speak", "both")
        # Everything we send goes through one queue and one writer task. Audio is
        # fifty chunks a second and their ORDER is the recording: firing a task per
        # chunk would hand the ordering to the scheduler, and speech reassembled out
        # of order is not speech. Bounded, because a peer that stops reading would
        # otherwise be answered with the box's memory.
        self._out = asyncio.Queue(maxsize=MAX_QUEUED)
        self._dropped = 0

    # ---- server side

    async def handle_client(self, reader, writer):
        peer = writer.get_extra_info("peername")
        host = peer[0] if peer else "?"
        if self.writer is not None:
            if host != self._peer_host:
                # One session at a time, and a STRANGER never takes it. The port
                # has no authentication, so letting any address displace the live
                # connection would let anything on the LAN take the microphone
                # away from Home Assistant mid-sentence.
                LOG.warning("refusing a second connection from %s", host)
                try:
                    writer.close()
                except OSError:
                    pass
                return
            # The address that already holds the session is Home Assistant
            # reconnecting. Its previous connection can be alive at the TCP level
            # while the task behind it is not - a pipeline that never ended leaves
            # exactly that - and refusing the new one then keeps the box unusable
            # until the service is restarted by hand.
            LOG.info("Home Assistant reconnected from %s - dropping the previous connection", host)
            self._end_session()
        _keepalive(writer)
        LOG.info("Home Assistant connected from %s", host)
        self.writer = writer
        self._peer_host = host
        # A new connection owes nothing and is owed nothing: state left by a run
        # the previous one lost would otherwise be charged to this one, and an
        # expired debt would have the watchdog drop it the moment it arrived.
        self._run_open = False
        self._awaiting_since = None
        try:
            while True:
                event, payload = await read_event(reader)
                if event is None:
                    break
                if self.writer is not writer:
                    # Displaced while this read was in flight. Whatever was still
                    # buffered here belongs to a session that is over, and acting
                    # on it would reach into the one that replaced it.
                    break
                await self._on_event(event, payload)
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        except Exception as e:  # a satellite that dies on one bad event is worse
            LOG.exception("event loop error: %s", e)
        finally:
            # Only if this connection still owns the session: on a takeover the
            # replacement already holds it, and tearing its state down here would
            # silence the connection that just arrived.
            if self.writer is writer:
                LOG.info("Home Assistant disconnected")
                self._end_session()
            try:
                writer.close()
            except OSError:
                pass

    def _end_session(self):
        """Forget the current connection and everything a run left behind."""
        writer = self.writer
        self.writer = None
        self._run_open = False
        self._awaiting_since = None
        # Queued events belong to the connection that is going. The writer task
        # may not run before a replacement arrives, and a reconnect that is handed
        # the previous run's audio is worse than one handed nothing.
        while not self._out.empty():
            self._out.get_nowait()
        self.player.stop()
        # The NOTES are deliberately left alone, which is the opposite of what is
        # right for audio three lines up. Abandoned audio holds the one sound
        # device and talks over whatever the next connection does; a note holds
        # nothing and is gone in seconds. And the common case here is Home
        # Assistant reconnecting after a turn that FINISHED, so dropping would
        # throw away a correct answer - which on `answer: "toast"` is the whole
        # of it.
        if writer is not None:
            try:
                writer.close()
            except OSError:
                pass

    async def watchdog(self):
        """Drop a connection that owes an answer and has gone quiet.

        This is the only lever this side has over a pipeline stuck in Home
        Assistant, and it is enough: its satellite reconnects on its own once the
        socket is gone.
        """
        while True:
            await asyncio.sleep(WATCHDOG_INTERVAL)
            since = self._awaiting_since
            if since is None or self.writer is None:
                continue
            if time.monotonic() - since < RUN_TIMEOUT:
                continue
            LOG.warning(
                "no answer in %.0f s - dropping the connection so Home Assistant can reconnect",
                RUN_TIMEOUT,
            )
            self._end_session()

    async def _on_event(self, event, payload):
        etype = event["type"]
        data = event["data"]
        # Only output clears the debt. "Anything at all" was too generous, and it
        # cost a living-room microphone an hour: Home Assistant answered every new
        # press with `transcribe` while its pipeline delivered nothing, and each of
        # those reset the clock, so a run that was already dead kept the session
        # alive. A pipeline saying it is alive is not this run making progress.
        if etype in PROGRESS_EVENTS:
            self._awaiting_since = None
        if etype == "describe":
            await self._send_info()
        elif etype == "ping":
            await self._send("pong", {"text": data.get("text")})
        elif etype == "run-satellite":
            LOG.info("pipeline ready")
        elif etype == "pause-satellite":
            LOG.info("pipeline paused")
        elif etype == "transcript":
            LOG.info("heard: %s", data.get("text", ""))
        elif etype == "synthesize":
            text = data.get("text", "")
            LOG.info("answer: %s", text)
            if self.config["answer"] in ("toast", "both"):
                self.toaster.show(text)
        elif etype == "audio-start":
            LOG.info("answer audio: %s Hz", data.get("rate"))
            if self._speaks:
                self.player.start(
                    int(data.get("rate") or SND_RATE),
                    int(data.get("width") or SND_WIDTH),
                    int(data.get("channels") or SND_CHANNELS),
                )
        elif etype == "audio-chunk":
            if self._speaks:
                self.player.write(payload)
        elif etype == "audio-stop":
            if self._speaks:
                self.player.finish(self._played_when_heard(self.writer))
            else:
                # Nothing was played, so there is nothing to wait for - and
                # queueing a whole answer nobody will hear would spend the
                # player's budget on it.
                self.send("played")
        else:
            # Anything unrecognised is worth a line: this is a protocol we speak
            # from the outside, and silence about an unexpected event is how a
            # missing answer looks like nothing at all.
            LOG.info("event: %s %s", etype, {k: v for k, v in data.items() if k != "audio"})

    def _played_when_heard(self, writer):
        """What the player calls once the answer has really been heard.

        **Nothing here waits, and that is the whole shape of it.** The obvious
        version - awaiting the player in `_on_event` - frees the event loop but
        not the connection: that coroutine is the only thing reading the socket,
        and `ping`/`pong` is answered from it. Home Assistant pings every 2 s and
        drops a satellite that has not answered in 5, and the drop ends the
        session, which stops the player, so waiting there reproduced the exact
        failure this exists to fix. Measured: a pong 11 s late on a 30 s answer.

        The player calls this from its own thread, so it hops back to the loop -
        `send` is queue-based, so nothing is awaited there either.
        """
        loop = asyncio.get_running_loop()

        def heard():
            loop.call_soon_threadsafe(self._say_played, writer)

        return heard

    def _say_played(self, writer):
        if self.writer is not writer:
            # The connection that owed this `played` is gone. Sending it now would
            # credit the one that replaced it with a turn it never took, and Home
            # Assistant ends an announcement's wait on it.
            return
        self.send("played")

    def send(self, etype, data=None, payload=b""):
        """Queue one event, reporting whether it got in.

        Safe to call from the microphone's reader callback.
        """
        if self.writer is None:
            return False
        try:
            self._out.put_nowait((etype, data, payload))
            return True
        except asyncio.QueueFull:
            pass
        if etype == "audio-chunk":
            # A peer that has stopped reading. Audio is the only thing arriving
            # faster than it leaves, so audio is what gives way: losing 20 ms of
            # speech is a worse recording, while queueing it all is a dead box.
            self._dropped += 1
            if self._dropped % 50 == 1:
                LOG.warning("outbound queue full - dropping audio (%d so far)", self._dropped)
            return False
        # Every other event carries the shape of a run - where it begins, where it
        # ends - so dropping one leaves Home Assistant waiting on something that
        # can no longer arrive. A full queue already means a peer that stopped
        # reading, so end the session and let it reconnect.
        LOG.warning("outbound queue full - dropping the connection rather than %s", etype)
        self._end_session()
        return False

    async def drain(self):
        """The only place anything is written, so the order queued is the order sent."""
        while True:
            etype, data, payload = await self._out.get()
            writer = self.writer
            if writer is None:
                continue
            try:
                await write_event(writer, etype, data, payload)
            except (ConnectionResetError, BrokenPipeError, OSError):
                # The whole session goes, not just the writer: a half-dropped one
                # leaves a run open that nothing will ever close. Unless the write
                # was already stale - a reconnect during the await - in which case
                # ending the session would kill the connection that replaced it.
                if self.writer is writer:
                    self._end_session()

    async def _send(self, etype, data=None, payload=b""):
        return self.send(etype, data, payload)

    async def _send_info(self):
        """What this box is, in Wyoming's vocabulary.

        `supports_trigger` is false: Home Assistant starts nothing here, the mic
        key does. There is no wake word either - the button IS the wake word, which
        is the whole advantage of a microphone you are already holding.
        """
        name = self.config["name"]
        info = {
            "satellite": {
                "name": name,
                "attribution": {"name": "tvbox", "url": "https://github.com/Andy1210/tvbox"},
                "installed": True,
                "description": "tvbox: the TV remote's microphone",
                "version": "1",
                "area": self.config["area"] or None,
                "has_vad": False,
                "active_wake_words": [],
                "max_active_wake_words": 0,
                "supports_trigger": False,
            },
            "mic": [
                {
                    "name": name,
                    "attribution": {"name": "tvbox", "url": "https://github.com/Andy1210/tvbox"},
                    "installed": True,
                    "description": "Fire TV remote microphone",
                    "version": "1",
                    "mic_format": {"rate": MIC_RATE, "width": MIC_WIDTH, "channels": MIC_CHANNELS},
                }
            ],
            "snd": [
                {
                    "name": name,
                    "attribution": {"name": "tvbox", "url": "https://github.com/Andy1210/tvbox"},
                    "installed": True,
                    "description": "tvbox audio output",
                    "version": "1",
                    "snd_format": {"rate": SND_RATE, "width": SND_WIDTH, "channels": SND_CHANNELS},
                }
            ],
        }
        await self._send("info", info)

    # ---- microphone side

    def on_press(self):
        # The run deliberately does NOT start here. A key tapped too briefly to
        # produce a frame would open one with no audio in it, and a Wyoming ASR
        # service asked to transcribe an empty stream has nothing to answer with:
        # wyoming-faster-whisper raises out of its event handler, so the pipeline
        # waits for a transcript that can never arrive and the satellite is stuck
        # listening until something drops the connection.
        if self.writer is None:
            LOG.warning("no Home Assistant connection - nothing to listen")
            return
        LOG.info("mic key down")

    def on_audio(self, pcm):
        if self.writer is None:
            return
        if not self._run_open:
            self._start_pipeline()
        self.send(
            "audio-chunk",
            {"rate": MIC_RATE, "width": MIC_WIDTH, "channels": MIC_CHANNELS, "timestamp": int(time.monotonic() * 1000)},
            pcm,
        )

    def on_release(self):
        if not self._run_open:
            # Which of the two it was decides where to look next, so say it.
            if self.writer is None:
                LOG.info("mic key up - no Home Assistant connection")
            else:
                LOG.info("mic key up - the remote sent no audio, so nothing was started")
            return
        self._run_open = False
        LOG.info("mic key up")
        if not self.send("audio-stop", {"timestamp": int(time.monotonic() * 1000)}):
            # A run without its end never finishes, and `send` has already dropped
            # the session if there was one to drop. Not arming the watchdog is the
            # point: there is nothing left to wait a minute for.
            LOG.warning("the end of the recording could not be sent")
            return
        self._awaiting_since = time.monotonic()

    def _start_pipeline(self):
        run = {
            # The button already did what a wake word does, so the pipeline starts
            # at speech-to-text; it ends at text-to-speech because the answer is
            # meant to be heard in the room, not read somewhere.
            "start_stage": "asr",
            "end_stage": "tts",
            "restart_on_end": False,
            "snd_format": {"rate": SND_RATE, "width": SND_WIDTH, "channels": SND_CHANNELS},
        }
        if self.config["pipeline"]:
            run["name"] = self.config["pipeline"]
        self._run_open = True
        LOG.info("speech on the way - starting a pipeline")
        self.send("run-pipeline", run)
        self.send("audio-start", {"rate": MIC_RATE, "width": MIC_WIDTH, "channels": MIC_CHANNELS})


# ---------------------------------------------------------------- main


async def amain():
    config = load_config()
    if not config["enabled"]:
        LOG.info("voice satellite disabled (config.voice.enabled)")
        return 0
    if find_remote_node() is None:
        LOG.info("no Amazon remote present yet - waiting for one")

    loop = asyncio.get_running_loop()
    satellite = Satellite(config)
    mic = RemoteMic(loop, satellite.on_press, satellite.on_audio, satellite.on_release)

    server = await asyncio.start_server(satellite.handle_client, "0.0.0.0", config["port"])
    LOG.info("wyoming satellite '%s' on port %d", config["name"], config["port"])
    try:
        await asyncio.gather(
            server.serve_forever(), mic.run(), satellite.drain(), satellite.watchdog()
        )
    finally:
        mic.close()
        satellite.player.close()
    return 0


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        return asyncio.run(amain())
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        # A box without libopus, or a config with a port systemd cannot bind, fails
        # the same way every time. Exiting 0 says "there is nothing to run here"
        # rather than asking systemd to try again five times and give up with the
        # unit in a failed state - the log line is what a person needs either way.
        LOG.error("voice satellite cannot start: %s", e)
        return 0


if __name__ == "__main__":
    sys.exit(main())
