# File server (WebDAV)

The box's folders, reachable from a computer on the same network. It exists for the
things a TV cannot do and that should not need ssh: dropping screensaver images in,
copying games across, deleting a few hundred of them, or putting a console BIOS into
the folder an emulator actually reads.

Settings → Network → **File server**. Nothing is shared until you pick folders and set
a password.

## What it is

`rclone serve webdav`, supervised by the shell like any other long-lived helper.
rclone is already the box's no-root network tool (the RetroArch package mounts SMB
with it), so on most boxes the binary is there; if not, the settings screen offers to
fetch it - the same sha256-pinned, no-root download every app dep uses.

What it serves is a directory of **symlinks** in `~/.cache/tvbox/fileserver-root`, one per
folder you picked, rebuilt from scratch on every change. rclone follows them
(`--copy-links`), writes included. Nothing runs as root; nothing is mounted.

## Which folders it offers

Discovered, not listed - a folder a future app introduces shows up on its own:

| where             | what                                                            | example                                                                                |
| ----------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `~/.tvbox/*`      | user content, with the box's own machinery filtered out by name | `screensaver`, `games`                                                                 |
| `~/*`             | the box user's own folders, when there are any                  | `Videos`                                                                               |
| `~/.var/app/*`    | each installed flatpak app's data dir                           | `RetroArch` - and inside it `config/retroarch/system`, where a core looks for its BIOS |
| `~/.tvbox` itself | offered, and flagged in the UI                                  | it holds `config.json` and the apps' logins                                            |

The machinery filter (`MACHINERY` in `shell/fileserver.js`) is the inverse of a list
of shareable folders: `shell`, `shell-userdata`, `versions`, `update`, `bin`,
`apps`, `apps-data`, `cache` and friends stay out, everything else is offered.

Two folders can share a name (`~/Videos` and `~/.tvbox/Videos`); the second one gets a
`-2` suffix rather than replacing the first.

The settings screen lists each folder under the exact name it gets over the network -
`games`, not a translated "Játékok" - because that name is what to look for in the
computer's file manager.

## Credentials

- A password is **mandatory** (8 characters minimum). Without one the server does not
  start - this binds to the LAN on purpose and there is no "just for a minute"
  version of exposing someone's home directory.
- The username defaults to `tvbox`.
- Both live in `~/.tvbox/config.json` (chmod 600) like every other secret. The
  launcher is only ever told whether a password is **set**, never what it is, and the
  credentials reach rclone through its environment - never argv, which anyone on the
  box can read.
- Clearing the password stops the server.

## Connecting

The settings screen shows the address, e.g. `http://192.168.1.24:8098/`.

| client                          | how                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux (Files/Nautilus, Dolphin) | `dav://192.168.1.24:8098/`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| macOS Finder                    | Go → Connect to Server → `http://192.168.1.24:8098/`                                                                                                                                                                                                                                                                                                                                                                                           |
| Windows Explorer                | Map network drive → the same URL. Windows **refuses Basic auth over plain HTTP by default**, and it is right to: raising `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters\BasicAuthLevel` to 2 makes Windows send the password **in the clear** to any HTTP WebDAV server, not just this one - a trusted-LAN-only change, worth putting back to 1 afterwards. Prefer a client that does not need it: WinSCP, Cyberduck, or rclone. |
| any OS                          | `rclone` as the client too: `rclone --webdav-url http://box:8098/ --webdav-user tvbox --webdav-pass "$(rclone obscure PASSWORD)" --webdav-vendor other ls :webdav:`                                                                                                                                                                                                                                                                            |

There is no TLS. This is a password-protected LAN service, and a self-signed
certificate would only add a warning to click through in every client - but it does
mean the password crosses the network in the clear (Basic auth), so treat it as
trusted-LAN-only and do not reuse a password that matters elsewhere. Over anything
less trusted, tunnel it (ssh, WireGuard) rather than exposing the port.

## Notes

- The share root is removed when the server stops, so a stopped box leaves no
  symlinked view of its folders behind.
- Sharing `games` also exposes a mounted network share underneath it
  (`roms/network`, if the RetroArch package mounts one) - reading it goes over the
  network twice, which is slow but works.
- Directory listings are cached for 10s (`--dir-cache-time`), because the box writes
  into these folders too and a stale listing is confusing.
- The port is 8098 (8097 is the shell's own HTTP, 8099 the pairing server). A value
  outside 1024-65535 falls back to the default rather than being handed to rclone:
  an unbindable port turns into a respawn loop, which from the TV just looks like the
  feature not working.
- The share root deliberately lives **outside** `~/.tvbox`. It used to be inside, and
  sharing the box's own folder then put the root inside the share - with a link back
  to `~/.tvbox` in it, so a client walking the tree recursed as deep as it had
  patience for.
- Clearing the password (its own row in the form, shown once one is stored) stops the
  server. An empty entry in the password row means "keep the stored one", like every
  other credential form here.

## Code

- `shell/fileserver.js` - what is offered, what gets served, refusing to serve
  without a password. `shell/fileserver.test.js` covers those decisions.
- `shell/config.js` - the `fileserver` section (`setFileserver` / `rawFileserver`).
- `shell/main.js` - `applyFileserver()` on boot and on every save,
  `GET`/`POST /tvbox/api/fileserver`, `POST /tvbox/api/fileserver/install-rclone`.
- `launcher/src/components/FileServerSettings.tsx` - the screen; it renders whatever
  the box reports and knows nothing about specific folders.
- `tvbox fileserver-deps` - fetch rclone from a shell (what the UI button runs).
