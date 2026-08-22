# tvbox docs

The [README](../README.md) is the tour. These are the pages it points at, each
one about a single thing the box does and why it does it that way.

They are also published as a site, at
<https://andy1210.github.io/tvbox/docs/>, for reading somewhere that is not a git
checkout. Same files, built by [scripts/docs-site](../scripts/docs-site/build.js).

## Setting a box up

| Page                                           | What it covers                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [sd-image.md](sd-image.md)                     | Building and flashing the SD image, and every key the boot-partition `tvbox.conf` accepts. |
| [updates-and-backup.md](updates-and-backup.md) | OTA releases, rollback, OS updates, and the encrypted backup your phone downloads.         |
| [diagnostics.md](diagnostics.md)               | The report on the boot partition and safe mode: what a box says when it will not start.    |
| [fleet-view.md](fleet-view.md)                 | What each box publishes about itself, so several stay watchable from one place.            |

## Living with it

| Page                                                         | What it covers                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| [local-media.md](local-media.md)                             | Your own folders, USB sticks and a NAS share, and how playback remembers them.    |
| [file-server.md](file-server.md)                             | WebDAV: copying films, games and photos onto the box from a computer.             |
| [app-sharing.md](app-sharing.md)                             | An app's folders pulled from the other box in the house.                          |
| [spotify-setup.md](spotify-setup.md)                         | Casting to the box, and the optional account features.                            |
| [ir-blaster.md](ir-blaster.md)                               | TV volume through a network IR blaster, for a TV that ignores CEC volume.         |
| [firetv-remote-ir.md](firetv-remote-ir.md)                   | Programming a Fire TV remote's own blaster, and its buttons that are not keys.    |
| [gamepad.md](gamepad.md)                                     | Controllers on the UI, and the shim that makes an unrecognised pad usable.        |
| [voice-satellite.md](voice-satellite.md)                     | The remote's microphone as a Home Assistant voice satellite.                      |
| [screen-mirroring.md](screen-mirroring.md)                   | A phone's screen on the TV, and what it costs the box's wifi.                     |
| [mqtt-integration.md](mqtt-integration.md)                   | Every topic the box publishes and listens on.                                     |
| [homeassistant-integration.md](homeassistant-integration.md) | The integration that makes the box a real `media_player` entity.                  |
| [app-store-sources.md](app-store-sources.md)                 | Adding your own registry next to the official one, and what that means for trust. |

## Writing an app

| Page                                     | What it covers                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [app-api.md](app-api.md)                 | **The API reference**: every `window.tvbox` call, the SDK, the HTTP routes, the host plugin API. |
| [app-manifest.md](app-manifest.md)       | The manifest field reference. Schema: [app-manifest.schema.json](app-manifest.schema.json).      |
| [capabilities.md](capabilities.md)       | The security boundary: what each capability exposes and how it is brokered.                      |
| [native-apps.md](native-apps.md)         | Programs that draw their own fullscreen window, like RetroArch.                                  |
| [background-apps.md](background-apps.md) | What leaving an app does to it - the lifecycle an app has to survive.                            |

The full authoring guide lives with the apps themselves, in the registry:
[AUTHORING.md](https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md).

## History

[upstream-wlroots.md](upstream-wlroots.md) and
[upstream/patches/](upstream/patches/) are the eleven labwc and wlroots patches
the box used to need to get a film onto a display plane. It runs its own
compositor now and applies none of them, but three are plain wlroots bugs that
are still upstream's, so they are kept where someone can find them.
