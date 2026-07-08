# tvbox - HOME launcher

The 10-foot HOME screen for the TV box. **React + TypeScript + Vite + Tailwind**,
driven entirely by the D-pad remote via spatial navigation
([`@noriginmedia/norigin-spatial-navigation`](https://github.com/NoriginMedia/Norigin-Spatial-Navigation)).

Hosted by the Electron shell under `/tvbox/`. It fetches the installed apps from
`GET /tvbox/api/apps` and renders a tile per app; selecting one calls
`window.tvbox.launch(id)` (the shell bridge). The remote **Home** button (handled
in the shell) returns here from any app.

## i18n

No hardcoded UI strings - everything resolves through `src/lib/i18n.tsx` against
JSON locale files in `src/locales/`. First launch shows the setup wizard
(`SetupWizard`: language -> WiFi -> timezone -> keyboard -> done); the language
choice persists in `localStorage` and a `tvbox.setup.done` flag gates the wizard
so it only runs on a fresh box. Dates/times use `Intl`
with the locale tag, so a new language needs **only a `src/locales/<id>.json`**
(register it in `i18n.tsx`). Manifest `name`/`tagline` may be a string or a
`{ "hu": …, "en": … }` map.

## Dev

```sh
npm install
npm run demo        # DEV WITHOUT A BOX: dev server + HMR against the fully mocked shell
npm run dev         # dev server against a real shell (see the proxy below); bare = retry screen
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # -> ../shell/launcher-dist (served by the shell)
npm run build:demo  # -> dist-demo (the browser demo published to GitHub Pages)
```

`npm run demo` is the everyday TV-less workflow - every screen works, backed by
the demo fixtures. To develop against a **real box's live data** instead, proxy
the shell API through an SSH tunnel (it binds to the box's loopback only):

```sh
ssh -N -L 8097:127.0.0.1:8097 <pi-ssh-host> &
TVBOX_HOST=127.0.0.1:8097 npm run dev
```

Playback and `window.tvbox` bridge calls still need the box (mpv and the window
live there), but every API-driven screen - Live TV lists/EPG, settings panels,
Spotify state - runs on live data with HMR.

The production build outputs into the shell so the shell is self-contained to
deploy; `../deploy/deploy.sh` runs the build before syncing.

## Demo mode

`--mode demo` bundles `src/demo/`, which patches `fetch` and installs a fake
`window.tvbox` bridge before React mounts - the shell endpoints are answered from
mocks (config, apps, the App Store, Settings). It's **shell-only**: apps run as
packages the real shell opens in its own window, so the demo has no in-app Live
TV / Spotify views - its tiles show a "runs on a real box" notice. Launcher code
has no demo awareness, and production builds dead-code-eliminate the whole
directory. The `demo` GitHub Actions workflow publishes it to Pages:
<https://andy1210.github.io/tvbox/>. Handy while developing: `?lang=en|hu`
presets the locale.

The demo's pairing QR codes point at `demo-public/pair/` - a static, offline
replica of the shell's phone pages (`shell/pairing/pages/`), hosted on the
same Pages site. Scanning one opens the real-looking form on the phone;
submitting only simulates success there (the demo has no server, so the
TV side is dismissed with Back).
