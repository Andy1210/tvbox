# @tvbox/app-sdk

The shared **10-foot UI SDK** for tvbox: the pieces a remote-driven, D-pad
launcher screen needs so neither the launcher nor an app package has to
reimplement them. It bundles:

- **Spatial-nav focus helpers** - `useFocusableItem`, `FocusButton`,
  `initSpatialNavigation` (thin wrappers over
  `@noriginmedia/norigin-spatial-navigation`).
- **On-screen input** - `Osk` (D-pad keyboard), `PinPad` (parental PIN),
  `useBackspace` (remote Back handling).
- **i18n** - `configureI18n` + `useI18n`/`translate`/`localize`, host-injected
  locale dictionaries (no hardcoded languages).
- **Config + capability clients** - `fetchConfig`/`save*` helpers and
  `useConfigStore` for `/tvbox/api/config`; `tvbox()` for the typed shell bridge
  (`player`/`fetch`/`storage`); `postNowPlaying` for MQTT now-playing.

## Consumed as source (the `@sdk` alias)

The SDK ships as **TypeScript source**, not a built package. Both the launcher
and every app package resolve it through a Vite alias plus a matching
`tsconfig` path, pointing at this directory's `src/` in a sibling layout:

```ts
// vite.config.ts
resolve: { alias: { "@sdk": path.resolve(__dirname, "../app-sdk/src") } }
// tsconfig.json
"paths": { "@sdk/*": ["../app-sdk/src/*"] }
```

```ts
import { FocusButton, useI18n, tvbox } from "@sdk";
```

Because the alias resolves straight to `src/`, this package deliberately has
**no `main`/`exports`/`build` step** - adding one would change how `@sdk`
resolves and break the launcher and the app packages. The `peerDependencies`
(React 19, zustand 5, norigin-spatial-navigation 3, qrcode 1) are provided by
the host that consumes the source.

## For app authors

Writing an app package? See
[tvbox-apps/AUTHORING.md](https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md)
for the package layout, manifest reference, and how an app's `web/` UI consumes
this SDK. The capability model behind `tvbox()` (`player`, `fetch`, `storage`)
is documented in [docs/capabilities.md](../docs/capabilities.md).
