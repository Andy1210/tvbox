# App sharing

An app's own folders, read by the tvbox in the other room. The app declares which
folders those may be, a person switches them on, and the other box brings a copy
across when someone asks it to.

Saves are the obvious use - two boxes, two rooms, one save, and a household that
has no NAS and should not need one - but nothing in the box knows that. The shell
provides the mechanism and the permission; the words for it belong to whichever app
is sharing.

**Settings → Network → App sharing** is the permission surface: what is offered,
which boxes are let in, and forget. **The action lives in the app**, through the
`shares` [capability](capabilities.md) - which also lets it say which side is newer
before anything is copied - so an emulator can say "continue in the
other room" in its own screen, and a box without one never sees the sentence.

## The one rule

A box **pulls**. It never pushes.

Two boxes playing the same game would otherwise overwrite each other's save the
moment both quit, and the loser would never find out. So there is no sync, no
"keep these in step", and no pairing that starts copying: one box offers, and
somebody at the other box asks. That is also why the copy is `rclone copy` rather
than `sync` - nothing is deleted on either side - and why what a pull replaces is
moved into `~/.cache/tvbox/appshares-replaced/<timestamp>/` instead of being
overwritten.

## What an app may offer

Nothing an app asks for at runtime. A manifest declares it:

```json
"shares": {
  "flatpak": "org.libretro.RetroArch",
  "paths": ["config/retroarch/saves", "config/retroarch/states"],
  "exclude": ["**/Cache/**", "**/Logs/**"]
}
```

`exclude` is what stops a pull dragging things that are not saves: an emulator's
shader cache sits inside the same folder, runs to hundreds of megabytes, and is
rebuilt on whichever box needs it. The patterns only ever narrow a copy, so a bad
one costs files nobody wanted rather than reaching anything new.

The paths are relative to the app's **own** root - its flatpak's per-user data
dir when it names one it already depends on, otherwise its own bundle dir. That
is the same anchor `backup.paths` use, and the same helper resolves both, so the
two cannot drift into different ideas of where an app ends.

The shell builds the served directory itself, out of symlinks, from that list.
There is no call an app can make that takes a path, so what it may offer is
readable before it is installed - which is the point of declaring it. A declared
path whose resolved target leaves the app's root (a symlink planted in its own
folder) is listed in Settings but never served, because rclone follows links.

**This is not containment.** An installed app runs with full trust and has the
network already, so it never needed a share to send data anywhere. What the
declaration buys is visibility: reviewable before install, listed in Settings,
and off until switched on.

## Connecting two boxes

One code, and only one end needs a person at the TV.

1. On one box: _Let another box connect_. It shows a four-digit code for five
   minutes.
2. On the other: _Find a box_. It sweeps its own /24 for the pairing port, which
   is only open while a box is actually waiting to pair - so the sweep finds the
   box someone just walked up to, and nothing at all when nobody is offering.
   Pick it, type the code.

**Both directions, once.** The box that asks sends its own key in the same
request, so the box being asked ends up able to read it too. Pairing once per
direction would mean walking back to the other TV, showing a second code and
typing it the other way round, for a relationship that is symmetric anyway. A box
that is offering nothing has no key to send; the answer says so instead of leaving
the pairing quietly one-way.

Nobody types an address, and there is no discovery service: the port being open
is the announcement, and the page behind it carries a marker so a sweep can tell
a box from anything else holding that port.

## Credentials

**A key per box, not a password for everyone.** Pairing mints a credential for
that one box - a random user name and a secret - and keeps only its hash, in the
htpasswd file rclone authenticates against. Forgetting a box removes its line and
restarts the server, so the key it holds stops working and every other box goes on
as before. One shared password could not do that: revoking it would mean breaking
every room at once.

It is never the [file server](file-server.md)'s password, which unlocks everything
that box offers, reads and writes. This one is read-only and reaches nothing but
the declared folders. Nothing is minted until someone switches a share on, so a box
that offers nothing has no credential sitting in its config, and a pairing with it
is simply one-way - which the screen says rather than leaving it to be discovered
from the other room.

**The limit worth knowing.** The box that asks sends its own key in the pairing
request, which is what makes one code enough for both directions. A four-digit code
cannot be verified in that direction without revealing it, so what receives the key
is whatever answered the address the sweep found. On a LAN with a device
impersonating a tvbox pairing page, that device gets a key. This is why the key is
per box, read-only, listed in Settings by name, and revocable there - a bad pairing
is visible and undone with one press, rather than being a password that cannot be
taken back. Everything here also travels in clear over the LAN, like the file
server's own basic auth.

## What it runs on

`rclone serve webdav`, supervised, no root - the same binary the file server and
the network shares use, so a box that has one has all three. Port 8096 by
default, `--read-only`, and `--htpasswd` pointing at
`~/.cache/tvbox/appshares.htpasswd` (0600, one line per paired box, written
before every start). No credential is ever in argv or the environment on the
serving side; a pull passes the peer's key to rclone through the environment,
because any process on the box can read a command line.

The htpasswd file is never empty of lines: with nobody paired it holds one entry
whose secret nothing has. rclone with no htpasswd would serve the shares to the
whole LAN unauthenticated, so "no keys" has to mean 401 rather than no question
asked.

The shares are rebuilt from the manifest each time the set changes, so a share
someone turned off cannot linger as a live symlink.

## Files

| Path                                                                                      | What                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [shell/appshares.js](../shell/appshares.js)                                               | What this box offers: the entries, the root, the server. |
| [shell/peers.js](../shell/peers.js)                                                       | The other box: the sweep, the pairing, the pull.         |
| [shell/pairing/peer.js](../shell/pairing/peer.js)                                         | Mints a peer's key, gated by the code on screen.         |
| [shell/preload.js](../shell/preload.js) + [shell/preload-app.js](../shell/preload-app.js) | The `shares` capability an app pulls through.            |
| [launcher/src/settings/pages/appshares.tsx](../launcher/src/settings/pages/appshares.tsx) | The screen.                                              |
