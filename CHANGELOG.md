# Changelog

Release notes shown on the TV before an update installs (Settings → System &
updates). `scripts/make-release.sh` lifts the current version's `hu`/`en`
blocks into the OTA feed's `notes` - keep both languages, keep it short, and
write for the person on the couch (what changes for THEM), not for developers.

## 1.17.2

### hu

- Biztonsági javítás. Azok az alkalmazások, amelyek egy internetes oldalt nyitnak meg a boxon - a YouTube, a felhős játékok -, mostantól a rendszer többi részétől elzárva futnak. A box eddig is nekik szánta ezt a védelmet, csak egy indítási beállítás csendben kikapcsolta. A használatukban nem változik semmi; a védelem a box következő elindulásakor lép életbe.

### en

- A security fix. The apps that open a website on the box - YouTube, the cloud games - now run walled off from the rest of the system. The box always meant that protection for them; a startup setting had been quietly switching it off. Nothing changes in how you use them, and the protection takes effect the next time the box starts.

## 1.17.1

### hu

- Biztonsági frissítés. A box böngészőmotorja - ez rajzolja a felületet, és ez futtatja a benne megnyíló oldalakat, például a felhős játékokat és a streaming alkalmazásokat - megkapta a Chromium két legutóbbi hibajavítás-csomagját. Nincs új funkció, a kezelésben nem változik semmi.
- Ez a frissítés a szokásosnál hosszabb ideig települ, néhány percig, mert a böngészőmotort teljes egészében újra le kell töltenie. A TV addig azt írja, hogy telepít - hagyd befejezni.

### en

- A security update. The box's browser engine - the part that draws the interface and runs the pages that open inside it, like the cloud games and the streaming apps - picked up Chromium's two most recent rounds of fixes. Nothing new to use, and nothing changes in how the box works.
- This update takes longer to install than usual, a few minutes, because the browser engine has to be downloaded again in full. The TV will say it is installing until then - let it finish.

## 1.17.0

### hu

- Az alkalmazások mostantól meg tudják kérdezni, szabad-e a box, így a nagyobb háttérmunkájuk megvárja a nyugodt pillanatot - a RetroArch borítóletöltése például akkor indul, amikor nem nézel és nem hallgatsz semmit. A box maga is jobban ügyel erre: éjszaka nem indítja újra magát egy frissítés kedvéért, amíg épp egy alkalmazást tölt le.
- Javítva: a fájlkiszolgálónál a mappák listája már azt a nevet mutatja, amit a számítógépen is látni fogsz (`games`, `screensaver`), nem lefordított címkét - eddig „Játékok" állt a TV-n, a hálózaton meg `games` néven jelent meg, és nem lehetett megtalálni. Ha két mappát ugyanúgy hívnak, a második neve (`Videos-2`) is állandó marad: nem változik meg attól, hogy egy másik mappa megosztását ki- vagy bekapcsolod.

### en

- Apps can now ask whether the box is free, so their heavier background work waits for a quiet moment - RetroArch's cover download, for instance, starts when you are not watching or listening to anything. The box holds itself to the same rule: at night it no longer restarts for an update while it is downloading an app.
- Fixed: the file server's folder list now shows the name you will see on the computer (`games`, `screensaver`) instead of a translated label - the TV used to say "Games" for a folder that appears as `games` on the network, which is not something you can find. When two folders share a name, the second one's name (`Videos-2`) also stays put: it no longer changes because you shared or unshared a different folder.

## 1.16.0

### hu

- Új: fájlkiszolgáló. A box mappái elérhetők a hálózaton, így számítógépről tudsz rá másolni és róla törölni - képernyővédő képeket, játékokat egyszerre sokat, vagy egy konzol BIOS-át pontosan oda, ahol az emulátor keresi. Beállítások → Hálózat → Fájlkiszolgáló: jelszó (kötelező), és te választod ki, mely mappák legyenek megoszthatók. A box magától megkeresi, mit lehet megosztani, tehát egy új alkalmazás mappája is megjelenik a listában. A saját beállítási mappája is megosztható, de figyelmeztetéssel: abban a box beállításai és az alkalmazások bejelentkezései is benne vannak.

