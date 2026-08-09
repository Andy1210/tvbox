# Saves sharing

Continue a game in another room. A box offers the folders its apps declare - an
emulator's save files - read-only to another tvbox, and the other box brings a
copy across when someone asks it to.

The household case this exists for has no NAS in it, and should not need one: two
boxes, two rooms, one save.

**Settings → Network → Saves sharing.** Off until someone turns it on.

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
  "paths": ["config/retroarch/saves", "config/retroarch/states"]
}
```

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

Asymmetric on purpose - only one end needs a person at the TV.

1. On the box that **has** the save: _Let another box connect_. It shows a
   four-digit code for five minutes.
2. On the other box: _Find a box_. It sweeps its own /24 for the pairing port,
   which is only open while a box is actually waiting to pair - so the sweep
   finds the box someone just walked up to, and nothing at all when nobody is
   offering. Pick it, type the code.

Nobody types an address, and there is no discovery service: the port being open
is the announcement, and the page behind it carries a marker so a sweep can tell
a box from anything else holding that port.

## Credentials

The box hands over a token minted for its app shares alone - never the
[file server](file-server.md)'s password, which unlocks everything that box
offers, reads and writes. This one is read-only, reaches nothing but the declared
folders, and can be revoked on its own by turning the shares off.

It is minted when the first share is switched on rather than at boot, so a box
that never offers anything has no credential sitting in its config. Both ends
live in `~/.tvbox/config.json` (chmod 600) like every other secret, and the
launcher is only ever told whether one is set.

## What it runs on

`rclone serve webdav`, supervised, no root - the same binary the file server and
the network shares use, so a box that has one has all three. Port 8096 by
default, `--read-only`, credentials through the environment rather than argv
(any process on the box can read a command line).

The shares are rebuilt from the manifest each time the set changes, so a share
someone turned off cannot linger as a live symlink.

## Files

| Path                                                                                      | What                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [shell/appshares.js](../shell/appshares.js)                                               | What this box offers: the entries, the root, the server. |
| [shell/peers.js](../shell/peers.js)                                                       | The other box: the sweep, the pairing, the pull.         |
| [shell/pairing/peer.js](../shell/pairing/peer.js)                                         | Hands a peer the token, gated by the code on screen.     |
| [launcher/src/settings/pages/appshares.tsx](../launcher/src/settings/pages/appshares.tsx) | The screen.                                              |
