# Spotify on tvbox

The box can be a **Spotify Connect speaker**, and optionally a full account
browser (Liked Songs, search, playlists) once you link an account.

## 1. Install it, turn it on

Spotify is an app package, not part of the box: install it from the store (HOME →
"Get more apps"). It brings its own player daemon, `librespot`, as a
sha256-pinned download the box fetches without root, so there is nothing to
apt-install and no SSH.

Then open it and **Turn on Spotify Connect**. Until you do, the daemon does not
run and the box is not discoverable - the switch is what starts it, and it lives
in the app's own settings (the gear on the now-playing screen).

That done, open Spotify on any phone or laptop on the same network, pick the box
from the **Connect** device list, and play. The TV shows a now-playing screen.

- **No account, no API keys, no login.** Anyone on the network can cast.
- Give each box a distinct name under **Spotify → ⚙ → Device name**. That is what
  the Connect list shows. No root, no reboot.

For most people that is the whole story. The rest of this page is optional.

## 2. Optional: link an account

Liked Songs, search and playlist browsing go through Spotify's Web API, which
needs a free **Spotify app** of your own for the API keys. One app covers **all**
your boxes; you do not make one per box.

### a. Create the app (once, on a computer or phone)

1. Open <https://developer.spotify.com/dashboard> and **Create app**.
2. Add this **Redirect URI** exactly. Spotify only allows a loopback `http`
   redirect, so the login has to finish on the box itself:

   ```text
   http://127.0.0.1:8097/tvbox/api/spotify/auth/callback
   ```

3. Save, then copy the **Client ID** and **Client Secret** from the app's
   settings.

### b. Put the keys on the box

**Spotify → ⚙ → Add Spotify API keys.** The TV shows a QR: open it on your phone
and paste both keys there instead of typing them on the TV. The phone form is on
your LAN only and needs the 4-digit code shown on the TV.

### c. Connect the account

Back in the app's settings, **Connect account**. A Spotify login opens on the TV:
scan its QR with the Spotify phone app, or log in. Approve it, and a **Library**
button appears on the now-playing screen.

## Several boxes, several people

- **One app for every box.** Reuse the same Client ID and Secret; each box runs
  _Connect account_ once and gets its own token. Never copy a token between
  boxes: Spotify rotates refresh tokens, and a shared one breaks both.
- **Development mode allows 5 users.** Your own account on three boxes is still
  **one** user, since the limit is per Spotify account. To let other people link
  theirs, add them under the app's **User Management**. Beyond five, apply for
  **Extended Quota Mode**, which also lifts the rate limits.

## What the Web API gives you

| Feature                                 | Status                                               |
| --------------------------------------- | ---------------------------------------------------- |
| Cast, now playing, device rename        | always, no account                                   |
| Liked Songs                             | browse + play                                        |
| Search (tracks and playlists)           | yes                                                  |
| **Your own / collaborative** playlists  | browse tracks + play                                 |
| **Followed** playlists (someone else's) | play the whole list; the track list is not available |

That last limit is Spotify's: `GET /playlists/{id}/items` has been
owner-or-collaborator-only for development-mode apps since the February 2026 API
migration. Extended Quota Mode removes it.

## Where the secrets live

Keys go in `~/.tvbox/config.json` and refresh tokens in
`~/.tvbox/spotify-accounts.json`, both `chmod 600`, one entry per linked account
(a box that predates multiple accounts has its old single `~/.tvbox/spotify-token`
migrated in). Neither is ever committed, and a backup carries both.

Casting needs neither, and needs no root: with no keys and no token the box is
simply a Connect speaker.
