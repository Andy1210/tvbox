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
  "duck": 0.3 // how far to pull the box's own audio down while the answer plays
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
  address has not changed.
- **The answer plays but the light is wrong.** The box has no area, or has the
  wrong one - see [Which room it acts in](#which-room-it-acts-in).
- **The remote's microphone itself can be faulty.** A dead microphone still sends
  its button and still streams; what arrives is a hum with no speech in it. Try
  another remote before suspecting the box.
