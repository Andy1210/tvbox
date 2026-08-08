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
import ctypes
import glob
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
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
        "port": int(cfg.get("port") or DEFAULT_PORT),
        "name": str(cfg.get("name") or socket.gethostname()),
        "area": str(cfg.get("area") or ""),  # a hint for Home Assistant's setup dialog
        "pipeline": cfg.get("pipeline") or None,  # a named Assist pipeline, else the default
        # How far to pull the box's own audio down while the answer plays, so a
        # film does not talk over it. 1.0 leaves it alone.
        "duck": float(cfg.get("duck", 0.3)),
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
    if data_length:
        extra = await reader.readexactly(data_length)
        try:
            data = {**data, **json.loads(extra.decode("utf-8"))}
        except ValueError:
            pass
    payload_length = header.get("payload_length") or 0
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
        self._pcm = (ctypes.c_short * (FRAME_SAMPLES * 6))()

    def decode(self, frame):
        got = self._lib.opus_decode(self._dec, frame, len(frame), self._pcm, FRAME_SAMPLES * 6, 0)
        if got <= 0:
            return b""
        return bytes(bytearray(self._pcm)[: got * 2 * self._channels])

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


def show_toast(text):
    """Put the answer on the TV as a note.

    A spoken answer talks over whatever is playing; a toast does not, which is why
    both are offered and both are the default. The shell draws it - the same note
    Home Assistant can already push over MQTT - and it is on loopback, so a box
    with no shell running simply gets a failed connection and carries on.
    """
    text = (text or "").strip()
    if not text:
        return
    body = json.dumps({"message": text, "duration": 8000}).encode("utf-8")
    req = urllib.request.Request(SHELL_NOTIFY_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:  # the shell may be restarting; an answer is not worth a crash
        LOG.warning("could not show the answer on screen: %s", e)


# ---------------------------------------------------------------- playback


class Player:
    """Plays the answer, and gets out of the way of whatever else is playing.

    pw-cat reads raw PCM from stdin, so the chunks go straight there as they
    arrive rather than through a temporary file. The box's own output is pulled
    down for the duration: a spoken answer during a film should be audible without
    stopping the film, and restoring the exact level afterwards is what keeps this
    from being noticed.
    """

    def __init__(self, duck=0.3):
        self._proc = None
        self._duck = duck
        self._restore = None

    def _wpctl(self, *args):
        if not shutil.which("wpctl"):
            return None
        try:
            return subprocess.run(["wpctl", *args], capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return None

    def _duck_start(self):
        if self._duck >= 1.0:
            return
        got = self._wpctl("get-volume", "@DEFAULT_AUDIO_SINK@")
        if not got or got.returncode != 0:
            return
        try:
            self._restore = float(got.stdout.strip().split()[-1])
        except (ValueError, IndexError):
            self._restore = None
            return
        self._wpctl("set-volume", "@DEFAULT_AUDIO_SINK@", str(round(self._restore * self._duck, 3)))

    def _duck_end(self):
        if self._restore is not None:
            self._wpctl("set-volume", "@DEFAULT_AUDIO_SINK@", str(self._restore))
            self._restore = None

    def start(self, rate, width, channels):
        self.stop()
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
        try:
            self._duck_start()
            self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as e:
            LOG.error("cannot play audio: %s", e)
            self._proc = None
            self._duck_end()

    def write(self, chunk):
        if not self._proc or not self._proc.stdin:
            return
        try:
            self._proc.stdin.write(chunk)
        except (BrokenPipeError, OSError):
            self._proc = None

    def stop(self):
        proc, self._proc = self._proc, None
        if proc:
            try:
                if proc.stdin:
                    proc.stdin.close()
                proc.wait(timeout=10)
            except (OSError, subprocess.SubprocessError):
                try:
                    proc.kill()
                except OSError:
                    pass
        self._duck_end()


# ---------------------------------------------------------------- satellite


class Satellite:
    """One Home Assistant connection at a time, which is all it ever opens."""

    def __init__(self, config):
        self.config = config
        self.writer = None
        self.player = Player(duck=config["duck"])
        # Everything we send goes through one queue and one writer task. Audio is
        # fifty chunks a second and their ORDER is the recording: firing a task per
        # chunk would hand the ordering to the scheduler, and speech reassembled out
        # of order is not speech.
        self._out = asyncio.Queue()
        self._writer_task = None

    # ---- server side

    async def handle_client(self, reader, writer):
        peer = writer.get_extra_info("peername")
        LOG.info("Home Assistant connected from %s", peer[0] if peer else "?")
        self.writer = writer
        try:
            while True:
                event, payload = await read_event(reader)
                if event is None:
                    break
                await self._on_event(event, payload)
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        except Exception as e:  # a satellite that dies on one bad event is worse
            LOG.exception("event loop error: %s", e)
        finally:
            LOG.info("Home Assistant disconnected")
            if self.writer is writer:
                self.writer = None
            self.player.stop()
            try:
                writer.close()
            except OSError:
                pass

    async def _on_event(self, event, payload):
        etype = event["type"]
        data = event["data"]
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
                await asyncio.to_thread(show_toast, text)
        elif etype == "audio-start":
            LOG.info("answer audio: %s Hz", data.get("rate"))
            if self.config["answer"] in ("speak", "both"):
                self.player.start(
                    int(data.get("rate") or SND_RATE),
                    int(data.get("width") or SND_WIDTH),
                    int(data.get("channels") or SND_CHANNELS),
                )
        elif etype == "audio-chunk":
            self.player.write(payload)
        elif etype == "audio-stop":
            self.player.stop()
            await self._send("played")
        else:
            # Anything unrecognised is worth a line: this is a protocol we speak
            # from the outside, and silence about an unexpected event is how a
            # missing answer looks like nothing at all.
            LOG.info("event: %s %s", etype, {k: v for k, v in data.items() if k != "audio"})

    def send(self, etype, data=None, payload=b""):
        """Queue one event. Safe to call from the microphone's reader callback."""
        if self.writer is not None:
            self._out.put_nowait((etype, data, payload))

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
                self.writer = None

    async def _send(self, etype, data=None, payload=b""):
        self.send(etype, data, payload)
        return True

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
        if self.writer is None:
            LOG.warning("no Home Assistant connection - nothing to listen")
            return
        LOG.info("mic key down - starting a pipeline")
        self._start_pipeline()

    def on_audio(self, pcm):
        self.send(
            "audio-chunk",
            {"rate": MIC_RATE, "width": MIC_WIDTH, "channels": MIC_CHANNELS, "timestamp": int(time.monotonic() * 1000)},
            pcm,
        )

    def on_release(self):
        LOG.info("mic key up")
        self.send("audio-stop", {"timestamp": int(time.monotonic() * 1000)})

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
        await asyncio.gather(server.serve_forever(), mic.run(), satellite.drain())
    finally:
        mic.close()
        satellite.player.stop()
    return 0


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        return asyncio.run(amain())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