### en

- New: a file server. The box's folders are reachable over the network, so you can copy to it and delete from it with a computer - screensaver images, many games at once, or a console BIOS exactly where the emulator looks for it. Settings → Network → File server: a password (required), and you choose which folders may be shared. The box finds what can be shared itself, so a new app's folder shows up in the list on its own. Its own settings folder can be shared too, with a warning: that one holds the box's settings and the apps' logins.

## 1.15.1

### hu

- Javítva: a box bizonyos esetekben minden indulásnál újra végigkérdezte a kezdeti beállítást, pedig már régen be volt állítva - és a válasz sem maradt meg. Ha két rövid ideig egyszerre futott a felület (például mert a munkamenet váratlanul újraindult), a második nem tudta olvasni és írni a saját tárolóját, így úgy látta, mintha vadonatúj box lenne. Mostantól egyszerre csak egy felület indul el, és azt is a box maga jegyzi meg, hogy a beállítás megvolt.

### en

- Fixed: in some cases the box asked for the initial setup again at every start, on a box that had been set up long ago - and did not keep the answer either. When two copies of the interface briefly ran at once (for instance because the session restarted unexpectedly), the second could not read or write its own storage, so it looked like a brand-new box. Only one interface starts now, and the box itself remembers that setup is done.

## 1.15.0

### hu

- Az OpenGL-es játékok végre a videokártyán futnak. A Pi két külön eszközzel dolgozik: a kép a vc4-en megy ki, a rajzolás a v3d-n történik - és eddig a rendszer a kijelző-eszközt hirdette meg az alkalmazásoknak, amelyek így nem találták meg a videokártyát, és a processzoron rendereltek. Ez érintett minden flatpakos alkalmazást: a RetroArch OpenGL-t igénylő emulátorai (OpenLara, Craft és a legtöbb másik) használhatatlanul lassúak voltak, miközben a Vulkan-os úton minden rendben ment. Mostantól a rajzoló eszközt hirdetjük meg, és az OpenGL is a videokártyát kapja. A kép továbbra is a vc4-en megy ki, ahogy eddig is.

### en

- OpenGL games finally run on the GPU. The Pi uses two separate devices - vc4 puts the picture out, v3d does the drawing - and until now the box advertised the display device to applications, which then could not find the GPU and rendered on the processor instead. This affected every flatpak app: RetroArch's emulators that need OpenGL (OpenLara, Craft and most others) were unplayably slow, while its Vulkan path was fine. The box now advertises the drawing device, so OpenGL gets the GPU too. The picture still goes out over vc4, exactly as before.

## 1.14.0

### hu

- Beállítások, Alkalmazások: minden alkalmazásnak saját képernyője lett. A listában a neve, a sorrendje és egy Kezelés gomb van, mögötte pedig az, amit az adott alkalmazás kínál: telefonos műveletek (játékok feltöltése, hálózati megosztás, konzolok), elrejtés, eltávolítás. Eddig ezek mind a listasorba voltak zsúfolva, és a hosszabb nevek ki sem látszottak.
- Az App Store-ban látszik annak a programnak a verziója is, amit egy alkalmazás valójában futtat (RetroArch), vagy amiből készült (Plex). Ez külön frissítési csatorna, amiről a regiszter nem tud, tehát eddig a store egy olyan verziót mutatott, ami nem arról a programról szólt, amit a néző használ. Mellé egy gomb, amivel most azonnal frissíthető, nem kell megvárni az éjszakai automatikus frissítést.
- Javítva: a Plex webes felülete a boxon egy MÁSOLAT a flatpakból, ezért amikor az éjszakai frissítés új Plexet töltött le, a másolat csendben a régin maradt - a felület elavult, miközben a szerver már továbblépett. A box most észreveszi, ha a flatpak elmozdult, és újramásolja a felületet: magától, amikor éppen nem használod, vagy azonnal, ha kézzel frissítesz.

