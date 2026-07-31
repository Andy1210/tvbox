# Diagnostics and safe mode

A tvbox is well instrumented while it works. Settings → About reports version, IP,
Wi-Fi, temperature, memory and storage; `journalctl` has the detail; the shell keeps
its own log. All of it needs a booting box with a working session and a network.

The failure worth designing for is the one where none of that is true. A root
filesystem that fills up and goes read-only takes the screen, the network and sshd
down together, and every route in is gone at once. That is what this pair is for:

- **`tvbox-diag`** writes a plain-text report onto the **FAT boot partition**, the
  one medium the firmware, the box and any laptop running any OS can all read. It
  needs no network, no session and no writable root.
- **`tvbox-safemode`** brings the box up with networking and SSH but **no TV
  session**, and puts the report on the TV. Either on request, or on its own after
  three starts that never reach the launcher.

Neither needs the box to be working, and neither needs a keyboard.

## Reading the report

Pull the card, or SSH in, and open `tvbox-diag.txt` on the boot partition:

```sh
sudo cat /boot/firmware/tvbox-diag.txt      # on the box
cat /run/media/you/bootfs/tvbox-diag.txt    # card in a laptop, path varies
```

It is rewritten at every boot and every 30 minutes, so a box that failed three
hours into a session is described from then, not from boot. The top of the file is
the answer:

```text
tvbox diagnostics
Written by tvbox-diag at every boot and every 30 minutes. Overwritten each time.
verdict:      2 problem(s) found, see the WARNING lines
WARNING: only 174 MB free on / - the box cannot write logs, host keys or app data...
WARNING: no SSH host keys - sshd will accept connections and drop them with no banner...

== box ==
...
```

Then sections for the box, the boot attempt counter, the session, storage, network,
SSH, the boot configuration and any failed units. The things it looks for are the
ones that have actually taken a box down:

| Reported                                                            | Why it is in there                                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| free space on `/`, and `ro` in the mount options                    | A full rootfs makes ext4 abort the filesystem and remount read-only. It does not look like a full disk: sshd answers and closes with no banner, the shell crash-loops behind a black screen.                    |
| SSH host keys present                                               | An image ships without them on purpose. If the first boot cannot write them, that is the no-banner symptom above.                                                                                               |
| `cmdline.txt` size, `root=`, `vc4.force_hotplug=1`, any `FSCK*.REC` | An interrupted write to the FAT partition leaves the file at zero bytes with its text orphaned into a `.REC`, and the box then boots on the firmware's fallback command line. Nothing on a running box notices. |
| boot attempt counter, previous boot healthy                         | The safe-mode state machine below, so its decisions are inspectable.                                                                                                                                            |
| the shell listening on 127.0.0.1:8097                               | Read out of `/proc/net/tcp`, so it answers even when the network stack is broken.                                                                                                                               |
| failed system **and user** units                                    | The input bridges are user units and invisible to a plain root `systemctl`.                                                                                                                                     |
| firmware throttling                                                 | Undervoltage is a power-supply fault that reads like a hundred software ones.                                                                                                                                   |

`tvbox-diag.txt` **never contains a secret.** The boot partition is FAT, so it has
no ownership: every app on the box and anyone holding the card can read it.
`tvbox.conf` keys are reported by name only (`WIFI_PASSWORD=set`), and
`authorized_keys` as a count.

On demand, over SSH:

```sh
sudo tvbox-diag --stdout      # print it, write nothing
sudo tvbox-diag --logs        # also write tvbox-diag-logs.txt (journal + shell.log tails)
```

`tvbox-diag-logs.txt` is a separate, bounded file so it can never push the report
itself off a full partition. Safe mode writes it automatically.

## Safe mode

Safe mode stops one thing: **greetd**, which is what autologins into the session and
therefore into the shell. Networking, sshd, the diagnostics units and everything
else come up normally. The TV shows the report instead of the launcher.

### Asking for it

Either, on the boot partition:

- create an empty file named **`tvbox-safe-mode`** (the one thing every OS's file
  manager can do to a FAT card), or
- write **`SAFE_MODE=true`** into `tvbox.conf`.

Both are sticky: every boot goes into safe mode until you remove the file or set
`SAFE_MODE=false`. They are also the only way in that works when the root
filesystem is read-only, because neither needs anything writable.

### When it engages on its own

