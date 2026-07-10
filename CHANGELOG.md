# Changelog

Release notes shown on the TV before an update installs (Settings → System &
updates). `scripts/make-release.sh` lifts the current version's `hu`/`en`
blocks into the OTA feed's `notes` - keep both languages, keep it short, and
write for the person on the couch (what changes for THEM), not for developers.

## 1.3.0

### hu

- Időjárás a főképernyőn (a képernyővédőnél megadott város alapján).
- Automatikus TV-kikapcsolás: a képernyővédő után beállítható idővel a TV magától kikapcsol (HDMI-CEC) — zene lejátszása közben soha.
- Szülői felügyelet a Beállításokban: PIN beállítása, módosítása, törlése — ugyanazt a PIN-t használja minden alkalmazás (pl. az Élő TV zárolt kategóriái).
- A felbontásválasztó jelöli a TV alapértelmezett módját, így könnyű visszaállni rá.
- Választható óraformátum (automatikus / 12 / 24 órás).
- A Bluetooth-eszközöknél látszik a távirányító töltöttsége.
- A Névjegy mutatja a szabad tárhelyet.
- Sok apró szépítés: olvashatóbb feliratok a csempéken, finomabb animációk, egységes színek, helyes magyar dátumírás.

### en

- Weather on the home screen (based on the city set for the screensaver).
- Auto power-off: after a configurable time on the screensaver the TV turns itself off (HDMI-CEC) — never while music is playing.
- Parental controls in Settings: set, change or remove the PIN — the same PIN is used by every app (e.g. Live TV's locked categories).
- The resolution picker marks the TV's default mode, so it's easy to switch back.
- Selectable time format (automatic / 12-hour / 24-hour).
- Bluetooth devices show the remote's battery level.
- About shows free storage.
- Lots of small polish: more readable tile labels, smoother animations, consistent colors, correct Hungarian date formatting.

## 1.2.2

### hu

- A Bluetooth-távirányítók (pl. Fire TV) Vissza gombja mostantól az alkalmazásokon belül (Plex, YouTube) is működik, nem csak a menükben.

### en

- Bluetooth remotes' (e.g. Fire TV) Back button now also works inside apps (Plex, YouTube), not just in the menus.

## 1.2.1

### hu

- A rendszerfrissítés megbízhatóbb: ha a letöltés közben hiba történik (például megtelik a tárhely), a box hibát jelez és később újrapróbálja, a képernyő nem áll le.
- A Bluetooth-távirányítók támogatása mostantól azokon a boxokon is magától elindul a következő bekapcsoláskor, amelyek csak rendszerfrissítésből kapták meg.

### en

- System updates are more robust: if the download fails midway (e.g. the storage fills up), the box reports an error and retries later instead of the screen going down.
- Bluetooth remote support now also starts by itself on the next power-on for boxes that received it via a system update only.

## 1.2.0

### hu

- A Kép és hang beállításoknál a felbontásválasztó most már felsorolja és váltani is tudja a felbontásokat (korábban üres maradt).
- A Bluetooth távirányítók (pl. Fire TV) Vissza gombja már alapból működik, betanítás nélkül.
- A Plexből a főképernyőn a Vissza gombbal most tényleg vissza lehet lépni a box főképernyőjére.
- Motorháztető alatt: frissített, biztonságosabb alkalmazásmotor és sok apró javítás.

### en

- The resolution picker (Settings → Picture & sound) now lists and switches resolutions (it was empty before).
- Bluetooth remotes' (e.g. Fire TV) Back button now works out of the box, without remapping.
- Backing out of Plex from its home screen with Back now returns you to the box's home screen.
- Under the hood: an updated, more secure app engine and lots of small fixes.

## 1.1.1

### hu

- Javítottunk egy ikont, ami a képernyővédő beállításnál és a főképernyő fogaskerék gombján négyzetként jelent meg.

### en

- Fixed an icon that showed as a square in the screensaver settings and on the home settings button.

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