### en

- Settings, Apps: every app has its own screen now. The list keeps the name, the ordering and a Manage button, and behind it sits whatever that app offers: phone actions (upload games, network share, consoles), hiding it, removing it. Until now all of that was crammed into the list row, and longer names were pushed out of view.
- The App Store now shows the version of the program an app actually runs (RetroArch) or was built from (Plex). That is a separate update channel the registry knows nothing about, so until now the store displayed a version that said nothing about the program the viewer uses. Next to it, a button that updates it right away instead of waiting for the nightly update.
- Fixed: Plex's web interface on the box is a COPY of the one inside its flatpak, so when the nightly update pulled a newer Plex the copy silently stayed behind - a stale interface talking to a server that had moved on. The box now notices when the flatpak has moved and re-copies the interface: on its own while you are not using the box, or immediately when you update by hand.

## 1.12.1

### hu

- A RetroArch mostantól valóban feltelepíthető a box saját alkalmazás-listájából. Eddig a lista visszautasította, mert nem webes alkalmazás, így csak kézzel lehetett felmásolni.

### en

- RetroArch can now actually be installed from the box's own app list. Until now the list refused it for not being a web app, so it could only be copied over by hand.

## 1.12.0

### hu

- Retro játékok: a RetroArch mostantól felvehető alkalmazásként, és a saját felületét a távirányítóval vagy kontrollerrel lehet kezelni. A Home gomb mindig visszahoz a boxra, akármit is csinálsz benne. A konzolokat (NES, SNES, Game Boy, Mega Drive, PlayStation és társai) a RetroArch saját letöltőjéből lehet hozzáadni.
- Játékok a telefonodról: Beállítások → Alkalmazások → RetroArch → "Játékok feltöltése", QR-kód, és a telefonon kiválasztod a fájlokat. A konzolt a fájl kiterjesztéséből felismeri. Ugyanitt látod, mi van a boxon, és egy konzol teljes tartalmát egy gombbal törölheted.
- Játékok a hálózatról: ha a játékok egy NAS-on vagy gépen vannak, a box közvetlenül onnan olvassa őket, és több box is ugyanazt a könyvtárat használhatja. A megosztás nevét és a mappát nem kell fejből tudni: a telefonos űrlapon a szerver felkínálja őket, és koppintással lehet lelépni a jó mappáig.

### en

- Retro games: RetroArch can now be added as an app, and its own interface works with the remote or a controller. The Home button always brings you back to the box, whatever you are doing in it. Consoles (NES, SNES, Game Boy, Mega Drive, PlayStation and the rest) are added from RetroArch's own downloader.
- Games from your phone: Settings, Apps, RetroArch, "Upload games", scan the QR code and pick the files on your phone. The console is recognised from the file extension. The same page shows what is on the box, and one button clears a whole console.
- Games from your network: if the games live on a NAS or a computer, the box reads them straight from there, and several boxes can share one library. You do not need to know the share or folder name by heart: the phone form asks the server and you tap your way down to the right folder.

## 1.11.0

### hu

- Játékkontroller: mostantól a felületet is vezérli (D-pad vagy bal kar, A = OK, B = Vissza), és a felhő-gamingben azok a kontrollerek is működnek, amiket a böngésző nem ismer fel - a box Xbox-kontrollerként adja tovább őket. Az Xbox, PlayStation, Nintendo, Steam, Logitech és 8BitDo padokhoz nem nyúl, azok eddig is mentek.
- Beírás a TV-n: ha egy alkalmazásban szövegmezőre lépsz, feljön a képernyő-billentyűzet - jelszóhoz pedig telefonon is beírhatod: a Telefon gombra QR-kód jelenik meg, beolvasod, és a telefonon írod be (a jelszókezelőd is működik). A szöveg a helyi hálózaton, titkosítás nélkül megy a TV-hez, ezt a jelszó mezőknél a box ki is írja.
- Bejelentkezés: az olyan alkalmazások, amelyek külön ablakban kérik a belépést (Microsoft-fiók), most végig tudják vinni. Ha egy oldal ujjlenyomatot vagy PIN-t (passkey) kérne, a box már nem ajánlja fel - azt itt semmilyen ablak nem tudná megjeleníteni -, hanem a jelszós utat kínálja.
- Az alkalmazások a box nyelvén jönnek fel, nem azon, amit az internetszolgáltató helye szerint kitalálnak.

