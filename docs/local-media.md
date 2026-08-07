# Local, USB and network playback

Playing what is already on the box, what is on a stick pushed into one of its USB
ports, or what sits on a NAS. The box has served its own folders OUT over WebDAV for a while
([file server](file-server.md)) and until now nothing could play what you copied
IN; this is the other half.

The shell provides the plumbing - which roots exist, listing one, mounting a stick
or a share - and the **`files` app** in the
[registry](https://github.com/Andy1210/tvbox-apps) is the screen. Install it like
any other app (HOME → "Get more apps").

## Which folders it offers

Discovered, not listed, and the same rule the file server uses
(`shell/contentdirs.js` is shared by both):

| where        | what                                                            | example              |
| ------------ | --------------------------------------------------------------- | -------------------- |
| `~/.tvbox/*` | user content, with the box's own machinery filtered out by name | `screensaver`        |
| `~/*`        | the box user's own folders, when there are any                  | `Videos`, `Music`    |
| USB          | every mountable partition of every removable drive              | a stick called FILMS |
| network      | each mounted SMB share (Settings -> Network -> Network shares)  | a NAS called `films` |

There is deliberately no "add a source" screen for a FOLDER and no configured path:
what the box has, it offers. A share mounted some other way (an fstab line at
`~/Videos/nas`, or a home folder that IS the mount) appears through the same rule,
because every check is done on the **real** path.

That same rule is why a **symlink** is not a way in: one that points out of its
root is refused on open and left out of the listing (it would otherwise report the
target's size and mtime, which is an oracle for what exists on the box, from a
stick anyone can prepare on a computer). A link that stays inside its root is
listed and works normally.

## USB sticks

Nothing on this box auto-mounts - there is no desktop and no file manager. A stick
appears in the source list the moment it is plugged in, and **opening it is the
mount**; the same screen ejects it (unmounts, so it is safe to pull out).

The mount goes through **udisks2**, the only way an ordinary user mounts a disk
with no fstab line and no setuid helper. Two things had to be true for that to
work without root:

- `udisks2` has to be installed. It is in the image and in `provision.sh`'s soft
  deps, but **OTA can never add an apt package**, so a box that only ever took
  over-the-air updates does not have it. That box browses its own folders and says
  USB is unavailable rather than showing an empty list.
- The box user needs the polkit grant. The desktop default would cover this -
  udisks allows `filesystem-mount` for an **active local session** - but the shell
  is not one: Electron moves its main process into its own systemd app scope, which
  takes it out of the seat's logind session, and polkit then sees a subject with no
  session at all. Measured on a Pi 5: `pkcheck` answers "authorization requires
  authentication" for the shell's pid and yes for the compositor's, in the same
  session. So `provision.sh` (and the image) install
  `/etc/polkit-1/rules.d/50-tvbox-udisks.rules`, granting the **plugdev** group
  exactly one action.

That one action is `filesystem-mount`, and the three neighbours it would have been
natural to grant with it are all deliberately absent:

- `filesystem-mount-system` - the box's own SD card is a "system internal" device
  to udisks and answers to this one, so nothing here can mount the partitions the
  box runs from. Verified with `pkcheck` against the running shell's pid: mount
  allowed, mount-system denied.
- `power-off-drive` - a Pi can BOOT from a USB SSD, which udisks does not consider
  system-internal. Granting it would let any code running as the box user cut power
  to the running root device.
- `filesystem-unmount-others` - never needed: udisks authorises unmounting a mount
  to the uid that made it, and the shell only unmounts its own. It is also the one
  action an active desktop session does not get without an admin password.

Which devices are offered is decided in `shell/removable.js`, and not by the
hotplug flag: the Pi's own SD card reports `hotplug: true` (measured, util-linux
2.41), so that flag alone would offer the disk the box boots from. A device counts
when the kernel calls it removable or it arrived over USB - and never when the
running system sits on it, which a Pi booting from a USB SSD makes a real case.

## Network shares

**Settings -> Network -> Network shares.** A NAS is the other real place films
live, and it is the same idea as the file server turned around: that hands the
box's folders OUT, this brings someone else's IN.

