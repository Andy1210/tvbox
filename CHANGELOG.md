# Changelog

Release notes shown on the TV before an update installs (Settings → System &
updates). `scripts/make-release.sh` lifts the current version's `hu`/`en`
blocks into the OTA feed's `notes` - keep both languages, keep it short, and
write for the person on the couch (what changes for THEM), not for developers.

## 1.1.0

### hu

- Bluetooth távirányítók (pl. Fire TV) párosítása a Beállításokból - és mostantól a Vissza gombjuk is működik.
- A távirányító gombjai átállíthatók, eszközönként (Beállítások → Perifériák): válaszd ki a távirányítót, és tanítsd be a saját gombjait - a home és a media gombok is.
- A távirányító Power gombja alapból csak a TV-t kapcsolja le (a box bekapcsolva marad); a Beállításokban átállítható.

### en

- Pair Bluetooth remotes (e.g. Fire TV) from Settings - and their Back button now works too.
- Remap remote buttons per device (Settings → Peripherals): pick a remote and teach it your own buttons - home and media too.
- The remote's Power button turns off just the TV by default (the box stays on); configurable in Settings.

## 1.0.1

### hu

- Első indításkor beállítás varázsló: nyelv, WiFi, időzóna és billentyűzet, lépésről lépésre.
- Az időzóna és a billentyűzetkiosztás mostantól a Beállításokban is módosítható.
- Elnevezheted a boxot (Beállítások → Általános), így több box közül könnyen megkülönbözteted.
- Gyorsabb, azonnali reagálás a távirányító gombjaira.

### en

- First-boot setup wizard: language, WiFi, time zone and keyboard, step by step.
- Change the time zone and keyboard layout from Settings, too.
- Name your box (Settings → General) so several boxes are easy to tell apart.
- Faster, more immediate response to the remote's buttons.

## 1.0.0

### hu

- Megérkezett a saját alkalmazásbolt: a főképernyő „Továbbiak beszerzése" csempéjéről telepíthetsz appokat (Élő TV, Spotify, Plex, Jellyfin).
- Az appok a boxtól függetlenül frissülnek - ha van új verzió, a boltban látod, a részleteknél pedig az újdonságokat is.

### en

- The built-in app store is here: install apps (Live TV, Spotify, Plex, Jellyfin) from the home screen's "Get more apps" tile.
- Apps update independently of the box - when there's a new version you'll see it in the store, with the what's-new notes on the app's detail page.