### en

- Game controllers now drive the interface too (D-pad or left stick, A = OK, B = Back), and cloud gaming accepts controllers the browser doesn't recognise - the box re-publishes them as an Xbox pad. Xbox, PlayStation, Nintendo, Steam, Logitech and 8BitDo pads are left alone; they already worked.
- Typing on the TV: focusing a text field in an app brings up the on-screen keyboard - and for a password you can type on your phone instead: press Phone for a QR code, scan it, and type there (your password manager works too). The text travels to the TV over your local network unencrypted, which the box says out loud on password fields.
- Signing in: apps that ask for your account in a separate window (a Microsoft account) can now complete it. If a page would ask for a fingerprint or PIN (a passkey), the box no longer offers that - no window here could ever show it - and steers you to the password instead.
- Apps come up in the box's language rather than the one guessed from your internet provider's location.

## 1.10.1

### hu

- A Plex kilépés-kérdésére ("bezárom?") most tényleg bezárul az alkalmazás. Eddig csak a kezdőképernyőre vitt, a Plex viszont futva maradt, és ha visszaléptél bele, megint a kilépés-kérdésnél találtad magad. (A Kezdőlap gomb változatlanul csak háttérbe teszi az alkalmazást, hogy azonnal ott folytathasd, ahol abbahagytad.)

### en

- Plex's "Exit?" prompt now really closes the app. Until now it only took you to the home screen while Plex kept running, so going back into it landed you on that same prompt again. (The Home button still just puts an app in the background, so you can pick up exactly where you left off.)

## 1.10.0

### hu

- A felbontás mostantól automatikus, és megszűnt a kézi beállítás. A felület legfeljebb 1080p-ben rajzol (4K TV-n is), a film viszont a saját felbontásán és képfrissítésén megy - így a 4K tartalom újra 4K, a mozis 24 képkockás filmek pedig nem rángatnak többé. Indításkor a kép egy-két másodpercre elsötétül, amíg a TV átvált; ez normális.
- Ha a box olyankor kapcsolódott be, amikor a TV ki volt kapcsolva, feleslegesen pörgött magában: melegedett és fogyasztott, a felület pedig utána is lassabb maradt. Ez megszűnt.

### en

- Resolution is automatic now, and the manual setting is gone. The interface draws at up to 1080p (even on a 4K TV) while a film plays at its own resolution and frame rate - so 4K content is 4K again, and 24-frame cinema films no longer stutter. The picture goes dark for a second or two as the TV switches; that is normal.
- If the box started while the TV was off, it kept spinning for nothing: it ran hot, drew power, and the interface stayed slower afterwards. Fixed.

## 1.9.0

### hu

- A box többé nem veszi vissza magának a TV bemenetét. Eddig, ha átkapcsoltál egy másik bemenetre, negyed percen belül visszarántotta magára - most ott maradsz, ahova kapcsoltál. (Induláskor egyszer még magához veszi a képet, mint eddig.)
- A Fire TV távirányító infra-tanításánál gombonként külön márka is választható: mehet például a soundbar a hangerő gombokra, miközben a többi gomb a TV-t vezérli. Egy gombra akár két készülék kódja is rátehető, így egy nyomás mindkettőnek szól. A Teszt gomb pontosan azt küldi ki, ami mentéskor a távirányítóra kerülne.

