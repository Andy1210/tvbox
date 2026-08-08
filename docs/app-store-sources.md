# App store sources

The store is built from one or more **registries**. The box ships with the
official `tvbox-apps` index and the owner can add their own: a homebrew
registry, or the local one you serve while writing an app.

Settings -> Apps -> Store sources.

## What a source is

A registry is a single `index.json` reachable over HTTP, plus the package files
it names, served **relative to the index**:

```
https://example.test/store/index.json      { registryVersion: 1, apps: [...], packages: {...} }
https://example.test/store/apps/<id>/…     the files each package app is made of
```

That is all. Any static host will do, which is what makes a laptop on the LAN a
valid registry while you work on an app.

- `https` from anywhere, or plain `http` **only to a LAN address**. A public
  http registry would be an unauthenticated channel for host-side app code, so
  the box refuses one, the same rule the OTA feed follows.
- **10 added sources**, plus the primary. Every source is a fetch on every store
  open, and a panel that waits on a dozen of them reads as broken rather than slow.

## Trust

**An added registry is as powerful as the official one.** An app can carry a
host-side `plugin.js`, install its own no-root binaries, launch a flatpak, and
put renderer code in the shell's window. That is the model the store was built
on: the review in the official repo is the trust boundary, the way Kodi's
official repository works.

There is deliberately **no weaker trust level for added sources**. A "sandboxed"
tier would have to refuse plugins and native apps while still handing the app an
origin on the box and the `fetch` broker, so it would promise a safety it cannot
deliver, and it would split every future feature in two. Instead the decision is
made once, by the owner, when the source is added, and the screen says plainly
what it means.

What the box does owe that owner is bookkeeping, and that is the rest of this
document.

## Which source an app comes from

Two registries can offer the same app id. The catalogue resolves it in a fixed
order:

1. **The source the app was installed from**, while it is still configured. The
   box records it in `~/.tvbox/apps-data/.registry/<id>.json` on every install.
2. Otherwise the **configured order**, primary first.

The pin is what keeps an id from changing hands. Without it a second registry
could publish a higher version under an installed app's id, and the nightly
auto-update would install it, unattended, through the same code path as the
store's Update button. With it, an app updates from where it came from, and the
store's detail view names any other registry that carries the same id.

Removing an app removes its pin. Re-installing it from a different source moves
the pin there, because that is what "install from here" means.

## Unattended updates, per source

The nightly run (03:00-06:00, idle box) is the one moment a registry acts on the
box with nobody present. That is a per-source setting:

| Source               | Default |
| -------------------- | ------- |
| the primary registry | on      |
| an added registry    | **off** |

An app from a source with unattended updates off still shows an Update button in
the store, it just waits for the press. The box's overall apps auto-update
switch (Settings -> Apps) is above both: with it off, nothing updates by itself.

## Config

Everything lives in `~/.tvbox/config.json` and can be edited by hand:

```json
{
  "store": {
    "registry": "https://example.test/store/index.json",
    "autoUpdate": true,
    "sources": [
      { "url": "http://192.168.1.5:8790/index.json", "name": "Dev", "autoUpdate": true },
      { "url": "https://homebrew.example/index.json", "name": "Homebrew" }
    ]
  }
}
```

- `registry` replaces the OFFICIAL index, for a self-hoster pointing the box at
  their own. Leave it out to keep the shipped one.
- `autoUpdate` is the primary registry's unattended-update flag (default true).
- `sources` are merged in after the primary, in this order. `name` is a label for
  the screen, and each entry carries its own `autoUpdate` (default false).

A source the box refuses (wrong scheme, duplicate, over the cap) is dropped on
save rather than stored and ignored, so what the file holds is what the box uses.

## A registry on your own machine

This is the development loop for anything that changes what a box installs: run
the registry locally, point one box at it, and publish nothing until it works.

In a [tvbox-apps](https://github.com/Andy1210/tvbox-apps) checkout:

```sh
npm run store:serve            # builds the index, stages the site, serves it on :8790
```

It prints the URL to type into Settings -> Apps -> Store sources -> Add a source
(the box needs the LAN address of your machine, not `localhost`). Add it next to
the official registry rather than replacing it, so the box keeps both catalogues,
and turn its unattended updates on if you want the box to pick up rebuilds by
itself overnight.

Two things follow from the pin above:

- An app you install from the local registry stays with it, even when the
  official one later publishes the same id. That is what makes it safe to test a
  breaking change against a real box while the published app keeps working
  everywhere else.
- When you are done, remove the source and re-install the app to move it back to
  the official registry. Removing the source alone does not move an installed
  app: the box keeps what is on disk.

## What this does not do

- **No per-app trust.** Trust is per source, decided when it is added.
- **No signature check.** A registry is trusted through its URL and the
  transport, exactly like the OTA feed. Package FILES are sha256-verified
  against the index that named them, which protects the download, not the
  publisher.
- **No phone form yet.** The address is typed on the on-screen keyboard; the
  pairing-page pattern used for network shares would fit here later.
