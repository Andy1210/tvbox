# Screen mirroring (Miracast / Wi-Fi Display)

Show an Android phone's screen on the TV. Settings → Network → Screen mirroring,
then pick the box in the phone's cast menu (Samsung calls it Smart View). No app
on the phone, no PIN, no account.

## What it needs

**The whole wifi radio, for the length of the session.** The phone connects to
the box directly over Wi-Fi Direct, not through the router, and this board cannot
run a station and a group owner at the same time - the group comes up and tears
itself down inside the same second.

| The box is on…         | Mirroring                                            |
| ---------------------- | ---------------------------------------------------- |
| Ethernet               | works, and costs nothing; the radio was idle anyway  |
| Wifi only              | works, but the box is offline while it runs          |
| Wifi via a USB adapter | works, and costs nothing; the internal radio is free |

On a wifi-only box the network goes down when mirroring starts and comes back on
**the same connection** when it stops - by name, not "whichever profile
autoconnects", which is a different promise on a box that knows several networks.
The page warns before you start; it does not refuse, because while someone is
watching their phone on the TV the box has no use for the network.

Two things make that safe to do. The radio state is restored as it was found, so
a box whose owner keeps wifi off does not silently gain it. And the unit carries
`RuntimeMaxSec`, because a session nobody ends would leave a box offline with no
way to reach it.

**A phone that still speaks Miracast.** Samsung does (Smart View). Pixels do not -
Google dropped it in favour of Cast, which cannot be implemented without a
Google-signed device certificate. iPhones never did; AirPlay is a separate job,
and notably it would NOT need the radio at all, because it runs over the ordinary
LAN.

## How it is put together

Two halves, split along the privilege line:

```
Settings page ─POST /tvbox/api/miracast/start─→ shell/miracast.js
                                                    │
              systemctl start tvbox-miracast.service│   (polkit: netdev, one unit, three verbs)
                                                    ▼
                                    /usr/local/sbin/tvbox-miracast   [root]
                                      wpa_supplicant → P2P group owner, ch 6
                                      ip addr, dnsmasq → the phone's lease
                                                    │
   phone associates, takes 192.168.49.x ────────────┘
                                                    │
              shell/miracast.js dials it on TCP 7236│   [no privileges]
                                    shell/wfd.js: RTSP M1-M7
                                    RTP on UDP 1028 → FIFO → the shared mpv
```

`shell/wfd.js` is a pure state machine with no sockets in it, so the whole
negotiation is unit-tested against a session captured from a real phone.

## Things that are not guessable

Each of these cost a measurement, and getting any one wrong produces a failure
with no error message anywhere.

1. **The sink dials the source.** The receiver opens the TCP connection to the
   sender's port 7236, not the other way round. Backwards, the phone joins the
   group, takes a lease, sits silent for thirty seconds and leaves.
2. **NetworkManager tears down a P2P group it did not create**, the instant the
   group registers on D-Bus. Hence our own wpa_supplicant on an interface NM has
   been told to stop managing. Marking only `p2p-*` unmanaged is not enough.
3. **Discovery is 2.4 GHz only.** A source runs P2P device discovery on channels
   1/6/11; it never scans for our SSID, so a group owner on 5 GHz is never probed
   and simply never appears in the list.
4. **Answer every parameter the source asks for.** Samsung asks for five
   `wfd_sec_*` extensions of its own and closes the session without a word if any
   are missing from the M3 reply. Unknown names are answered `none`.
5. **A leftover `p2p-wlan0-N` interface** makes the next group creation fail with
   a bare `FAIL` - the radio allows exactly one, and a group torn down by the
   driver leaves the netdev behind wpa_supplicant's back.

## Pairing is the security boundary

WPS push-button admits **whoever presses it** - that is the protocol, not this
implementation - so the guard is the window rather than a credential:

- the button opens for **two minutes** when you arm mirroring,
- it **shuts the moment a phone is in**,
- the group seats **one** device (`max_num_sta=1`),
- if nobody connects, the box **gives the radio back on its own**.

The link itself is WPA2-PSK with a random passphrase either way; the push button
is only how that passphrase is handed over. A neighbour in range can see the
box's name in their cast list while it is armed - a group owner has to beacon -
but cannot join it.

## What is on screen while it runs

Nothing of ours. mpv plays **behind** the launcher's window, so anything the
launcher draws lands on top of the phone - the Settings page that armed
mirroring did exactly that at first, and Home's tiles were printed over the
picture even after the window was made transparent, because the view underneath
kept rendering.

So when the first frames arrive the shell pushes a `mirroring` destination and
turns the window transparent; the launcher drops its view and renders only a
hint, which fades after four seconds. **Back stops mirroring** and is the only
control - there is nothing to configure mid-session, and someone holding a
remote in front of their own phone screen needs exactly one thing.

The shell pushes another destination when frames stop, so the screen follows the
shell rather than guessing: the shell is the one that knows whether a phone is
still sending.

## Quality

The phone picks the format. A Galaxy S26 Ultra chooses 1920x1080p30, H.264 High
profile, with AAC stereo, at about 1.3 Mbit/s for a mostly-static screen.

The Pi 5 has **no hardware H.264 decoder** (it kept only HEVC) and Miracast
mandates H.264, so every frame is decoded on the CPU: measured at **15.5x
realtime**, roughly a fifth of one core at 1x. 1080p60 is deliberately left out
of what the box advertises.

That software decode is also why mirroring must stay on mpv's `--vo=gpu`: the
zero-copy output in `videoout.js` shows nothing at all for a software-decoded
stream. It engages only from 1440p up, so a mirrored phone never reaches it.

## When it does not work

- **The box is not in the phone's list.** Close the cast menu and reopen it -
  it caches. Check the radio is actually free (`ip -4 addr show wlan0`).
- **It appears, but connecting fails part-way.** Almost always distance: the WPS
  exchange needs a few reliable round trips, and discovery survives a weak link
  that the handshake does not. Measured across a flat: found, paired, dead a few
  packets later; same room, everything through to the stream.
- **It connects but nothing appears.** Look at the RTSP log for where the
  negotiation stopped; `journalctl -u tvbox-miracast` has the radio side.