### en

- The box no longer takes the TV's input back. Until now, switching to another input lasted at most a quarter of a minute before the box grabbed it again - now it stays where you put it. (It still claims the picture once when it starts, as before.)
- When teaching a Fire TV remote's infrared buttons you can pick a different brand per button: put a soundbar on the volume keys while the rest still drive the TV. A button can even carry two devices, so one press reaches both. Test sends exactly what saving would put on the remote.

## 1.8.0

### hu

- Sokkal gördülékenyebb a felület, főleg 4K TV-n: a főképernyő mostantól akadásmentesen mozog, és tétlenül a box jóval kevesebbet fogyaszt és hidegebb marad.
- A beállított felbontás megmarad azután is, hogy kikapcsolod és visszakapcsolod a TV-t - eddig ilyenkor visszaugrott a TV alapértelmezettjére.
- A kijelölt csempén újra látszik a fehér keret, így egyértelmű, hol jársz. A háttér letisztultabb lett: nem úszkál és nem színeződik át a kiválasztott alkalmazás szerint.

### en

- The interface is much smoother, especially on a 4K TV: the home screen now moves without stutter, and when idle the box draws noticeably less power and runs cooler.
- Your chosen resolution now survives switching the TV off and on again - until now it jumped back to the TV's default.
- The selected tile has its white outline back, so it is always clear where you are. The background is calmer: it no longer drifts or tints itself to the selected app.

## 1.7.2

### hu

- Háttérben futó biztonsági és megbízhatósági javítások (frissítés-letöltés, alkalmazástelepítés, Bluetooth-párosítás).
- Felületi finomítások: a fókusz-kijelölés a Beállításokban (nyelv és hang) újra jól látszik, az időjárás eltűnik a város törlésekor, az elalvás-időzítő visszaszámlálása helyesen frissül és lejár, és néhány felirat mostantól magyarul jelenik meg.

### en

- Behind-the-scenes security and reliability fixes (update downloads, app install, Bluetooth pairing).
- UI polish: the focus highlight in Settings (language and audio) shows correctly again, the weather clears when you remove the city, the sleep-timer countdown updates and expires properly, and a few labels are now translated.

## 1.7.1

### hu

- A Névjegy külön menüpont lett a Beállításokban, és az oldal végre végiggörgethető a nyilakkal (rendszerinformációk és nyílt forráskódú kreditek).
- A vészhelyzeti gomb-visszaállítás (ugyanaz az átkötött gomb 8-szor gyorsan) mostantól le van írva a képernyőn, a távirányító visszaállítás gombja alatt.

### en

- About is now its own item in Settings, and the page finally scrolls with the arrows (system information and open-source credits).
- The emergency button reset (same remapped button 8 times fast) is now explained on screen, under the remote's reset button.

## 1.7.0

### hu

- A Fire TV távirányító minden gombja betanítható, az app-gombok (Netflix, Prime), a hamburger és az appváltó gomb is: tehetsz rájuk app-indítást, Beállításokat, TV ki/be kapcsolást vagy appváltást.
- A gombtanítás rendbe jött: teljes képernyős ablakban zajlik, a gombok elsőre rögzülnek, a felület nem ugrál össze közben, és a betanított gomb azonnal meg is jelenik a listában.
- A vészhelyzeti visszaállítás (ugyanaz a gomb 8-szor gyorsan) csak átkötött gombra érvényes, így pl. hangerő-nyomkodás közben nem törlődhet véletlenül a kiosztás.

### en

- Every button on a Fire TV remote can now be taught, including the app buttons (Netflix, Prime), the hamburger and the app-switcher button: put an app launch, Settings, TV power or app switching on any of them.
- Button learning got solid: it runs in a full-screen dialog, presses register on the first try, the screen no longer jumps around while teaching, and a taught button shows up in the list immediately.
- The emergency reset (same button 8 times fast) now only counts remapped buttons, so mashing volume can never wipe your setup by accident.

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
