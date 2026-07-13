# Background apps

Leaving an app used to exit it (local apps page-swapped the shell's main
window, remote apps' windows were destroyed), so every return meant a full
reload. Now **every app runs in its own window and leaving it just hides it**:
Home shows up instantly, and reopening the app resumes its live page - browse
position, scroll state, logged-in session, everything - in well under a second.

What the user sees:

- **HOME → "Running" row**: every backgrounded app as a chip - OK resumes it,
  the ✕ next to it really quits it (drops the window; next launch is fresh).
- **`appswitcher` remap action** (Settings → Peripherals): bind any remote
  button to cycle through the running apps, FireTV-style.
- Tiles behave as before; launching a running app's tile resumes it.

## Rules and limits

- **Media goes quiet in the background.** On hide the renderer is muted and any
  in-page `<video>/<audio>` is pause()d best-effort (YouTube/Plex web players).
  The shared **mpv player always stops** on leave, exactly as before - it's a
  single global process, not per-app; what survives is the app's _UI state_,
  so pressing play again is two clicks, not a full app boot.
- **Limits scale with the box's RAM** (Pi 5 ships as 2/4/8/16GB; logged at boot
  as `[apps] background limits`): the hidden-window count cap is 1 (<3.5GB) /
  3 (<7GB) / 6 (more), LRU-evicted beyond that; and a once-a-minute RAM guard
  drops the least-recently-used hidden app while `MemAvailable` is under the
  floor (12% of RAM, clamped to 384MB..1GB). A hidden Chromium window costs
  roughly 200-500MB.
- **Idle/OTA:** hidden apps do NOT block the nightly auto-update idle gate
  (they're muted and stateless-recoverable); a shell restart drops them.
- **Uninstalling/removing an app destroys its background window** too.

## Turning it off

`config.apps.background: false` in `~/.tvbox/config.json` (or POST
`/tvbox/api/config {"apps":{"background":false}}`) restores the old
destroy-on-leave behavior - the rollback lever if a box misbehaves.

## Plumbing (for debugging)

- Registry + hidden-set policy: [shell/appwindows.js](../shell/appwindows.js).
  Foreground orchestration (focus, stacking, mpv, video-mode): `shell/main.js`
  (`foregroundApp`/`showLauncher`/`navTo`/`switchApp`).
- Only ONE window is ever visible (hidden windows are unmapped in Wayland), so
  CEC key routing and always-on-top stacking behave as in the single-window
  days. The launcher window stays loaded permanently; HOME refetches
  `/tvbox/api/apps` on visibilitychange to keep the running row honest.
- App identity is **per-window** (`windowAppId` in main.js): the preload's
  `tvbox:app` answer and every capability broker key off the _sender window_,
  so a hidden app keeps its own caps/origins/storage - there is no window
  reuse and no confused-deputy path.
- API: `GET /tvbox/api/apps` tiles carry `running` + `foreground`;
  `POST /tvbox/api/apps/quit {id}`; `POST /tvbox/api/nav {"dest":"switch"}`
  cycles running apps (what the `appswitcher` remap action calls).
- mpv's first-frame reveal targets the window whose app called `player.play`
  (`mpvOwnerId`), because the video overlay class lives in the app's own
  window now.
