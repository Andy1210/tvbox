# Spotify on tvbox

tvbox is a **Spotify Connect speaker** out of the box, and _optionally_ a full
account browser (Liked Songs, search, playlists) if you connect an account.

## 1. Cast-only - zero setup

The box runs `librespot` and advertises itself on your network. Open Spotify on
any phone/laptop on the same Wi-Fi, pick the box from the **Connect** device list
(the **devices** icon), and play. The TV shows a now-playing screen.

- **No account, no API keys, no login.** Anyone on the network can cast.
- Rename the box (so each one is distinct) under **Spotify → ⚙ → Device name**.
  This is what shows in the Connect list. No root, no reboot.

That's the whole story for most people. The rest is optional.

## 2. Optional: connect an account (Liked Songs, search, playlist browsing)

This needs a free **Spotify app** (for API access). One app covers **all** your
boxes - you do **not** make a separate app per box.

### a. Create the app (once, on a computer/phone)

1. Go to <https://developer.spotify.com/dashboard> and **Create app**.
2. Add this **Redirect URI** exactly (Spotify only allows a loopback `http`
   redirect, so the login has to finish on the box itself):

   ```text
   http://127.0.0.1:8097/tvbox/api/spotify/auth/callback
   ```

3. Save, then open **Settings** and copy the **Client ID** and **Client Secret**.

### b. Enter the keys on the box

**Spotify → ⚙ (gear) → Add API keys.** The TV shows a QR - open it on your phone
and paste the Client ID and Secret (far easier than typing on the TV). The phone
form is on your LAN only and needs the 4-digit code shown on the TV.

### c. Connect the account

Back in settings tap **Connect account**. A Spotify login window opens **on the
TV** - either scan its QR code with the Spotify phone app (no typing) or log in.
Approve, and the box stores a token. Done - a **Library** button appears on the
now-playing screen.

## Multiple boxes / users

- **One app for every box.** Reuse the same Client ID/Secret on each box; each box
  runs _Connect account_ once and gets its **own** token. Don't copy one token
  between boxes - Spotify rotates refresh tokens and a shared one would break.
- **Dev-mode allows 5 users.** Your own account on 3 boxes still counts as **one**
  user (it's per Spotify account, not per device). To let other people connect
  their accounts, add them under the app's **User Management** (up to 5). Need
  more? Apply for **Extended Quota Mode** (also lifts rate limits).

## What works (Spotify Web API, 2026)

| Feature                                 | Status                                          |
| --------------------------------------- | ----------------------------------------------- |
| Cast / now-playing / device rename      | always, no account                              |
| Liked Songs                             | ✅ browse + play                                |
| Search (tracks & playlists)             | ✅                                              |
| **Your own / collaborative** playlists  | ✅ browse tracks + play                         |
| **Followed** playlists (someone else's) | ▶ play the whole list; track list not available |

The per-track listing of _followed_ playlists is blocked for development-mode apps
(`GET /playlists/{id}/items` is owner/collaborator-only since the Feb-2026 API
migration). Extended Quota Mode removes that limit.

## Security / privacy

- Keys live in `~/.tvbox/config.json` (chmod 600); refresh tokens in
  `~/.tvbox/spotify-accounts.json` (chmod 600, one entry per linked account - the
  older single-token `~/.tvbox/spotify-token` is auto-migrated). Neither is ever committed.
- No credentials and **no root** are needed for the cast-only mode. The Web API is
  entirely opt-in: with no keys/token the box just runs as a Connect speaker.