The shell writes `~/.tvbox/healthy` once the launcher has loaded, which is the first
moment the session, the compositor, the HTTP server and the renderer are all proven
to work at once. `tvbox-safemode` deletes that marker at every boot, so finding it
means the boot that just ended got that far.

Three starts in a row without that marker mean safe mode:

| boot | marker found | counter | result                         |
| ---- | ------------ | ------- | ------------------------------ |
| 1    | no           | 1       | normal start                   |
| 2    | no           | 2       | normal start                   |
| 3    | no           | 3       | **safe mode**, counter cleared |
| 4    | -            | 1       | normal start again             |

Engaging safe mode clears the counter, so it lasts **one boot**. A box can never be
locked out of its own session by this, and it does not restart itself either, so the
recovery window stays open for as long as the box is left on. A single healthy boot
resets the counter at any point.

### Getting in

Safe mode starts sshd, but SSH still needs a way to authenticate, and the account is
password-locked on a flashed box. Both are set from the boot partition's
`tvbox.conf` and apply at the next boot:

```ini
SSH_AUTHORIZED_KEY=ssh-ed25519 AAAA... you@laptop
SUDO=true
```

### Leaving

Reboot. `/run` is a tmpfs, so an automatic safe mode is already gone; a requested
one needs the file or the config key removed first.

## How it is put together

| Piece                      | Where                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| report writer              | [deploy/tvbox-diag.sh](../deploy/tvbox-diag.sh) → `/usr/local/sbin/tvbox-diag`               |
| decision + recovery screen | [deploy/tvbox-safemode.sh](../deploy/tvbox-safemode.sh) → `/usr/local/sbin/tvbox-safemode`   |
| units                      | `tvbox-diag.service` + `.timer`, `tvbox-safemode.service`, `tvbox-safemode-screen.service`   |
| greetd condition           | `greetd-tvbox-safemode.conf` → `/etc/systemd/system/greetd.service.d/10-tvbox-safemode.conf` |
| healthy-boot marker        | [shell/boothealth.js](../shell/boothealth.js) → `~/.tvbox/healthy`                           |
| boot counter               | `/var/lib/tvbox/boot-state`                                                                  |
| tests                      | `deploy/tvbox-diag.test.js`, `deploy/tvbox-safemode.test.js`, `shell/boothealth.test.js`     |

Both scripts run as **root**, because the boot partition mounts `fmask=0022` and
greetd is a system unit. The shell stays rootless (hard rule #1 in
[CLAUDE.md](../CLAUDE.md)): its only part in this is the marker file in its own home.
Making the boot partition writable by the box user was the alternative and is not an
option, since anything that can write `cmdline.txt` can add kernel parameters.

They are shipped as real files through [deploy/infra.list](../deploy/infra.list) and
installed under `/usr/local/sbin` and `/etc` by `deploy/provision.sh` (dev deploys)
and `image/stage-tvbox` (flashed images) - one copy of the logic for both channels,
and unit-testable, which a generated heredoc is not.

**An OTA release cannot install them.** Root paths are out of reach for OTA by
design, so a release refreshes the copies in `~/.tvbox/` and the active ones change
at the next `provision.sh` run. Same constraint as apt packages (see the OTA note in
[CLAUDE.md](../CLAUDE.md)).

Two boxes are out of scope for the greetd condition: one whose session comes up
through a different display manager. `deploy/run-shell.sh` refuses to start the shell
while the flag is present, which covers it.

## What it will not tell you

- **Nothing is written on shutdown.** The report describes the box as of the last
  boot or the last half-hour tick.
- **The journal may be volatile.** `journalctl` keeps history only where
  `/var/log/journal` exists; on a box where it does not, `tvbox-diag-logs.txt` has no
  previous boot to show.
- **The automatic trigger needs a writable root.** The counter lives on `/`, so a
  read-only root loses it. That is why the boot-partition marker exists.
- **The boot-time report is written before the box has settled.** It is ordered
  against the boot partition and the safe-mode decision, and nothing else: not
  `network-online.target`, and not even `network.target`, because a
  NetworkManager that hangs on start holds that target for its whole timeout and the
  report would arrive ninety seconds into the boot someone is about to power-cycle. A
  broken network stack is something this report describes, not something it waits
  for. So at boot there may be no route and no shell yet; both read "still starting"
  rather than as faults, and the timer rewrites the file two minutes in with the
  settled picture. The recovery screen is the one part that does wait for
  `network.target`, since an address on the TV is most of what makes it useful.
