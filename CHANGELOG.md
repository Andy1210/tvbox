# Changelog

Release notes shown on the TV before an update installs (Settings → System &
updates). `scripts/make-release.sh` lifts the current version's `hu`/`en`
blocks into the OTA feed's `notes` - keep both languages, keep it short, and
write for the person on the couch (what changes for THEM), not for developers.

## 1.6.0

### hu

- Az appok a háttérben maradnak. Ha visszamész a főképernyőre, az app tovább fut, és egy pillanat alatt visszaléphetsz oda, ahol abbahagytad. A főképernyő megmutatja a futó appokat, és be is zárhatod őket.
- A távirányító hangerő, némítás és TV ki/be gombja mostantól a TV-t vezérli, hálózati IR jeladón vagy a Fire TV távirányító saját infráján keresztül.
- Bármelyik távirányítógombra tehetsz műveletet: TV ki/be, Beállítások megnyitása, egy app indítása vagy váltás a futó appok között. Egy új gombteszt megmutatja, melyik gomb mit küld.

### en

- Apps now keep running in the background. Go Home and the app stays open, so you can jump straight back to where you left off. The home screen shows what is running and lets you close it.
- Your remote's volume, mute and TV power buttons can now control the TV, through a network IR blaster or a Fire TV remote's own infrared.
- You can put an action on any remote button: TV power, open Settings, launch an app, or switch between running apps. A new button test shows what each button sends.

## 1.5.1

### hu

- Az áruházban a telepítve/eltávolítva üzenet többé nem jelenik meg egy másik alkalmazás adatlapján.

### en

- In the store, the installed/removed message no longer shows up on a different app's detail page.

## 1.5.0

### hu

- Home Assistant / MQTT beállítás a Beállításokban: a box bármilyen brokerhez beköthető (most-játszott szenzor, távoli parancsok, képernyő-értesítések).
- Zene castolásakor a főképernyőn kártya mutatja, mi szól (a Spotify apppal), és app-váltáskor a régi lejátszás leáll.
- Hangsáv és felirat váltása lejátszás közben (Élő TV: OK gomb a sávon, majd még egyszer).
- Elalvásidőzítő a főképernyő energia menüjében (30/60/90 perc).
- Wi-Fi országbeállítás (a rádiós szabályozáshoz, pl. Németországban DE).
- A képernyővédő a Bing napi képeit is tudja forgatni (bekapcsolható).
- Figyelmeztetés, ha merül a Bluetooth-távirányító eleme.
- Finom megjelenési animációk a képernyők és menük váltásánál.

### en

- Home Assistant / MQTT setup in Settings: connect the box to any broker (now-playing sensor, remote commands, on-screen notifications).
- When music is cast, a card on the home screen shows what's playing (with the Spotify app), and switching apps stops the previous playback.
- Switch audio track and subtitles during playback (Live TV: OK on the banner, then OK again).
- Sleep timer in the home screen's power menu (30/60/90 minutes).
- Wi-Fi country setting (for radio regulations, e.g. DE in Germany).
- The screensaver can rotate Bing's daily pictures too (opt-in).
- A warning when the Bluetooth remote's battery runs low.
- Subtle entry animations when switching screens and menus.

## 1.4.0

### hu

- Az alkalmazások mostantól maguktól frissülnek éjszaka (kikapcsolható a Rendszer beállításoknál), csak amikor a box tétlen.
- Wi-Fi: mentett hálózat elfelejtése és csatlakozás rejtett hálózathoz.
- Navigációs hangok a távirányítóhoz (kikapcsolható a Kép és hang alatt).
- Választható hangsáv- és feliratnyelv a lejátszáshoz (Kép és hang).
- A szülői zár mostantól a kényes műveletekre is rátehető: alkalmazás telepítése és törlése PIN-t kérhet.
- A képernyővédő fotói finom áttűnéssel váltakoznak.
- A billentyűzet és a PIN-párna gombjai új, minden tévén helyesen megjelenő ikonokat kaptak.
- A tévé magától bekapcsol, ha videó indul (pl. hangvezérléssel), kivéve közvetlenül azután, hogy kikapcsoltad.

### en

- Apps now update themselves overnight (can be turned off under System settings), only while the box is idle.
- Wi-Fi: forget a saved network and join hidden networks.
- Navigation sounds for the remote (can be turned off under Picture & sound).
- Selectable audio and subtitle language for playback (Picture & sound).
- Parental controls can now cover sensitive actions: installing and uninstalling apps can require the PIN.
- Screensaver photos change with a smooth crossfade.
- The keyboard and PIN pad got new icons that render correctly on every TV.
- The TV turns itself on when video starts (e.g. via voice control), except right after you turned it off.

## 1.3.0

### hu

- Időjárás a főképernyőn (a képernyővédőnél megadott város alapján).
- Automatikus TV-kikapcsolás: a képernyővédő után beállítható idővel a TV magától kikapcsol (HDMI-CEC), zene lejátszása közben soha.
- Szülői felügyelet a Beállításokban: PIN beállítása, módosítása, törlése, ugyanazt a PIN-t használja minden alkalmazás (pl. az Élő TV zárolt kategóriái).
- A felbontásválasztó jelöli a TV alapértelmezett módját, így könnyű visszaállni rá.
- Választható óraformátum (automatikus / 12 / 24 órás).
- A Bluetooth-eszközöknél látszik a távirányító töltöttsége.
- A Névjegy mutatja a szabad tárhelyet.
- Sok apró szépítés: olvashatóbb feliratok a csempéken, finomabb animációk, egységes színek, helyes magyar dátumírás.

### en

- Weather on the home screen (based on the city set for the screensaver).
- Auto power-off: after a configurable time on the screensaver the TV turns itself off (HDMI-CEC), never while music is playing.
- Parental controls in Settings: set, change or remove the PIN, the same PIN is used by every app (e.g. Live TV's locked categories).
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