**SMB, not NFS**, for the same reason as everywhere else here: mounting NFS goes
through the mount syscall and therefore needs root. rclone mounts SMB over FUSE as
the ordinary user, and it is already the box's no-root network tool (the file
server serves WebDAV with it, the RetroArch package mounts its game library with
it). A box without `rclone` offers to fetch it, sha256-pinned into `~/.tvbox/bin`,
the same no-root download every app dep uses.

Each share is mounted at `~/.tvbox/shares/<name>` and appears as a source under
that name. `shares` is machinery to contentdirs.js, so a share is offered once, in
its own right, rather than also turning up as a folder called "shares".

Two things are decided differently from the RetroArch package's share, which mounts
the same way:

- **The cache mode.** rclone's `full` downloads a whole file in the background:
  right for a 700 MB disc image an emulator seeks around in, wrong for a 60 GB film
  someone watches once. This uses `minimal` plus a read-ahead, so reads stay ranged.
- **Read-only.** This is a player; a mistyped delete over SMB is not recoverable.

The form is built around the box doing the finding, because typing a share name and
a folder path on a TV is where a feature like this gets abandoned: **Test** asks the
server what it offers (the shares, then the folders inside one) and every answer is
a row that fills the field it belongs to. The credentials live in `config.json`
(chmod 600) and reach rclone through its environment, never a command line -
anyone on the box can read one of those.

## What the app plays

Video and audio, through the shell's shared `mpv` - the same player Live TV and
Plex use, so a film gets the box's whole output path: the display mode follows the
content, HDR is claimed when the file and the panel agree, and 4K hardware-decoded
video is handed to the compositor untouched.

- **Where you left off** is remembered per file and offered on the next open
  (never for the first minute or the last minute and a half, which are the two
  places a resume point is worse than starting over). It is stored in the app's own
  key/value store, one key for all of them.
- **The next file** in the same folder follows automatically when one runs out,
  in the order the list showed. A stop is not the end of a film, so it does not.
- **Audio track and subtitles** can be switched while watching (Up on the remote).
  mpv picks up a subtitle file sitting next to the video by itself.
- Files it cannot play are **counted, not listed** - a folder of films usually also
  holds subtitles, artwork and an nfo.

## The API behind it

Any app can use it (a local app shares the shell's origin), and it is the
security boundary, so it is worth knowing what it refuses:

| route                              | what                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `GET /tvbox/api/browse/sources`    | the roots above, plus every removable partition and whether it is mounted |
| `GET /tvbox/api/browse/list?path=` | one directory inside one of those roots                                   |
| `POST /tvbox/api/browse/mount`     | `{ device }` - mount a stick that is plugged in                           |
| `POST /tvbox/api/browse/unmount`   | `{ device }` - eject it                                                   |

- A path is resolved with `realpath` and compared against the roots as
  `root + separator`. So `..` cannot climb out, a symlink on the stick cannot lead
  out, and a folder whose name merely starts with a root's name is not inside it.
- A `device` is checked against the partitions actually plugged in before it
  reaches a command line: the candidate list is the gate, not the string's shape.
- "Already mounted" and "not mounted" are successes. The caller asked for a folder
  to open, not for a syscall to be issued.
- The device list is cached for two seconds and dropped by anything that changes it
  (a mount, an unmount). Without it, every folder navigation forks an `lsblk` - and
  so could anything else that can reach the route in a loop.
- All of the filesystem work is async. It runs in the Electron main process, which
  also serves HTTP, drives the compositor socket and carries the remote's keys, and
  the medium is a stick that can be pulled out mid-listing - where a synchronous
  stat sits in uninterruptible I/O until the kernel gives up on the device.

## Code

- `shell/removable.js` + `removable.test.js` - which block devices count, and
  mounting them with no root.
- `shell/browse.js` + `browse.test.js` - the roots and the guarded listing. Most of
  what those tests assert is a refusal.
- `shell/shares.js` + `shares.test.js` - network shares: what a form may store, and
  what gets mounted. UI: `launcher/src/settings/pages/shares.tsx`.
- `shell/contentdirs.js` - which folders hold user content; shared with
  `shell/fileserver.js`.
- `shell/main.js` (the two GETs) and `shell/routes.js` (mount/unmount).
- `shell/preload.js` - `play(url, streams, startPos)`, `pause`, `resume`, `seek`:
  the player surface a recording needs and a live stream never did.
- The app: `apps/files/` + `apps-src/files/` in the
  [registry](https://github.com/Andy1210/tvbox-apps).
