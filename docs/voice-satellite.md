# Talking to the box through the remote

The TV remote in your hand has a microphone. This turns it into a Home Assistant
**voice satellite**: hold the mic key, say what you want, and Home Assistant runs
its own pipeline - speech to text, whatever conversation agent is configured, text
to speech - then sends the spoken answer back to play on the TV.

Nothing about the assistant lives on the box. No URL, no token, no model. Home
Assistant connects to the box, not the other way round, so whoever owns the Home
Assistant decides what answers and in what language. A box with no Home Assistant
simply has this switched off.

- [Why the remote and not a microphone by the TV](#why-the-remote-and-not-a-microphone-by-the-tv)
- [Turning it on](#turning-it-on)
- [Which room it acts in](#which-room-it-acts-in)
- [How the remote's microphone works](#how-the-remotes-microphone-works)
- [A run, and who holds the connection](#a-run-and-who-holds-the-connection)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [When it does not work](#when-it-does-not-work)

## Why the remote and not a microphone by the TV

A room with a voice puck in it already has far-field listening, and a USB
microphone next to a television is a worse version of that: it hears the
television. The remote is different in the one way that matters - it is already in
your hand, a few centimetres from your mouth, and its button means you never say a
wake word. That is the whole reason this exists.

## Turning it on

It is **off by default**, because switching it on opens a port on the LAN that
anything can connect to (this is how every Wyoming satellite works; the protocol
has no authentication). Turn it on in `~/.tvbox/config.json`:

```jsonc
"voice": {
  "enabled": true,
  "port": 10700, // what Home Assistant connects to
  "name": "tvbox-livingroom", // defaults to the hostname
  "area": "Living room", // only a hint for the setup dialog; the real room is the device's area
  "pipeline": null, // a named Assist pipeline, or null for the preferred one
  "answer": "both", // both | toast | speak
  "duck": 0.3 // how far to pull a playing film down while the answer plays
}
```

Then restart the service and add the box in Home Assistant:

```sh
systemctl --user restart tvbox-voice
```

**Settings -> Devices & services -> Add integration -> Wyoming Protocol**, and give
it the box's address and port. A satellite entity appears, named after the box.

The service is installed and enabled on every box; with `enabled` unset it starts,
finds nothing to do and exits 0, which is why it is not a Restart=always unit.

## Which room it acts in

**Assign the box to an area in Home Assistant.** That is what makes "turn off the
light" mean the light in the room you are sitting in: the pipeline hands the
conversation agent the device the request came from, and the agent resolves the
room from that device's area. It is the same mechanism a Voice PE puck uses, and
it is Home Assistant's, not ours - the box sends the area only as a hint on first
setup.

Worth assigning the box's **media player** device to the same area while you are
there, so "play something on the TV" lands in the same room.

To check it without saying a word, run the pipeline as that device:

```yaml
# Developer tools -> Actions, or a WebSocket assist_pipeline/run with device_id
action: conversation.process
data:
  text: kapcsold fel a lámpát
```

A correct setup answers with the room's own light. A box with no area gets whatever
the agent guesses, which is usually the wrong room rather than an error - so the
absence of an area is easy to miss.

## How the remote's microphone works

Not over Bluetooth audio: the remote is a HID device and the audio arrives as
vendor HID reports on the same node its buttons do.

| Direction     | Report                         | Meaning                                      |
| ------------- | ------------------------------ | -------------------------------------------- |
| remote -> box | consumer `0x02`, usage `0x221` | the mic key is down (release sends `0x0000`) |
| box -> remote | output `0xF2` = `01`           | start streaming                              |
| remote -> box | input `0xF0`, 80 bytes         | one Opus frame                               |
| box -> remote | output `0xF2` = `00`           | stop                                         |

**The order is the trick**: the start command means nothing before the key press.
Each frame is CELT wideband, 20 ms, mono, so decoding gives 16 kHz PCM - exactly
what Assist wants, and nothing is resampled anywhere.

Two consequences worth knowing:

- **Sending that start command is a WRITE to the remote's hidraw node**, which is
  why `provision.sh` grants the `input` group `0660` on it rather than the `0640`
  the app-button reads needed. Root, so **an OTA update cannot deliver it**: a box
  that has only ever updated over the air has the code but not the permission, and
  the log says so (`is the hidraw rule 0660?`).
- **The audio is only as good as the BLE link.** A remote across the room from a
  box with a poor antenna loses frames, and lost frames sound like crackle rather
  than silence. If a recording comes back choppy, that is the link, not the codec:
  compare the frames received against the seconds they cover.

## A run, and who holds the connection

**A run starts on the first decoded frame, not on the key press.** A key tapped
too briefly to produce one would otherwise open a run with no audio in it, and a
Wyoming speech-to-text service asked to transcribe an empty stream has nothing to
answer with - wyoming-faster-whisper raises out of its event handler, which ends
the request without a reply. The pipeline then waits for a transcript that cannot
arrive, and the satellite entity sits in `listening` for as long as that lasts. So
a tap that captured nothing sends nothing, and the log says
`the remote sent no audio, so nothing was started`.

**The session is single, and the address that holds it may take it back.** The
port has no authentication, so a connection from an unknown address is refused
rather than allowed to take the microphone away mid-sentence. Home Assistant
reconnecting is not that: it comes from the address that already holds the
session, and its previous connection can be alive at the TCP level while the task
behind it is not. That one displaces the old connection instead of being turned
away, because refusing it leaves the box unusable until the service is restarted
by hand. Sockets also carry TCP keepalive, so a peer that disappears without
closing is reaped by the kernel rather than holding the session for ever.

**A run that is never answered drops the connection.** Home Assistant sends
nothing at all while a pipeline is stuck, not even a ping, so a minute of silence
after `audio-stop` is taken as a lost run: the satellite closes the socket and its
Wyoming integration reconnects on its own. It is the only lever this side has, and
the log line is `no answer in 60 s`. **Audio is also the only thing that gives way
when the outbound queue fills.** Everything else carries the shape of a run -
where it begins, where it ends - so an event that cannot be queued drops the
connection at once rather than leaving Home Assistant waiting for something that
can no longer arrive.

**Nothing about playing the answer may hold up the connection.** The player
consumes audio in real time while Home Assistant hands the whole answer over in
a couple of seconds, so the pipe fills and a write to it blocks. Doing that from
the task that reads the socket ties that task to real time for the rest of the
answer, and it is one unbroken stall rather than many short ones, because reading
an event out of a buffer that already holds data never gives the loop a turn.

Home Assistant pings every 2 s and drops a satellite that has not answered in
**5**, and the drop ends the session, which stops the player - so the same
blocking write both cut the answer off mid-sentence and flapped the connection.
Measured as the worst uninterrupted stall, across three harnesses that disagree
on the seconds and agree on the shape: a 3 s answer costs 1.5-3.0 s and survives,
a 6 s answer 4.5-6.0 s and is on the threshold, and by 12 s every measurement is
past it. Which is why it only ever showed on long answers.

**The player now has a thread of its own and the connection waits for nothing.**
Everything the socket side does is put a command on a queue: begin an answer,
here is a chunk, play it out, stop. That thread owns the player, the pipe and the
ducked volume, so no two answers can be half-open at once. A ceiling on what may
wait (16 MB - about six minutes of speech, or 87 s if a text-to-speech engine
hands over 48 kHz stereo) is what the blocking write used to provide: the port
takes a connection with no credentials, so without one a peer is bounded only by
its link rate. It covers everything the queue holds, not only the audio: an
`audio-stop` is 26 bytes on the wire and a command with a callback in memory, so
a flood of those was the more expensive of the two. Past the ceiling what arrives
is dropped, with a line in the log saying so.

`played` - which Home Assistant waits for before it considers the answer
delivered - is said by that thread once the audio has really played. **Waiting for
it on the connection's side does not work and was tried twice**: freeing the event
loop is not the same as freeing the read loop, and the read loop is the only thing
that answers a ping.

## The answer on the screen

`voice.answer` decides how an answer reaches the room:

| Value            | What happens                                   |
| ---------------- | ---------------------------------------------- |
| `both` (default) | spoken, and the text as a note on screen       |
| `toast`          | text only - nothing interrupts what is playing |
| `speak`          | spoken only, as a puck would                   |

The note is the box's ONE notification surface, not something the voice service
invented: Home Assistant already pushes the same thing over the MQTT `notify`
topic, and now anything on the box can raise one.

- **An app's page**: `POST /tvbox/api/notify` with `{title?, message, duration?,
raise?}`. A local app shares the shell's origin, so a plain `fetch` works.
- **A host plugin**: `host.notify({ message: "…" })`.

Both go through the same cap (title 120 characters, message 400, duration a
minute) because the launcher draws whatever it is handed, and neither an app nor a
language model has promised a length.

A note with a `message` is drawn in a strip at the bottom of the screen that sits
over whatever is running, including a fullscreen app, without taking the remote
from it (`tvbox-overlay`, see the compositor's
[IPC protocol](https://github.com/Andy1210/tvbox-wc/blob/main/docs/ipc.md)).

**On a box whose compositor predates that** (tvbox-wc 0.1.7), the strip is not used
at all and the note stays in the launcher, visible only while the launcher is what
is on screen. That is deliberate: without the compositor's placement the window
would map fullscreen, and a fullscreen translucent surface over a film costs more
than the note is worth.

**One kind of note stays in the launcher**: the structured ones the shell sends
with a `kind` and no text - a remote's low battery, for instance - because the
sentence around the name and the percentage is a localized string that lives in
the launcher. Putting those in the strip would mean an empty bar over the film.

## What it deliberately does not do

- **No wake word.** The button is the wake word. Nothing listens until it is held,
  which is also the honest answer to "is this thing always listening".
- **No assistant of its own.** The box has no endpoint, no key and no model, and
  the answer comes from whatever Home Assistant is set up to use.
- **No announcements yet.** The satellite advertises `supports_trigger: false`, so
  Home Assistant starts nothing here; a spoken notification still goes through the
  reminder/notify path.
- **It does not stop your film.** The box's output is pulled down while the answer
  plays (`voice.duck`) and restored afterwards; set it to `1.0` to leave the volume
  alone.

## When it does not work

- **The key is seen but nothing is heard.** Almost always the udev rule: the log
  line is `cannot start the microphone ... is the hidraw rule 0660?`. Re-run
  `deploy/provision.sh` (or reflash); OTA cannot do it.
- **Nothing happens at all.** `systemctl --user status tvbox-voice`. With
  `voice.enabled` unset the service exits 0 by design.
- **Home Assistant shows the satellite as unavailable.** It connects to the box, so
  check the port is reachable from Home Assistant's host and that the box's
  address has not changed. `refusing a second connection` in the log means the
  address it is connecting from is not the one holding the session.
- **The satellite is stuck in `listening`.** The pipeline is waiting on a stage
  that will not finish - speech to text is the usual one. Look at that service's
  log rather than the box's: the run reached it, which is why `heard:` never
  appeared here. The connection drops itself after a minute either way.
- **The answer is cut off part way and the satellite disconnects.** Fixed for the
  cause described above; a box that still does it is on an older release. It only
  ever showed on answers longer than about six seconds, and Home Assistant's log
  is where it is visible - the box's side looks like an ordinary reconnect.
- **The answer plays but the light is wrong.** The box has no area, or has the
  wrong one - see [Which room it acts in](#which-room-it-acts-in).
- **The remote's microphone itself can be faulty.** A dead microphone still sends
  its button and still streams; what arrives is a hum with no speech in it. Try
  another remote before suspecting the box.
