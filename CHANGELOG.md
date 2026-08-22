# Changelog

Release notes shown on the TV before an update installs (Settings → System &
updates). `scripts/make-release.sh` lifts the current version's `hu`/`en`
blocks into the OTA feed's `notes` - keep both languages, keep it short, and
write for the person on the couch (what changes for THEM), not for developers.

## 3.8.1

### hu

- **Egy alkalmazás bezárása elhallgattatja azt is, amit nem a box játszik.** A
  Futó appok sorában a Spotifyt bezárva eddig ment tovább a zene, mert azt a saját
  háttérszolgálata szólaltatja meg, nem a box lejátszója. Most megáll. A box közben
  a Spotify Connect listáján marad, tehát a telefonról továbbra is ideküldhetsz
  zenét zárt alkalmazás mellett is.

### en

- **Closing an app now silences sound the box itself is not playing.** Closing
  Spotify from the Running apps row used to leave the music going, because its own
  background service is what makes the sound, not the box's player. It stops now.
  The box stays on the Spotify Connect list either way, so you can still send music
  here from a phone with the app closed.

## 3.8.0

### hu

- **Hangosan kért zene a szoba tévéjén szól.** Ha megkéred Lucy-t, hogy tegyen fel
  egy számot, egy albumot vagy egy előadót, az abban a szobában szólal meg, ahol
  mondtad. Először a ház saját zenetárában keres, és ha ott nincs meg, a Spotifyt
  kéri meg; a YouTube-ot pedig akkor, ha kimondod. Eddig ehhez a boxnak nem volt
  mit csinálnia, és a kérés a Discordra ment.
- **Az alkalmazás akkor is elindul, ha épp nincs nyitva.** A box megnyitja, amelyik
  a kért zenét le tudja játszani, és utána indítja el a számot.

### en

- **Music you ask for out loud plays on the TV in that room.** Ask Lucy for a song,
  an album or an artist and it starts in the room you said it in. It looks in the
  house's own library first, asks Spotify when the song is not there, and uses
  YouTube when you say so. Until now the box had nothing to do with this and the
  request went to Discord instead.
- **The app opens itself if it is not already up.** The box brings forward whichever
  app can play what was asked for, then starts it.

## 3.7.1

### hu

- **Egy alkalmazás hangja nem tud többé „elveszni".** Ha valaki a telefonjáról
  lehalkította azt, amit épp átküldött, a box eddig megjegyezte ezt a halkítást annak
  az alkalmazásnak, és az utána néma maradt — miközben a Beállításokban a hangerő
  végig 100%-ot mutatott, mert az a TV felé menő hangerő, nem az alkalmazásé. Mostantól
  minden alkalmazás a saját teljes hangerején indul, a box hangerejét pedig ott állítod,
  ahol eddig is.

### en

- **An app's sound can no longer go missing.** If someone turned down what they were
  casting from their phone, the box used to remember that for the app, and it stayed
  silent afterwards - while Settings kept showing 100%, because that is the volume going
  to the TV, not the app's. Every app now starts at its own full volume, and you set the
  box's volume where you always did.

## 3.7.0

### hu

- **A zene nem áll le, ha kilépsz az appból.** Nyomhatsz Home-ot vagy nyithatsz másik
  alkalmazást, a szám tovább szól, és a kezdőképernyőn megjelenik egy kártya azzal, ami
  éppen megy — arra lépve visszajutsz hozzá. Akkor áll le, ha bezárod az alkalmazást a
  „Futó appok" sorban, ha valami más kezd szólni, vagy ha a Beállítások → Kikapcsolás →
  Alvás gombot használod. Filmre ez nem vonatkozik: az továbbra is véget ér, amikor
  kilépsz belőle.
- **Egy alkalmazás már azelőtt is dolgozhat, hogy megnyitnád.** Ezt maga az alkalmazás
  kéri a boxtól; a médiaalkalmazás az első, amelyik él vele, hogy a telefonod akkor is
  ide tudjon küldeni zenét, ha a TV-n épp a kezdőképernyő van.

### en

- **Music does not stop when you leave the app.** Press Home or open something else and
  the track keeps playing, with a card on the home screen showing what it is - press it
  to get back. It stops when you close the app from the "Running" row, when something
  else starts playing, or when you use Settings → Power → Sleep. Films are unchanged:
  leaving one still ends it.
- **An app can be working before you open it.** The app asks the box for this; the media
  app is the first to use it, so your phone can send music here while the TV is sitting
  on the home screen.

## 3.6.0

### hu

- **Átküldés telefonról.** A telefonod YouTube-alkalmazásából elindíthatsz egy videót
  ezen a TV-n: a box megjelenik a telefon listájában a saját nevén, és a videó akkor is
  itt indul el, ha a YouTube épp nincs nyitva. Ha a box maga kapcsolta le a TV-t, a
  küldés fel is ébreszti.
- **Előbb be kell kapcsolni** — és a YouTube alkalmazásnak is meg kell kapnia a saját
  frissítését: Beállítások → Alkalmazások → Alkalmazások extra beállításai → „Átküldés
  telefonról". Azért marad addig kikapcsolva, mert amíg be van kapcsolva, **bárki
  ugyanezen a wifin** átküldhet erre a TV-re, és az félbeszakítja, amit épp néztek.
- **Új hely a Beállításokban: „Alkalmazások extra beállításai".** Ide kerülnek azok a
  kapcsolók, amiket egy alkalmazás a boxtól kér, mert a saját felületén nincs hova
  tennie őket — az átküldés az első ilyen.

### en

- **Cast from your phone.** Start a video on this TV from the YouTube app on your phone:
  the box appears in the phone's list under its own name, and the video starts here even
  when YouTube is not open. If the box turned the TV off itself, a cast wakes it.
- **You have to turn it on first** — and the YouTube app needs its own update too:
  Settings → Apps → Extra app settings → "Cast from phone". It stays off until then
  because while it is on, **anyone on the same wifi** can send to this TV, interrupting
  whatever is playing.
- **A new place in Settings: "Extra app settings".** It holds the switches an app asks
  the box for when its own screen has nowhere to put them - casting is the first one.

## 3.5.0

### hu

- **Előkészítés a szünetmentes zenéhez.** A box mostantól egyetlen lejátszóval,
  egyben végig tudja játszani az egymás után következő számokat, ahelyett hogy
  mindegyikhez újraindítaná — az az újraindítás volt eddig a csend a számok
  között. Zene szólásakor a képernyőhöz sem nyúl hozzá: nem vált képmódot és nem
  villan feketére, mert nincs mit megjelenítenie.
- Magától egyelőre semmi nem változik ettől: a Média alkalmazás a következő
  frissítésétől kezdi használni.

### en

- **Groundwork for gapless music.** The box can now play one track after another
  in a single player instead of restarting it for each one — that restart is
  where the silence between songs came from. Playing sound no longer touches the
  screen either: no display-mode switch and no blank, because there is nothing to
  show.
- Nothing changes on its own from this: the Media app starts using it from its
  next update.

## 3.4.0

### hu

- **Az az alkalmazás is eltávolítható, amit már egyik bolt sem kínál.** Eddig az
  Eltávolítás gomb csak a bolti listában létezett, így egy visszavont app ott
  maradt a boxon örökre: futott, de nem lehetett leszedni. Most a bolt alján
  külön csoportban megjelenik, és megmondja, miért van ott — már senki nem
  kínálja, vagy a box nem tudja értelmezni, amit a bolt küld, vagy nem fogadja
  el. Ha a bolt, ahonnan telepítetted, már nincs beállítva, azt is kiírja, hogy
  vissza tudd venni.
- **Az üres bolt is kezelhető a távirányítóval**, és eltávolítás után a kurzor a
  szomszéd sorra áll, nem ugrik a lista tetejére.
- Egy bolt, ami épp nem válaszol, **nem** teszi visszavontnak az onnan telepített
  appokat, és egy nyomva tartott OK gomb nem töröl le több appot egymás után.

### en

- **An app no store offers any more can be removed.** Remove used to live only
  in the store list, so an app retired from a registry stayed on the box for
  good: it ran, but there was no way to take it off. It now appears in a group
  at the end of the store and says why it is there — nobody offers it, or the
  box cannot read what the store sent, or it does not accept it. If the store
  you installed it from is no longer set up, it tells you that too.
- **An empty store can be used with the remote**, and after a removal the cursor
  moves to the neighbouring row instead of jumping to the top of the list.
- A store that is not answering does **not** make its apps look retired, and a
  held OK button no longer removes one app after another.

## 3.3.0

### hu

- **Egy app áthozható egy másik boltból, egy gombnyomással.** Ha ugyanaz az app
  több boltban is fent van — mert épp dolgozol rajta, és közben a hivatalosban
  is benne van —, az app oldalán megjelenik egy gomb boltonként, és azzal
  átveheted onnan. Ugyanazzal a verziószámmal is: egy fejlesztői változat
  általában a publikált helyére áll be, ugyanazon a számon. Vissza is ugyanígy
  megy.
- **Az app oldala megmondja, melyik boltból való**, és ha máshonnan jött, mint
  ahonnan most kínálják, azt is, hogy a frissítés áthozná. Egy bolt, ami épp nem
  válaszol, kint marad a listán — az a visszaút —, de látszik rajta, hogy nem
  felel.

### en

- **An app can be taken from another store with one press.** When the same app
  is in more than one store - because you are working on it while it is also
  published - its page shows a button per store, and that button takes it from
  there. The same version number included: a development build usually stands in
  for the published one under its own number. Going back is the same press.
- **An app's page says which store it came from**, and when that is not the one
  offering it now, that updating would move it. A store that is not answering
  stays on the list - it is the way back - and says so.

## 3.2.0

### hu

- **Más emberek nevei rendesen látszanak a képernyőn.** Egy Spotify-lista, aminek
  napocska van a nevében, eddig üres téglalapot mutatott: a doboz betűkészlete
  nem ismert egyetlen emojit sem. Mostantól igen. Amit mi írunk a képernyőre,
  abban nincs emoji — ezek mások szolgáltatásaiból jönnek, és az ő szavaik.
- **Ez a frissítés a szokásosnál hosszabb**, mert a betűkészletet a dobozra
  telepíti, nem csak a programot cseréli. Egyszeri; a következő frissítések újra
  a megszokott tempóban mennek.

### en

- **Other people's names render properly on screen.** A Spotify playlist with a
  sun in its name showed an empty box, because the box's font knew no emoji at
  all. Now it does. Nothing we write uses emoji - these names come from other
  people's services and are theirs to write.
- **This update takes longer than usual**, because it installs the font on the
  box rather than only replacing the program. One time only; the next updates
  are back to their normal pace.

## 3.1.0

### hu

- **A képernyőkímélő feljöhet olyan app fölé is, aminek épp nincs mit mutatnia.**
  A Spotify „Nincs lejátszás" képernyője eddig egész éjjel kint maradt, mert app
  közben a kímélő nem indulhatott el. Mostantól maga az app szólhat, hogy nála
  jöhet — ugyanannyi tétlenség után, amennyit a launcherhez beállítottál —, és
  bármelyik gomb visszavisz oda, ahol voltál. Amíg zene szól, film megy vagy a
  telefonod képét tükrözöd, marad minden a régiben.
- **A kímélőt lezáró gomb nem indít el semmit mögötte.** Eddig az OK
  megnyomása egyben elindította azt a csempét, amin a fókusz állt — nálunk az
  Élő TV-t. Most csak eltűnik a kímélő. A Home gomb is működik rá, eddig nem
  tüntette el.
- **A menühangok minden appban szólnak, nem csak a főképernyőn.** Ugyanazok a
  hangok, ugyanaz a kapcsoló a Beállításokban.
- **A képernyő-billentyűzet azt mutatja, amit begépeltél.** A szóköz azonnal
  látszik, és a beviteli mező nem ugrik meg az első karakternél. A PIN-kód
  ellenőrzése közben pedig látszik, hogy dolgozik — eddig a négy pötty némán
  kiürült, és a közben beütött kód elveszett.

### en

- **The screensaver can come up over an app that has nothing to show.** Spotify's
  "nothing is playing" screen used to stay on the TV all night, because the
  screensaver could not arm behind an app. Now the app itself can say it is fine
  — after the same wait you set for the launcher — and any button takes you back
  where you were. While music, a film or a phone's mirrored screen is on, nothing
  changes.
- **The button that dismisses the screensaver no longer presses what is behind
  it.** Pressing OK used to open whatever tile had focus on Home; now it just
  clears the screen. Home works on it too, which it did not before.
- **Navigation sounds play inside apps, not only on the home screen.** Same
  sounds, same switch in Settings.
- **The on-screen keyboard shows what you typed.** A space appears straight away,
  and the field no longer jumps in size at the first character. The PIN pad shows
  that it is checking, instead of silently emptying its four dots and throwing
  away the code you typed in the meantime.

## 3.0.2

### hu

- **Egy pillanatnyi hálózati zavar nem hiúsítja meg a frissítést.** A letöltési
  kiszolgáló időnként másodpercekre elérhetetlen. Eddig ilyenkor a box hibát írt
  ki a Beállításokban, és az aznap éjjeli automatikus frissítés is elmaradt,
  pedig másodpercekkel később már minden ment volna. Mostantól újrapróbálkozik, és
  egy sikertelen keresés után sem kell percekig várni a következő próbára.

### en

- **A moment of network trouble no longer costs you an update.** The download
  server is unreachable for a few seconds now and then. The box used to show an
  error in Settings and skip that night's automatic update over it, when trying
  again seconds later would have worked. It retries now, and a failed check no
  longer makes you wait minutes before the next attempt.

## 3.0.1

### hu

- **A rendszerfrissítés gombja most már meg is jelenik.** A 3.0.0-ban a box nem
  tudta megállapítani magáról, hogy képes-e rendszerfrissítésre, ezért a gomb
  akkor is rejtve maradt volna, amikor lett volna mit telepíteni. Semmi nem
  romlott el tőle, csak nem lehetett volna használni azt, amiért a 3.0.0
  készült.

### en

- **The system update button actually appears now.** In 3.0.0 the box could not
  tell whether it was able to run a system update, so the button would have
  stayed hidden even when there was something to install. Nothing broke because
  of it, you just could not have used the thing 3.0.0 was for.

## 3.0.0

### hu

- **A nagyobb frissítések is felmennek maguktól.** Eddig, ha egy frissítéshez a
  rendszerhez is hozzá kellett nyúlni, a boxot újra kellett telepíteni egy
  számítógépről, és így a frissítésnek pont akkor nem volt haszna, amikor a
  legnagyobb lett volna. Mostantól a box ezt magától megcsinálja: Beállítások →
  Szoftverfrissítés, egy gomb, néhány perc, újraindítás nélkül, és közben végig
  használható marad. Csak olyan frissítést enged fel, amelyik igazoltan ettől a
  projekttől való, régebbit pedig soha.

- **A képernyőtükrözés a memóriakártyáról telepített boxokon is működik.** Eddig
  ott megjelent a beállítás, de a telefon nem talált semmit, mert a tükrözés fele
  fel sem került a boxra.

- Egyszeri teendő, számítógépről: minden meglévő boxnak kell egyszer egy
  `./deploy/deploy.sh <box>` vagy egy újratelepítés, hogy ezt megkapja. Enélkül
  minden a régiben működik, csak a nagyobb frissítéseket nem tudja majd magától
  felrakni.

### en

- **Bigger updates install themselves now.** Until now an update that also had to
  touch the system meant re-flashing the box from a computer, so updating was
  least useful exactly when it mattered most. The box does it by itself now:
  Settings → Software update, one button, a few minutes, no restart, and the box
  keeps working throughout. It only accepts an update that is provably from this
  project, and never an older one.

- **Screen mirroring works on boxes flashed from the SD image.** The setting was
  there, but your phone found nothing, because half of mirroring was never put on
  the box.

- One thing to do once, from a computer: every box you already have needs a single
  `./deploy/deploy.sh <box>` or a re-flash to gain this. Without it everything
  keeps working as before, the box just cannot install the bigger updates by
  itself.

## 2.18.0

### hu

- **A beírás oda kerül, ahová szántad.** Ha egy alkalmazásban egy mezőbe kellett
  írni - például az e-mail-címedet a bejelentkezéshez -, a box egy fölösleges „a"
  betűt tett a beírt szöveg elé, így a bejelentkezés nem sikerült. Ez elmúlt. A
  billentyűzet ráadásul mostantól azzal nyílik, ami már a mezőben van, tehát egy
  elgépelt betűt ki lehet javítani ahelyett, hogy az egészet újra kellene írni.

- **Az Újraindítás tényleg újraindít.** Eddig a Beállítások → Újraindítás
  megakaszthatta a boxot: a kép maradt, de a távirányító nem csinált semmit, és
  csak az áramtalanítás segített. Mostantól rendesen újraindul, és ha valamiért
  mégsem sikerül, kiírja a képernyőre, miért.

- **A box saját wifije és Bluetooth-a kikapcsolható véglegesen.** A Beállításokban
  külön-külön kikapcsolható mindkettő, és a kikapcsolás túléli az újraindítást is -
  ez az, ami felszabadítja az antennát egy USB-s wifi- vagy Bluetooth-adapternek.

### en

- **What you type lands the way you typed it.** Filling in a field inside an app -
  your e-mail address on a sign-in page, say - used to put a stray "a" in front of
  the text, so signing in failed. That is gone. The keyboard also opens on what
  the field already holds now, so a single wrong letter can be corrected instead of
  retyping the lot.

- **Restart actually restarts.** Settings → Restart could leave the box stuck: the
  picture stayed up, the remote did nothing, and only unplugging it helped. It
  reboots properly now, and if it ever cannot, it says so on screen instead of
  going quiet.

- **The box's own Wi-Fi and Bluetooth can be turned off for good.** Each can be
  switched off in Settings and stays off across a reboot - which is what frees the
  antenna for a USB Wi-Fi or Bluetooth adapter.

## 2.17.1

### hu

- **A távirányítós mikrofon nem tud némán elakadni.** Ha az asszisztens elkezd egy
  kérdést és aztán nem válaszol, a doboz eddig kivárta a végtelenségig: a mikrofon
  utána már semmit nem küldött, és semmi nem jelezte, hogy baj van. Mostantól egy
  perc után magától újrakapcsolódik, és a következő nyomásra megint működik.

### en

- **The remote's microphone can no longer get stuck without saying so.** If the
  assistant started a question and then never answered, the box waited for it
  forever: after that the microphone sent nothing, and nothing said why. It now
  reconnects on its own after a minute, and the next press works again.

## 2.17.0

### hu

- **Olyan készülékhez is van kód, amihez eddig egyik adatbázisban sem volt.** Néhány
  soundbar és hangfal a saját jelét használja, amit a régi kódlista nem tudott leírni,
  így a távirányítóra sem lehetett felvinni. A kódlista mostantól egy második,
  felvétel-alapú adatbázist is tartalmaz, szóval ezek a készülékek is kiválaszthatók.
- **Azonnal betölt a lista.** Egy márka megnyitása eddig letöltéssel járt, a nagyobbaknál
  kivárással; most egy apró fájl az egész. A sor azt is mutatja, melyik adatbázisból jön
  a kód, és mennyi távirányító küldi ugyanazt.
- **Ami már be van állítva, az marad, és megbízhatóbb lett.** A beállítás magukat a
  kódokat tárolja, így a "Mentés a távirányítóra" internet nélkül is működik, és nem
  változik meg attól, hogy a kódlista közben frissült.
- A kódlista hetente újraépül, és a Beállítások megmutatja, mikor készült.

### en

- **There are now codes for devices no database could describe before.** Some soundbars
  and speakers use a signal of their own that the old code list could not express, so
  they could not be put on the remote at all. The list now includes a second,
  capture-based database, so those devices can be picked too.
- **The list opens at once.** Choosing a brand used to mean a download, and a wait on the
  bigger brands; now it is one small file. A row also says which database its code comes
  from, and how many remotes send the same one.
- **Whatever is already set up stays, and is steadier.** The setup stores the codes
  themselves, so "Save to the remote" works with no internet and cannot change because
  the code list moved on.
- The code list is rebuilt weekly, and Settings shows when it was made.

## 2.16.0

### hu

- **Új alapokon a távirányító TV-vezérlése.** Nem kódszámok közül kell találgatni:
  felveszed, ami a szobában van - TV, soundbar -, aztán megmondod, melyik gomb
  melyiket vezérelje. Egy gombra két készülék is köthető, így egy nyomás mindkettőnek
  szól. A márkák közt kereshetsz vagy kezdőbetű szerint lépkedhetsz, és a doboz
  felajánlja annak a TV-nek a márkáját, amelyikbe be van dugva.
- **Rövid lett a kódlista.** Egy márkánál eddig több tucat, egyforma nevű sor jött,
  a légkondiktól kezdve mindennel. Mostantól az azonos jelet küldő kódok egy sorban
  vannak, és ha épp a hangerőt állítod be, csak azok látszanak, amikben van hangerő:
  Samsungnál 68 helyett 13. Ami marad, arról a sor megmondja, mit tud.
- **A listákban nem ugrik át sorokat a távirányító.**
- **Egy távirányítót lenyitva rövid menü fogad**: gombok, megkeresés, TV IR. A
  gombok betanítása külön oldalra került, így nem kell végiggörgetni huszonöt sort,
  hogy a többit lásd.
- **A gombok visszaállítása rákérdez**, mielőtt törölné, amit betanítottál - és a
  kérdés alapból a Mégsén áll.
- **Javítva:** a Távirányítók és eszközök képernyő a valóban jelen lévő
  távirányítókat számolja, nem a régen törölteket is.

### en

- **The remote's TV control, rebuilt.** No more guessing between code numbers: you
  add what is in the room - a TV, a soundbar - and then say which button drives
  which. A button can carry two devices, so one press reaches both. Search the
  brands or step in by first letter; the box offers the brand of the TV it is
  plugged into.
- **The code list got short.** A brand used to arrive as dozens of identically named
  rows, air conditioners and all. Codes that send the same thing are now one row,
  and when you are setting up volume only the ones that have volume are listed:
  13 instead of 68 for Samsung. Each row says what it can drive.
- **No more skipped rows** when moving through those lists with the remote.
- **Opening a remote gives you a short menu**: buttons, find it, TV IR. Teaching the
  buttons moved to its own page, so twenty-five rows no longer stand between you and
  everything else.
- **Resetting a remote's buttons asks first**, and the question starts on Cancel.
- **Fixed:** the Remotes & accessories screen counts the remotes that are actually
  here, not ones removed long ago.

## 2.15.0

### hu

- **A távirányító két programozható gombja és a fejhallgatós gombja is
  használható.** Eddig nem történt tőlük semmi. Most ugyanúgy betaníthatók, mint
  bármelyik másik gomb (Beállítások → Távirányítók és kiegészítők), és bármelyik
  alkalmazásra ráköthetők.
- **Megkerested már a kanapé alatt a távirányítót?** Most szólni tud magáért:
  megcsörgeted, és a hang elvezet hozzá. Ott van a távirányító beállításai közt,
  de telefonról és Home Assistantból is elindítható - hiszen a gomb, amit
  megnyomnál, épp azon a távirányítón van, amit keresel. Egy perc után magától
  elhallgat. Csak az újabb, csipogóval szerelt távirányítóknál jelenik meg.

### en

- **The remote's two customizable buttons and its headphone button work.**
  Nothing happened when you pressed them before. They can now be taught like any
  other button (Settings → Remotes & accessories) and bound to any app.
- **Looked under the sofa lately?** The remote can call out now: ring it and
  follow the sound. It is in the remote's own settings, and it can be started
  from a phone or from Home Assistant too - because the button you would press
  is on the very thing you are looking for. It stops by itself after a minute.
  Only newer remotes with a buzzer show it.

## 2.14.0

### hu

- **Emulátoronként is áthozhatók a mentések, nem csak egyben.** A RetroArch
  Mentések fülén minden emulátor külön sorban áll a saját két dátumával, és külön
  gombbal hozható át. Egyetlen dátum a boxra nem árulja el, melyik szobában van a
  frissebb mentés, ha az egyikben SNES-szel, a másikban GameCube-bal játszottak.

### en

- **Saves can be brought one emulator at a time, not just all at once.**
  RetroArch's Saves tab lists each emulator on its own row, with its own two dates
  and its own button. One date per box cannot say where the fresher save is when one
  room played the SNES and the other the GameCube.

## 2.13.0

### hu

- **A mentések áthozása előtt látod, melyik az újabb.** A RetroArch Mentések fülén
  minden összekötött box mellett ott a két dátum - mikor írták ott, mikor itt -, és
  hogy hány fájl újabb odaát. Ha valami ITT újabb, azt külön kiírja: a másolás azt
  is felülírná.

### en

- **Before you bring saves over, you can see which side is newer.** RetroArch's
  Saves tab now shows both dates next to each connected box - when it was last
  written there, and here - and how many files are newer over there. If something
  here is newer, it says so separately: a copy would replace that too.

## 2.12.0

### hu

- **A mentések áthozása átkerült oda, ahová való: a RetroArch alkalmazásba.**
  Eddig a box beállításaiban volt egy gomb, ami játékmentésekről beszélt - azon a
  tévén is, ahol emulátor sincs telepítve. Mostantól a RetroArch új _Mentések_
  fülén hozod át a másik boxról a mentéseidet és a pillanatképeidet. A
  beállításokban csak az marad, ami tényleg a boxé: melyik alkalmazás melyik
  mappáját osztod meg, és melyik boxot engedted be.
- **Egy kód, mindkét irány.** Elég az egyik tévén beírni: onnantól mindkét box
  olvassa a másikét. Eddig ehhez át kellett menni a másik szobába, ott is kódot
  mutatni és visszagépelni.
- **Minden beengedett box saját kulcsot kap.** Ha elfelejtesz egyet, csak az ő
  kulcsa szűnik meg - a többi szoba marad, ahogy volt.
- Ha egy boxon még el sem indult az emulátor, a mentések oda is áthozhatók: a box
  létrehozza a mappát, ahelyett hogy hibát írna ki.
- A korábban összekötött boxokat egyszer újra össze kell kötni: a régi, közös
  jelszó helyét vette át a boxonkénti kulcs.

### en

- **Bringing saves across moved into the RetroArch app, where it belongs.** It
  used to be a button in the box's own settings that talked about game saves -
  even on a TV with no emulator installed. Now RetroArch has a _Saves_ tab that
  brings your saves and save states over from the other box. Settings keeps only
  what is really the box's: which of an app's folders you share, and which boxes
  you have let in.
- **One code, both directions.** Type it once, on either TV, and from then on each
  box can read the other. It used to mean walking to the other room, showing a
  second code and typing it back.
- **Every box you let in gets a key of its own.** Forget one and only that key
  stops working - the other rooms carry on.
- Saves can be brought to a box where the emulator has never run: the box creates
  the folder instead of reporting a failure.
- Boxes connected before this update need connecting once more: the shared
  password they used has been replaced by a key per box.

## 2.11.0

### hu

- **A mentéseid átvihetők a másik boxra.** Ha két box van a lakásban, egy
  szobában elkezdett játékot eddig nem lehetett a másikban folytatni. Mostantól
  egyszer összekötöd a két boxot - az egyik mutat egy négyjegyű kódot, a másik
  megkeresi és beírod -, és onnantól egy gombnyomással áthozod a mentéseket arra
  a boxra, amelyiken játszani szeretnél. Beállítások → Hálózat → Mentések
  megosztása. Mindig csak **hozni** lehet, küldeni nem: így ha ketten játszotok
  két szobában, nem tudjátok felülírni egymás mentését. Amit egy áthozás
  felülírna, azt a box félreteszi.
- Az alkalmazás előre megmondja, melyik mappáit oszthatja meg így, és a
  megosztás alapból ki van kapcsolva.
- **A kontrollered ravaszai akkor is jók maradnak, ha a box a bekapcsolás
  pillanatában veszi kézbe.** Bizonyos padoknál a jobb analóg kar és a ravaszok
  felcserélődtek: mindkét ravasz halott volt, a kar meg félig lenyomva állt.

### en

- **Your saves can travel to your other box.** With two boxes in the house, a
  game started in one room could not be picked up in the other. Now you connect
  the two once - one shows a four-digit code, the other finds it and you type the
  code - and after that one press brings the saves to whichever box you want to
  play on. Settings → Network → Saves sharing. You can only ever **bring** saves,
  never send them, so two people playing in two rooms cannot overwrite each
  other; and anything a transfer would replace is kept.
- An app says in advance which of its folders may be shared this way, and
  sharing is off until you turn it on.
- **A controller keeps its triggers even when the box grabs it the moment it
  connects.** On some pads the right stick and the triggers swapped places: both
  triggers were dead and the stick sat half-pressed.

## 2.10.1

### hu

- **A távirányítós hangvezérlés nem akad be többé.** Ha a mikrofon gombot túl
  röviden nyomtad meg, a box utána néma maradt: a kérdéseidre nem jött válasz, és
  csak a szolgáltatás újraindítása segített. A túl rövid nyomás most egyszerűen
  nem indít semmit.
- Ha a Home Assistant egy kérdést válasz nélkül hagy, a box egy perc után magától
  újrakapcsolódik hozzá, ahelyett hogy némán várna. Egy újracsatlakozó Home
  Assistantot sem utasít vissza többé.

### en

- **Voice through the remote no longer gets stuck.** A mic key pressed too
  briefly used to leave the box silent afterwards, with no answer to anything and
  nothing short of restarting the service to fix it. A press that catches no
  speech now starts nothing.
- If Home Assistant leaves a request unanswered, the box reconnects to it after a
  minute instead of waiting silently, and it no longer turns away a Home
  Assistant that is reconnecting.

## 2.10.0

### hu

- **Saját alkalmazásforrások.** Beállítások → Alkalmazások → Store források:
  a hivatalos kínálat mellé felvehetsz továbbiakat is (legfeljebb tízet), és a
  bolt egyben mutatja mindet. Minden appnál látszik, melyik forrásból való.
- A hozzáadott források appjait **nem mi ellenőrizzük**, és ugyanazt tudják a
  boxon, mint a hivatalosak. Ezért a hozzáadás előtt a képernyő figyelmeztet, és
  kétszer kell megnyomni. Csak olyan forrást vegyél fel, amelynek az
  üzemeltetőjében megbízol.
- **Az éjszakai frissítés forrásonként állítható.** A hivatalos forrás alapból
  magától frissül, amit te veszel fel, az alapból nem: ott te döntöd el, mikor
  frissüljön.
- A box megjegyzi, melyik forrásból telepítettél egy appot, így egy másik forrás
  nem veheti át magától azzal, hogy ugyanazon a néven ad ki újabb verziót.
- Ha egy forrás nem válaszol, csak az ő appjai hiányoznak, a bolt többi része
  megmarad, és a Források oldalon látod, melyik néma.

### en

- **Your own app sources.** Settings → Apps → Store sources: add more registries
  next to the official one (up to ten), and the store shows them as one
  catalogue. Every app says which source it came from.
- Apps from an added registry are **not reviewed by us**, and they can do
  everything an official one's apps can. So the screen warns you before you add
  one, and the press has to be repeated. Only add a source whose owner you trust.
- **Overnight updates are per source.** The official registry keeps updating
  itself; anything you add does not, until you turn it on for that source.
- The box remembers which registry each app was installed from, so another one
  cannot take an app over on its own by publishing a higher version under the
  same name.
- If a source does not answer, only its apps are missing. The rest of the store
  stays, and the Sources screen names the one that went quiet.

## 2.9.1

### hu

- **A távirányítóval megint minden sorra rá lehet állni.** A listákban néha
  kimaradt egy sor - se le, se fel nem lehetett ráállni -, és hogy melyik, az
  attól függött, mi volt fölötte. Ez most javítva, mindenhol.
- A párosított telefonoknál egy sor megmutatja a box címét QR-kóddal, ha egy már
  párosított telefonon újra meg kell nyitni. Ez nem ad új párosítási kódot, így
  nem érvényteleníti a másik telefonét.
- A telefonról küldött képeknél most látszik a feltöltött képek előnézete, és
  egyesével is le lehet venni őket a TV-ről.

### en

- **Every row can be reached with the remote again.** A list would sometimes skip
  one - it could not be focused from above or below - and which row it was
  depended on what sat above it. Fixed everywhere.
- The paired phones now have a row that shows the box's address as a QR code, for
  reopening it on a phone that is already paired. It issues no new pairing code,
  so it cannot invalidate another phone's.
- Photos cast from a phone are shown back with previews, and can be taken off the
  TV one at a time.

## 2.9.0

### hu

- **Biztonsági javítás a szülői felügyeletben.** A "PIN kérése kényes
  műveletekhez" kapcsolót eddig PIN nélkül ki lehetett kapcsolni - vagyis meg
  lehetett kerülni vele magát a PIN-t. Mostantól a kikapcsolás is PIN-t kér
  (a bekapcsolás nem).
- **Fejlesztői eszközök** a Beállítások → Rendszer alatt: a Chromium hibakereső
  egy indulásra, és a TV képének megosztása a párosított telefonoddal. Utóbbi
  külön kapcsoló, magától lejár, és a telefonon nagyítható.
- A képernyő-billentyűzet PIN-panelján megint lehet lefelé navigálni.

### en

- **A security fix in parental controls.** The "require PIN for sensitive
  actions" switch could be turned off without the PIN - which was a way around
  the PIN itself. Turning it off now asks for it (turning it on does not).
- **Developer tools** under Settings → System: the Chromium debugger for one
  boot, and sharing the TV's screen with your paired phone. That one is a
  separate switch, runs out on its own, and can be zoomed on the phone.
- The PIN pad can be navigated with the arrows again.

## 2.8.0

### hu

- **A telefonod is lehet távirányító.** Beállítások → Távirányítók és eszközök →
  Telefon távirányítóként: kapcsold be, olvasd be a TV-n megjelenő kódot, és a
  telefonod ugyanazokat a gombokat nyomja, mint a távirányító. Alapból ki van
  kapcsolva, és amíg ki van, a box semmit nem fogad a hálózatról. A párosított
  telefonokat itt látod és bármelyiket törölheted.
- **A billentyűzetkiosztás végre megmarad.** Eddig újraindítás után visszaállt -
  most a kiválasztott kiosztás túléli a bekapcsolást, és a képernyő-billentyűzet
  is követi (magyarnál QWERTZ, ékezetekkel).

### en

- **Your phone can be the remote.** Settings → Remotes and devices → Phone as a
  remote: turn it on, scan the code shown on the TV, and your phone presses the
  same buttons the remote does. It is off by default, and while it is off the box
  accepts nothing from the network. Paired phones are listed here and any of them
  can be removed.
- **The keyboard layout is finally remembered.** It used to revert on every
  restart; the layout you pick now survives, and the on-screen keyboard follows
  it (QWERTZ with accents for Hungarian).

## 2.7.0

### hu

- **A képernyő-billentyűzeten már van vessző - és ékezet is.** A `#+=` gomb
  átvált írásjelekre és azokra a betűkre, amiket a sima billentyűsor nem tud.
  Kereséshez (RetroArch, Plex, Jellyfin) eddig hiányzott mindkettő.
- Hogy melyik betűk jelennek meg, azt a Beállítások → Rendszer → Régió alatt
  megadott **billentyűzetkiosztás** dönti el, ugyanaz, amit egy bedugott
  billentyűzet is használ.

### en

- **The on-screen keyboard has a comma now - and accents.** The `#+=` key
  switches to punctuation and to the letters a plain keyboard row cannot
  produce. Searching (RetroArch, Plex, Jellyfin) was missing both.
- Which letters you get follows the **keyboard layout** set in Settings →
  System → Region, the same one a plugged-in keyboard uses.

## 2.6.0

### hu

- **Képeket is nézhetsz a TV-n.** Egy mappa fotói rácsban nyílnak meg, bármelyik
  kitölti a képernyőt, és a nyilakkal lapozol köztük. Az OK gomb nagyít,
  nagyításban az iránygombokkal mozogsz a képen belül.
- **Küldhetsz képeket a telefonodról.** A Fájlok appban válaszd a "Telefonról"
  sort, olvasd be a kódot a telefonoddal, és a kiválasztott képek megjelennek a
  TV-n, ahogy érkeznek. Amikor bezárod, le is kerülnek a boxról.
- A Fájlok kezdőképernyőjén a telefon, az USB-kulcs és a hálózati megosztás
  külön, felül van, nem a box saját mappái közé keveredve.

> A képekhez a Fájlok appnak is frissülnie kell - magától megteszi.

### en

- **You can look at photos on the TV now.** A folder of them opens as a grid, any
  one fills the screen, and the arrows move between them. OK enlarges a photo,
  and the arrows then move around inside it.
- **You can send photos from your phone.** In the Files app pick "From your
  phone", scan the code, and the photos you choose appear on the TV as they
  arrive. They come off the box again when you close it.
- On the Files home screen your phone, a USB stick and a network share are their
  own group at the top, instead of being mixed in with the box's own folders.

> Photos also need the Files app to update - it does that by itself.

## 2.5.1

### hu

- Az értesítés sávja olvasható méretben jelenik meg, és nem duplázódik: eddig a
  főképernyő is kirajzolta a magáét.

### en

- The notification strip is drawn at a readable size, and no longer doubled: the
  home screen used to draw its own copy as well.

## 2.5.0

### hu

- **Az értesítés mostantól minden fölött látszik.** Eddig csak akkor, ha épp a
  főképernyőn voltál; ha egy app futott, elbújt mögötte. Most egy külön kis sáv
  jelenik meg a képernyő alján, bármi is megy éppen.
- **Nem szakítja félbe, amit nézel.** Csak a sáv jelenik meg, nem ugrik elő a
  főképernyő, és a távirányító végig annál marad, amit használsz.

> Ehhez a box képkezelőjének frissülnie kell (a frissítés hozza). Régebbi
> képkezelőn minden a régiben marad, nem romlik el semmi.

### en

- **A notification is now seen over everything.** Until now it only showed while
  you were on the home screen; with an app running it was hidden behind it. It
  appears in a small strip at the bottom instead, whatever is playing.
- **It does not interrupt what you are watching.** Only the strip appears, the home
  screen does not jump in front, and the remote stays with whatever you are using.

> This needs the box's window manager to update too (the update brings it). On an
> older one everything behaves as before; nothing breaks.

## 2.4.0

### hu

- **Beszélhetsz a távirányítóhoz.** Tartsd nyomva a mikrofon gombot, mondd meg mit
  szeretnél, engedd el: a Home Assistant válaszol, és a válasz a TV-n szólal meg.
  Nem kell ébresztőszó, mert a gomb az.
- **Azt a szobát vezérli, ahol ülsz.** Ha a boxot hozzárendeled egy szobához a Home
  Assistantban, a „kapcsold le a lámpát" ott kapcsol le, nem máshol.
- Film közben nem kell leállítani semmit: a hang halkul a válasz idejére, aztán
  visszaáll.
- Alapból ki van kapcsolva, mert a bekapcsolásával a box nyit egy portot a helyi
  hálózaton. A Beállítások → Hálózat menüben nincs kapcsoló hozzá, a
  `config.json`-ban kapcsolható be (lásd a dokumentációt).

> **Kell hozzá egy rendszerbeállítás, amit a frissítés nem tud telepíteni.** Friss
> telepítésű boxon megy; csak frissítéssel érkező boxon a mikrofon néma marad.

### en

- **Talk to your remote.** Hold the mic key, say what you want, let go: Home
  Assistant answers and the answer comes out of the TV. No wake word - the button
  is the wake word.
- **It acts in the room you are in.** Assign the box to an area in Home Assistant
  and "turn off the light" means the light in that room.
- Nothing has to be stopped mid-film: the box's audio dips while the answer plays
  and comes back afterwards.
- Off by default, because turning it on opens a port on your local network. There
  is no switch in Settings yet; it is enabled in `config.json` (see the docs).

> **It needs a system setting an update cannot install.** Freshly flashed boxes
> have it; on a box that only ever updated over the air the microphone stays silent.

## 2.3.0

### hu

- **Több box egy helyen.** Ha be van állítva az MQTT, a box mostantól magáról is
  jelent: melyik verzió fut rajta, mikor indult, mennyire meleg, mennyi hely van
  rajta, és milyen gyors a wifi kapcsolata. Egy boxnál ez nem újdonság, a
  Beállításokban eddig is látszott; több boxnál viszont eddig mindegyiket külön
  kellett megnézni.
- **Megmarad, ami éjjel történt.** Ha egy frissítés nem tudott elindulni és a box
  visszaállt az előző verzióra, ezt reggel is látod: melyik verzió bukott el, mire
  állt vissza, és mikor. Eddig ez az információ nyomtalanul eltűnt.
- **Kiderül, ha a wifi lassul.** Nem a jelerősséget mutatja (az sokszor jó marad),
  hanem a tényleges kapcsolati sebességet, ami ilyenkor beesik.
- Home Assistantban ehhez nem kell semmit felvenni: a box eddigi eszközére
  kerülnek rá az új adatok.

### en

- **Several boxes in one place.** With MQTT configured, a box now also reports on
  itself: which version it runs, when it booted, how warm it is, how much space it
  has left, and how fast its wifi link is. On one box this was already in
  Settings; with more than one, each had to be visited separately.
- **What happened overnight is still there in the morning.** If an update could
  not boot and the box went back to the previous version, you can see which
  version failed, what it returned to, and when. That was lost without trace
  before.
- **A wifi link that has slowed down shows up.** Not the signal strength, which
  often stays fine, but the negotiated link rate, which is what collapses.
- Nothing to add in Home Assistant: the new values appear on the box's existing
  device.

## 2.2.0

### hu

- **A telefonod képe a TV-n.** Beállítások → Hálózat → Képernyőtükrözés: indítsd
  el, majd a telefonon válaszd ki a boxot a tükrözés (Samsungon Smart View)
  menüben. Nem kell hozzá app, PIN vagy fiók. Tükrözés közben a Vissza gombbal
  állíthatod le.
- A telefon közvetlenül a boxhoz csatlakozik, ezért a box wifi rádiója a
  tükrözés idejére vevővé alakul. **Ha a box wifin van, addig offline lesz** - a
  képernyő előre szól, és leállításkor magától visszacsatlakozik ugyanarra a
  hálózatra. Vezetékes boxon ez a kérdés fel sem merül.
- Ha két percen belül nem csatlakozik telefon, a box magától leáll és visszaadja
  a rádiót.

> **Frissítéssel érkező boxon a tükrözés nem kapcsol be** (rendszerbeállítás kell
> hozzá, amit a frissítés nem telepíthet); friss telepítésű boxon megy.

### en

- **Your phone's screen on the TV.** Settings → Network → Screen mirroring: start
  it, then pick the box in your phone's cast menu (Smart View on Samsung). No app,
  no PIN, no account. Press Back while mirroring to stop.
- The phone connects to the box directly, so the box's wifi radio becomes a
  receiver for the session. **If the box is on wifi it goes offline meanwhile** -
  the screen says so first, and it reconnects to the same network when you stop.
  A wired box never faces the question.
- If no phone connects within two minutes the box stops on its own and gives the
  radio back.

> **Mirroring stays off on a box that arrived by update** (it needs a system
> setting an update cannot install); a freshly installed box has it.

## 2.1.0

### hu

- **Fájlok a boxról és USB-kulcsról.** Új _Fájlok_ app: a box saját mappái és a
  bedugott pendrive-ok - a kulcsot megnyitáskor csatolja, és ugyanonnan ki is
  adhatod. Megjegyzi, hol tartottál egy filmben, és nézés közben válthatsz
  hangsávot vagy feliratot.
- **Hálózati megosztás (SMB).** Beállítások → Hálózat → Hálózati megosztások: add
  meg a NAS címét, a box kilistázza, mit kínál, és a megosztás forrásként
  megjelenik a Fájlok appban. A címet és a jelszót telefonról is beírhatod, QR-rel.
- **RetroArch: a játékok bárhol lehetnek.** Pendrive-on vagy hálózati
  megosztáson lévő mappát belinkelhetsz a könyvtárba (RetroArch → Mappák). Az app
  saját megosztás-beállítása megszűnt - a box csatol, az app linkel -, és a
  telefonos feltöltés is az appból indul.
- **Javítva:** az áruházban egy appot megnyitva a leírás és a gombok megint
  kiférnek a képernyőre.
- Egy app eltávolítása mostantól csak az áruházban van.

> **Frissítéssel érkező boxon az USB-kulcs olvasása nem kapcsol be** (rendszercsomag
> kell hozzá, amit a frissítés nem telepíthet). A saját mappák és a hálózati
> megosztás így is működnek; friss telepítésű boxon minden megy.

### en

- **Files from the box and from a USB stick.** A new _Files_ app: the box's own
  folders and any plugged-in stick - opening one mounts it, and the same screen
  ejects it. It remembers where each film got to, and audio track and subtitles
  can be switched while watching.
- **Network shares (SMB).** Settings → Network → Network shares: give it the NAS
  address, the box lists what the server offers, and the share turns up as a
  source in the Files app. The address and the password can be typed on a phone
  with a QR.
- **RetroArch: games can live anywhere.** A folder on a stick or a network share
  can be linked into the library (RetroArch → Folders). The app's own share setup
  is gone - the box mounts, the app links - and uploading games from a phone
  starts in the app.
- **Fixed:** opening an app in the store shows its description and buttons on the
  whole screen again.
- Removing an app now lives only in the store.

> **A box that only takes over-the-air updates will not gain USB stick support**
> (it needs a system package an update cannot install). Its own folders and
> network shares work regardless; a freshly flashed box has everything.

## 2.0.3

### hu

- **Egy appból visszatérve a főképernyő jön, nem a képernyővédő.** A tétlenségi
  idő eddig az app alatt is ketyegett, így mire visszamentél, már be volt
  kapcsolva.
- **A képernyővédő nem takarja el a gépelést.** Ha telefonról vagy a képernyő-
  billentyűzeten írtál be valamit, egy idő után ráúszott a beírómezőre.
- **Ha egy alkalmazás összeomlik, a doboz nem áll meg percekre.** Az összeomlás
  után készülő memóriakép addig írta a kártyát, hogy közben semmi más nem
  reagált - se a távirányító, se a kép. Ez most pár másodperc.

### en

- **Coming back from an app lands on Home, not on the screen saver.** The idle
  timer kept running while the app was in front, so the screen saver was already
  up by the time you got back.
- **The screen saver no longer covers the typing screen.** Typing from a phone or
  the on-screen keyboard could end up underneath it after a while.
- **A crashing app no longer stops the box for minutes.** The crash report it
  wrote to the card kept everything else waiting - the remote, the picture, all
  of it. Now it is a couple of seconds.

## 2.0.2

### hu

- **Új Beállítások képernyő.** Eddig egy kategória alatt minden egy hosszú oszlopba
  volt öntve - a Hálózat alatt például a wifi-kereső, a fájlmegosztás és a Home
  Assistant egymás alatt. Most bal oldalt vannak a kategóriák, jobbra a hozzájuk
  tartozó sorok, és aminek több beállítása van, annak saját oldala lett. A legtöbb sor
  jobb szélén ott áll, hogy épp mi van beállítva, így a nyitóképernyőn látod, mit
  csinál a doboz, anélkül hogy bármit meg kellene nyitnod.
- **A Bluetooth-eszközök saját oldalt kaptak**: csatlakoztatás, lecsatlakoztatás és
  eltávolítás egy helyen, az eszköz töltöttségével együtt. A listában ikon mutatja,
  hogy hangszóró, billentyűzet vagy távirányító.
- **Egy mentett wifi-hálózatra újra rá lehet csatlakozni** anélkül, hogy előbb el
  kellene felejteni és újra begépelni a jelszót.
- A képernyővédő elalvási ideje választható lista lett a körbekattintgatás helyett,
  a Névjegy adatai csoportokba kerültek, a nyílt forráskódú hivatkozások pedig
  külön oldalra.

### en

- **A new Settings screen.** A category used to be one long column - Network alone
  stacked the wifi scanner, the file sharing and Home Assistant one under the other.
  Now the categories are on the left, their rows on the right, and anything with
  more than a couple of settings has a page of its own. Most rows show what they are
  currently set to, so the first screen tells you what the box is doing without
  opening anything.
- **Bluetooth devices have their own page**: connect, disconnect and remove in one
  place, with the device's battery. The list shows an icon for a speaker, a keyboard
  or a remote.
- **A saved wifi network can be joined again** without having to forget it and
  retype the password first.
- The screen saver's sleep delay is a list to pick from instead of a button you
  click through, the About figures are grouped, and the open-source credits moved to
  a page of their own.

## 2.0.1

### hu

- **A wifi-jelszó, amit begépelsz, tényleg az érvényes.** Egy már ismert hálózatnál
  eddig a régen mentett jelszó ment ki helyette, és a csatlakozás azonnal elhasalt.
  Ha az új jelszóval sem sikerül felcsatlakozni, a doboz visszaírja a régit, és
  megmondja, mi volt a baj - rossz jelszó, vagy nem válaszolt a hálózat. Semmit nem
  töröl: ha egy mentett hálózat végleg elavult, a Felejtsd el gomb a tiéd.
- **A kikapcsolt TV nem nézi végig helyetted a sorozatot.** A film közben
  kikapcsolt TV eddig úgy állította le a lejátszást, mintha a rész véget ért volna,
  amire a Plex pár másodperc múlva elindította a következőt - sötét szobában, végig.
  Ugyanez vonatkozik a telefonról küldött megállításra és az appváltásra is. (A
  Plexhez ehhez az app 1.2.1-es változata is kell; a doboz éjszaka magától
  frissíti.)
- **A beállításokban a kijelölt wifi-hálózat két széle nem vágódik le.**
- A távirányító túl gyors gombismétlése is megszűnt, de az a compositorral érkezik,
  nem ezzel a frissítéssel: ahhoz újraflashelés vagy provision kell.

### en

- **The wifi password you type is the one that gets used.** On a network the box
  already knew, the saved password went out instead and the attempt failed at once.
  If the new one does not get the box on either, the old password is put back and
  the screen says what went wrong - a password that was not accepted, or a network
  that did not answer. Nothing is deleted: a saved network that has gone stale for
  good is what the Forget button is for.
- **A TV switched off no longer watches the series for you.** Turning the TV off
  during a film used to end playback as if the episode had finished, so Plex
  started the next one a few seconds later, and kept going in a dark room. The same
  now goes for a stop sent from a phone and for switching to another app. (Plex
  needs its own 1.2.1 package for this; the box picks that up overnight.)
- **The selected wifi network is no longer clipped at both edges in Settings.**
- Remote buttons no longer repeat far too fast, but that fix arrives with the
  compositor rather than with this update: it needs a re-flash or a provision.

## 2.0.0

### hu

- **A box saját compositoron fut.** Ez a réteg dönti el, mi kerül a képernyőre és
  hogyan: a film egyenesen a képernyő hardveres rétegére megy, a kezelőfelület
  külön rétegre fölé. Ami ebből látszik: a 4K HDR film nem akadozik, a kép azonnal
  ott van, és a doboz közben hűvösebb marad.
- **A HDR most tényleg bekapcsol.** A TV a filmhez átvált HDR-be, és a film végén
  vissza - és a kép 10 bites, nem 8.
- **Az élő adás nem ugrál feleslegesen 4K-ra.** Egy szélesvásznú csatorna eddig 4K
  módba kapcsolta a TV-t, amitől a kép szaggatott; most a hozzá illő felbontáson
  marad.
- **Ez a verzió nem érkezik meg magától.** A doboz alaprendszere is változott,
  amit egy szokásos frissítés nem tud elhozni: újraflashelés vagy provision kell
  hozzá. A Beállítások meg is írja, ha ez a helyzet.

### en

- **The box runs its own compositor.** That layer decides what reaches the screen
  and how: the film goes straight to the display's own hardware layer, with the
  interface on a separate layer above it. What you see of that: a 4K HDR film that
  does not stutter, a picture that is there immediately, and a cooler box.
- **HDR actually engages now.** The TV switches into HDR for the film and back
  afterwards, and the picture is 10-bit rather than 8.
- **Live TV stops jumping to 4K for no reason.** A widescreen channel used to
  switch the set into 4K and judder; it stays at the resolution that suits it.
- **This version does not arrive on its own.** The system underneath changed in a
  way an ordinary update cannot deliver, so the box needs a re-flash or a
  provision. Settings says so when that is the case.

### notes

Not release notes for the TV - for whoever runs the boxes:

**What changed underneath.** labwc and wlroots are gone, along with the eleven
local patches that made a fullscreen film reach a display plane. The box runs
[tvbox-wc](https://github.com/Andy1210/tvbox-wc), a compositor built on Smithay for
this hardware, installed from a pinned release by sha256
(`deploy/compositor.version`). greetd starts `tvbox-wc -- /usr/local/bin/tvbox-session`
and the compositor starts the session, so the shell is one of its clients.

**What the shell hands to it**, over `$XDG_RUNTIME_DIR/tvbox-wc.sock` (one JSON
object per line): output modes, the HDR claim, which of the launcher and an app owns
the screen - the compositor rewrites the remote's Back key for an app, so three
`sendInputEvent` copies went - window placement (picture-in-picture no longer needs
XWayland), typing into a focused field, and screenshots.

**Measured on the 4K set**, a real HDR10 film through the whole chain: P030 on the
primary plane, the UI on an overlay, 0 dropped frames, and the compositor at 0 ms of
GPU per 10 s of playback. The colour space goes to BT.2020 with a PQ metadata block
and the link to 10 bits, and all three come back on release.

**Two things to know before rolling this out.** A release now declares what the box
must already have (`requires: ["compositor"]` in the feed); a box that cannot
satisfy it is never offered the update, which is what keeps this release off a box
still running the old session. And a main.js change is not verified until the shell
has restarted on a box and answered a request - nothing in the test suite can load
that file.

## 1.24.7

### hu

- **A film indulásakor nincs többé akadozás.** Eddig a kép az első pár másodpercben
  szaggatott, aztán magától rendbe jött. Frissen telepített vagy újraprovisionált
  boxon jár, a régieken a következő provisionig marad a mostani működés.
- **A fájlmegosztás megint működik.** A box mappáit hálózaton kínáló szolgáltatás
  napokig nem indult el, és semmi nem jelezte. Most elindul, és ha valami mégis
  megakadályozza, azt meg is írja a naplóba.

### en

- **No more stutter when a film starts.** The picture used to judder for the first
  couple of seconds and then settle by itself. Freshly flashed or re-provisioned
  boxes get this; existing ones keep working as they do now until their next
  provision.
- **File sharing works again.** The service that offers the box's folders over the
  network had not been starting for days, and nothing said so. Now it starts, and if
  something does stop it, it says what in the log.

### notes

Not release notes for the TV - for whoever runs the boxes:

**What the film-start stutter actually was.** Measured on `tvbox-livingroom` with a
4K HDR title, sampling labwc's `drm-engine-render` from `/proc/<labwc>/fdinfo/*`
every 200 ms: the compositor burned **345-597 ms of GPU render time per second for
the first 4.6 s** of every film, then 0.00 ms/s for the rest. mpv was innocent
throughout - zero dropped, delayed and decoder-dropped frames, a steady 24.0 fps -
so it was presentation, not decoding.

Two causes, one chain. `SCENE_OFFLOAD_BACKOFF` in `wlroots-0004` was 60 **frames**,
which is one second at 60 Hz and two and a half at 23.976, the rate a 24p film runs
at; it is a duration now, converted through the output's own refresh rate, and an
ineligible scene is no longer waited on at all (it is decided before any round trip
and changes frame to frame). The trigger was `labwc-0002` committing the HDR state
from inside the config reload, which lands on a page-flip already in flight often
enough to matter - and a failed commit leaves the render format on the long-lived
pending state, which is exactly what makes `wlr_scene` refuse direct scan-out. It
schedules a frame instead. **After: 4.67 s -> 0.08 s** of compositing, the two
remaining frames being the modeset itself.

**The split this release has, and it matters.** The file-server fix is shell code and
arrives over OTA. The film-start fix is in the compositor patches: OTA ships the
corrected `.patch` files and `install-labwc-planes.sh`, but it cannot RUN them - the
build needs apt and root. So an OTA-only box gets the files and keeps the compositor
it has until its next provision.

**The file server had been down for two days and nothing pointed at it.** The holder
was an orphaned `rclone serve webdav` on `:8098` with ppid 1, left by a shell that
died by signal, and the log said only `exited code 1` because the stderr pipe was
never drained. Now stderr is piped by default and forwarded line by line, and a
leftover instance is cleared before starting - matched on the FULL argv, not one of
our own children, and orphaned (PPid 1). Three traps came out of the AI review rather
than out of writing it: piping stderr by default is itself a way to hang a service if
nothing drains it; the last line a service writes usually has no newline and was
being dropped; and "kill whatever runs this command line" is a much broader promise
than "clear my own leftovers".

**Technique worth reusing:** `drm-engine-render` on the compositor's `renderD128` fd
needs no root and separates a compositing stall from the panel re-locking its mode -
climbing means frames are being composited, flat while mpv reports no drops means the
TV, and nothing in the box can help.

## 1.24.6

### hu

- **A wifi rádió kikapcsolható** (Beállítások → WiFi). Ha a box kábelen van, ezzel a
  távirányító érezhetően fürgébb lesz: a wifi és a Bluetooth ugyanazt az antennát
  használja, és a rádió némán is elvesz belőle. Kábel nélkül a box nem engedi
  kikapcsolni, hogy ne kerüljön le a hálózatról.

### en

- **The wifi radio can be turned off** (Settings → WiFi). On a box that runs on
  ethernet this makes the remote noticeably quicker: wifi and Bluetooth share one
  antenna, and the radio takes airtime even when idle. Without a cable the box
  refuses to turn it off, so it cannot take itself off the network.

### notes

Not release notes for the TV - for whoever runs the boxes:

`wifiradio.js` already dipped the radio for BLE pairing; this makes it a lasting
choice. Stored as `wifi.radio`, applied with nmcli, and re-applied at startup so a
radio something else brought back ends where the owner put it. The status route
answers from nmcli rather than from the config, so the switch shows what the box
IS.

**The precondition is hard**: no wired carrier, no turning it off - the route
answers `no-ethernet` and the startup path skips itself. A box that lost its
ethernet and then obeyed a stored "off" would leave the LAN with nothing able to
undo it.

Confirmed on tvbox-livingroom: with the radio off the BT remote is quick again,
which closes the "~20 s reconnect" behaviour that box had and the gaming box never
did. That difference is now explained: it was airtime, not configuration.

Two review findings worth keeping. The route read `data.on === true`, so any
malformed body - a missing field, the STRING "false", a JSON `null` body - asked for
the radio to be turned OFF, the one direction that can strand a box; it needs a real
boolean now. And the new strings first went in as flat `"wifi.radioTurnOn"` keys,
which the screen showed verbatim **with every check green**: the parity test
flattens nesting into dotted paths, so a flat key is indistinguishable from a nested
one. There is a third locale check now - no key name may contain a dot.

## 1.24.5

### hu

- **A HDR filmek végre HDR-ben szólnak.** Ha a tévé tudja és a film is HDR, a box
  átkapcsolja a tévét HDR módba a lejátszás idejére, utána visszaáll. A kép nem
  lapos többé, és a 4K ugyanolyan sima marad, mint eddig.

### en

- **HDR films finally play in HDR.** When the TV can do it and the film is HDR,
  the box switches the set into HDR mode for the film and back afterwards. No more
  flat picture, and 4K stays as smooth as it was.

### notes

Not release notes for the TV - for whoever runs the boxes:

The output's colour space is claimed for the film and released after it, because
it covers the WHOLE output and the compositor's renderer cannot convert anything
into it. Neither "always on" nor "always off" works: an SDR film on a PQ output
and a PQ film on an SDR output both fail wlroots' scan-out check, and 4K falls
back to compositing (~17 dropped frames a second).

Three more patches in `scripts/patches/` carry it. `wlroots-0008` reports the
output colour transform, which is what a compositor checks before it will drive an
HDR output - and deliberately NOT the input one, which advertises
`wp_color_manager_v1` and made the Chromium UI render wider than anything converts
back (a visibly washed out Home screen). `wlroots-0009` stops direct scan-out from
comparing colour spaces, because without that protocol every buffer claims sRGB -
including a PQ film. `labwc-0002` applies `<hdr>` on reconfigure: SIGHUP alone
re-reads the config and never touches the connector, so nothing outside the
compositor could drive the colour space at all.

`shell/hdr.js` decides it: the panel's capability from the EDID once at startup,
the content's from mpv's `video-params/gamma`, and only for PQ that also takes the
zero-copy path - below that mpv tone-maps the frame itself and a PQ output would
map it twice. `video-params/gamma` has the same late-property race as
`hwdec-current`, which is why the settle loop now carries it and waits for it.

Measured on tvbox-livingroom with a 4K DV/HDR remux: connector `Default` at rest,
`BT2020_RGB` with the film's P030 buffer on the primary plane during playback, 0
dropped frames, and `Default` again after. Boxes that never ran provision keep
compositing as before - the patches need the root build.

Unrelated but worth knowing: Plex's "random" 1080p transcodes were the server
classifying the box as remote when it connected through the public address.
CLAUDE.md carries the diagnosis and the one server setting that fixes it.

## 1.24.4

### hu

- Ezen a kiadáson nincs látható változás. A tévé képkezelését javító foltok
  frissültek, úgy, ahogy azt a fejlesztőik kérték.

### en

- Nothing changes on screen in this one. The patches behind the box's display
  handling were updated, in the shape their upstream projects asked for.

### notes

Not release notes for the TV - for whoever runs the boxes:

Two compositor patches changed shape. Neither alters how a box that already
runs 1.24.3 behaves; both were rebuilt and measured on `tvbox-livingroom`.

**The labwc render-format fix went in the reviewer's shape.**
[labwc#3685](https://github.com/labwc/labwc/pull/3685) now clears the pending
state's `WLR_OUTPUT_STATE_RENDER_FORMAT` bit instead of re-setting the format
that was working before the probe. A `wlr_output_state` is a diff, so clearing
the bit says "do not change the format at all" rather than asserting a value -
and it is the safer of the two: re-setting re-arms the bit, so
`output_basic_test()` runs `output_pick_format()` again and can fail the whole
commit on an output whose applied format is no longer pickable. The debug line
the review asked for is gated on the existing `silent` flag, because
`output_state_setup_hdr()` runs twice per output on a config apply and the
second pass is deliberately quiet.

**The wlroots P030 patch is one line now.** `wlroots-0001` adds
`DRM_FORMAT_P030` to the existing opaque allowlist and nothing else. emersion
rejected the inverted invariant on
[issue 4112](https://gitlab.freedesktop.org/wlroots/wlroots/-/issues/4112):
"YCbCr formats are opaque unless they are one of the six that carry alpha"
would silently strip the alpha of a YUV format the kernel adds later, and
`is_opaque` is only an optimisation, so an unknown format has to read as
translucent. The general fix upstream is !5271, which widens the opaque list
from 4 YCbCr formats to about 20 - but its generated table currently carries
neither P030 nor P010, so the patch stays. `docs/upstream-wlroots.md` records
the one check to run before dropping it.

Measured with a 4K HEVC film and the Plex UI over it: three planes in use (the
film as P030 on the primary, the UI on an overlay, the cursor on its own),
labwc GPU time 0 ns over 15 s of playback, 0 dropped and 0 delayed frames, and
no format errors in the session log.

**A flashed SD card had no Electron at all, and the OTA path had the same
hole.** electron 43 dropped its `postinstall` hook - the binary download moved
to its own `install-electron` bin - so `npm ci` / `npm install` leaves
`node_modules/electron` without a `dist/` and the box has nothing to run. All
three install paths (the image build, `deploy.sh`, and the updater's `npm ci`
branch, which would otherwise stage a release that boots into nothing and rolls
back) now run `node node_modules/electron/install.js` themselves; it exits 0
when the binary is already there.

The image smoke test is what caught it, and it had two faults of its own: it
looked for `run-shell.sh` under `shell/`, where infra files have never been
installed, and its free-space floor was unreachable - pi-gen sizes the rootfs as
used + (0.2 \* used + 200 MB), so 600 MB free cannot happen at this image size.
Both the checks and the failures arrived in 1.22.0, so the number had never once
been met. Nothing here changes a box that is already running.

## 1.24.3

### hu

- Film után a tévé újra a rendes képfrissítésre vált vissza. Eddig előfordult,
  hogy a film 24 Hz-es módján ragadt, és onnantól minden lassúnak tűnt rajta - a
  menü és a játékok is.

### en

- After a film the TV goes back to its normal refresh rate again. It could get
  stuck on the film's 24 Hz mode, and from then on everything on the box felt
  slow - menus and games included.

### notes

Not release notes for the TV - for whoever runs the boxes:

Reported as "even the NES emulator is slow". The output was on
3840x2160@23.976 long after playback had stopped, and the shell knew it should
not be: `claimedBy: null`, `desired 1920x1080@60`.

Two separate defects, both fixed here.

**The compositor refused the mode change.** Reproduced deterministically, 5/5:
4K -> 1080p fails with `WLR_DRM_FORCE_LIBLIFTOFF=1`, succeeds without it, and
succeeds on the distro labwc. The cause is upstream wlroots, not our patches:
wlroots attaches an empty buffer for a modeset and the liftoff interface then
refuses the whole commit if libliftoff gave the cursor layer no plane. Right for
an ordinary frame, wrong for a modeset - the allocation describes a configuration
that is about to change, over a buffer holding nothing. `wlroots-0007` skips that
check on a modeset; our own primary-plane check gets the same treatment.

**And nothing tried again.** `displaymode`'s apply callback re-settles when the
target moved under it and otherwise reports and stops - including when the apply
failed. A settle only starts on a claim, a release or a hotplug, so one failure
left the output wherever the last claim put it. The `MAX_TRIES` machinery beside
it is for an apply that reports success and does not stick, and is checked at the
START of a settle, so it never saw this. A failed apply now re-settles, bounded by
the same per-target budget and rate limit.

Measured after both: 4K playback on three DRM planes with 0 dropped frames, the
film ends, the mode returns to 1920x1080@60, and 5 of 5 manual 4K->1080p
transitions succeed.

## 1.24.2

### hu

- Nincs látható változás: egy frissítés mostantól eltakarítja a korábbi verzió
  már nem használt belső foltjait, amelyek különben megakadályozhatták a
  képjavítás telepítését.

### en

- Nothing visible changes: an update now clears out internal patches an earlier
  version no longer uses, which could otherwise block the picture fix from
  installing.

### notes

Not release notes for the TV - for whoever runs the boxes:

Renaming the labwc patch in 1.24.1 left the old one in `~/.tvbox/`. Every other
infra file keeps its name for life, so nothing ever had to retire one - but the
compositor patches carry their subject in their filenames, and
`install-labwc-planes.sh` applies whatever `*.patch` it finds beside itself. Both
copies add the same render-format restore, so the second refused to apply, the
installer refused to install a half-patched build, and provision logged a warning
nobody was reading. The box kept the compositor it already had, and the only
visible sign was a stamp that never changed.

Both channels that copy infra now drop `*.patch` files the shipped set does not
name: `deploy.sh` after its rsync, `updater.js` after `syncInfra`. The image
builds a fresh rootfs, so it was never affected.

One operational trap recorded with it: `systemctl restart greetd` on a live
session can lose to itself - the previous compositor still holds
`/dev/dri/card1`, each attempt exits immediately, and systemd's start limit trips
after five, leaving greetd `failed` with no session at all. Stop greetd, kill the
leftovers, wait, then start it once.

## 1.24.1

### hu

- Nincs látható változás: a 4K-s képjavítás egyik belső foltja lecserélődött egy
  kisebbre, miután a labwc fejlesztői átnézték.

### en

- Nothing visible changes: one of the internal patches behind the 4K fix was
  replaced with a smaller one after the labwc developers reviewed it.

### notes

Not release notes for the TV - for whoever runs the boxes:

The labwc patch shipped in 1.24.0 did two things; it now does one.
[labwc#3685](https://github.com/labwc/labwc/pull/3685) asked what sway does
differently, since sway carries no equivalent of the `layer_states` array the
patch added - and the answer is that sway builds a fresh `wlr_output_state` per
frame and probes render formats on a separate config state, while labwc reuses one
long-lived `output->pending` for both. In labwc a state can therefore still carry
`WLR_OUTPUT_STATE_LAYERS` when a probe re-tests it later.

Chasing that down showed the layer half was compensating for an earlier iteration
of `wlroots-0004`, which kept its output layer alive between offload episodes
where it now destroys it. Rebuilt without it and measured on `tvbox-livingroom`:
the offload still engages (three DRM planes in use), no `All output layers must be
specified`, no failed commits, 0 dropped and 0 delayed frames at 2160p23.976, and
the compositor still at 0% GPU.

What ships is the half that is a bug with or without layers: a failed
render-format probe used to leave the format at the last candidate it tried, after
which no swapchain could be created for that output at all.

## 1.24.0

### hu

- A 4K filmek végre folyamatosak (a teljes képernyős lejátszás; a 4K AV1 kivétel, ahhoz nincs dekóder a boxban). Eddig a box a képkockák háromnegyedét eldobta 4K-ban - diavetítésnek látszott -, mert a videót és a fölötte lévő kezelőfelületet egyszerre kellett kirajzolnia, és a kettő nem fért bele. Mostantól a 4K képet közvetlenül adja tovább a képernyőnek, így akkor is sima marad, ha közben a menü vagy a lejátszósáv látszik.
- A menü a film fölött sem szakítja meg a lejátszást: a képet és a fölötte lévő kezelőfelületet mostantól maga a tévé-kimenet teszi össze, nem a box rajzolja újra mindkettőt. Frissen telepített vagy újraprovisionált boxon jár, a régieken a következő provisionig marad a mostani működés.
- Ennek egy ára van: a nagy felbontású (1440p-től felfelé) HDR filmeknél a színeket ezután nem a box igazítja a tévéhez, hanem úgy mennek ki, ahogy a filmben vannak - sötét jeleneteken világosabbnak, kontrasztosabbnak kevésbé látszhatnak. A Full HD filmeket ez nem érinti.

### en

- 4K films finally play smoothly - fullscreen playback, with 4K AV1 the exception, since the box has no decoder for it. It used to drop three frames in four at 4K - it looked like a slideshow - because it had to draw both the video and the UI sitting over it, and the two did not fit. It now hands the 4K picture straight to the screen, so it stays smooth even while a menu or the playback bar is up.
- Opening a menu over a film no longer costs the playback anything: the TV output itself now puts the picture and the UI over it together, instead of the box redrawing both. Freshly flashed or re-provisioned boxes get this; existing ones keep working as they do now until their next provision.
- One thing changes with it: on high-resolution HDR films (1440p and up) the box no longer adapts the colours to your TV, so they go out as the film has them - dark scenes can look lighter and less contrasty. Full HD films are unaffected.

### notes

Not release notes for the TV - for whoever runs the boxes:

- Measured on `tvbox-livingroom` (2160p HEVC, 29 Mbps, DV/PQ, direct play):
  **17 dropped frames a second before, 0 in ten minutes after**, mpv at 7% of a
  core instead of 12-20%. The decoder was never the problem - it dropped nothing
  in either case.
- The renderer is chosen per stream in `shell/videoout.js`: the zero-copy output
  (`dmabuf-wayland`) only for fullscreen, hardware-decoded video of 1440p or
  more (`ZERO_COPY_MIN_HEIGHT`) - so a 1440p HDR file loses tone mapping too,
  not only 4K.
  Everything else keeps `--vo=gpu` and its tone mapping, because that output
  shows **nothing** for a software-decoded stream and does not exist under
  XWayland, where PiP runs.
- **4K AV1 is still not smooth** and this cannot help it: the Pi 5 has no AV1
  decoder, so those frames come from the CPU and the GPU renderer is the only
  one that can take them.
- If the HDR colour change is not wanted, the trade is one gate away - excluding
  `gamma: "pq"` from `zeroCopyVideo` returns those films to tone mapping, and to
  the frame drops. The lasting fix is HDR passthrough (let the panel tone-map,
  as a Fire TV does), which needs a compositor with colour management; labwc
  0.9.8 / wlroots 0.19.1 advertises none.

**The compositor's own 4K pass is gone too** - the second half of the same
problem. Removing ours left the video smooth only while nothing sat over it; a
fullscreen translucent UI still sent the whole output through the renderer, at
67% of the V3D. `scripts/install-labwc-planes.sh` builds labwc 0.20.0 + wlroots
0.20.2 with seven patches (`scripts/patches/`) that let the display hardware
compose instead: the film lands on the vc4 primary plane, the UI on an overlay,
and the compositor's GPU time drops to **0%**. Measured with the Plex UI open
over a 2160p23.976 film: 0 dropped and 0 delayed frames.

Four things to know about it:

- **It only reaches provisioned boxes.** The build needs apt and root, which OTA
  has neither of, so an OTA-only box keeps the distro labwc and composites as
  before. Same caveat as libcec and the diagnostics units.
- **greetd now starts `tvbox-compositor`, not labwc.** That wrapper prefers the
  patched build and falls back to the distro one for the rest of the boot if it
  fails to come up, because a from-source compositor that will not start is a TV
  that shows nothing. A quick failure earns one retry first - a session restart can
  leave the previous compositor holding the DRM device for a second or two - and
  the marker lives in the user's runtime dir, a tmpfs, so the next boot tries again.
- **`WLR_DRM_FORCE_LIBLIFTOFF=1` is required and set by the wrapper.** wlroots
  only touches planes through libliftoff, and keeps it behind that variable.
- **Two of the seven are plain wlroots bugs worth upstreaming**, not tvbox
  quirks. The liftoff interface never set the colour-management connector
  properties, and the guard that noticed rejected every commit carrying an image
  description - which labwc attaches to all of them, so enabling libliftoff on any
  wlroots compositor breaks presentation outright. And wlroots decides whether a
  buffer is opaque from an allowlist that names four of the 58 YCbCr formats it
  knows: P030 was missing while P010 and NV12 were on it, so 10-bit video was
  treated as possibly-translucent - which cost occlusion culling and direct
  scan-out for every such buffer, on every compositor.

## 1.23.0

### hu

- Ha egy második boxot az elsőről állítasz be, az új box mostantól a sajátjaként lép be a médiaappokba. Eddig az első box bejelentkezését és azonosítóját is átvitte a mentés, amitől a kettő egyetlen lejátszónak látszott: a Plex csak az egyiket mutatta, a telefonról indított lejátszás hol az egyikre, hol a másikra ment, és a szobát nem lehetett megválasztani. A beállításaid (nyelv, alkalmazások sorrendje) továbbra is átjönnek - az új boxon csak egyszer be kell lépned az appokba.
- Egy visszaállítás után nem éled újra egy korábbi visszaállítás félbemaradt beállításcsomagja.

### en

- Setting up a second box from the first one now lets the new box sign in to your media apps as itself. The backup used to carry the first box's login and identity across, which made the two look like a single player: Plex only ever showed one of them, casting from a phone landed on whichever it felt like, and you could not pick the room. Your settings (language, app order) still travel - you just sign in once on the new box.
- A restore no longer leaves an earlier restore's half-applied settings behind to be picked up later.

### notes

Not release notes for the TV - for whoever runs the boxes:

- **This prevents new collisions; it does not repair existing ones.** Two boxes
  that already share a media-app identity keep sharing it until one of them is
  cleared by hand: stop the shell (`pkill -9 -f 'electron[/]dist'`) and remove
  `~/.tvbox/shell-userdata/Local Storage` in the SAME command - the respawn loop
  is fast enough that a slower sequence deletes the store out from under a
  process that already holds it in memory and writes it back on exit. That box
  then has to sign in to its apps again.
- The filter is gated on the **"for another box"** choice on the phone backup
  page, the same flag that re-derives the MQTT and Spotify names. A clone
  restored without ticking it is not caught: a re-flash and a clone both arrive
  with a fresh machine id, so the box cannot tell them apart, and treating a
  re-flash as foreign would be the worse mistake.
- Also in this release: `shell/integration.test.js`, whole-scenario tests through
  the real modules instead of mutually-agreeing fakes (#34). The backup fix above
  has a two-box scenario there.

## 1.22.0

### hu

- Visszaállítás után a box magától visszahozza az alkalmazásaidat is. Eddig a beállítások megjöttek, de az appok - a hozzájuk tartozó programok, letöltések, csomagok - nem, és egy üres kezdőképernyő fogadott: most a box a mentésből tudja, mi volt rajta, és a bekapcsolás után sorra letölti őket, közben pedig a képernyő alján látod, hol tart. Ha közben elindítasz valamit, félbehagyja és később folytatja.
- Az appok saját fájljai is utaznak a mentéssel: a retro játékok listái és mentései például már nem maradnak a régi boxon.
- Egy második boxot mostantól az elsőről tudsz beállítani. A telefonos mentés oldalán megadhatod, hogy a fájl "másik boxhoz" készül - akkor a beállítások átkerülnek, de a box eszközazonosítói (Home Assistant, Spotify-név) újra képződnek, hogy a két box ne akadjon egymásba. Visszaállításkor nevet is adhatsz az új boxnak.
- A box mostantól rendes médialejátszóként jelenik meg a Home Assistantban: állapot, cím és borító, lejátszás/megállítás, hangerő, és onnan indíthatod az appokat is. A Home Assistant magától felajánlja, amint a box felkerül az MQTT-brókerre.

### en

- After a restore the box brings your apps back by itself. The settings used to come back but the apps behind them - their programs, downloads and packages - did not, and you were left on an empty home screen: the box now knows from the backup what it had, downloads it after the restart, and shows the progress at the bottom of the screen. Start something in the meantime and it stands down, then carries on later.
- An app's own files travel with the backup too, so a retro library's game lists and save files no longer stay behind on the old box.
- A second box can be set up from the first one. On the phone backup page you can say the file is "for another box": the settings travel, but the box's device identifiers (Home Assistant, Spotify name) are re-derived so the two never collide. You can name the new box while restoring it.
- The box now appears in Home Assistant as a proper media player: state, title and artwork, play/pause, volume, and you can launch its apps from there. Home Assistant offers it automatically once the box is on your MQTT broker.

### notes

Not release notes for the TV - for whoever runs the boxes:

- **The Home Assistant media player needs a one-time install.** Copy
  `homeassistant/custom_components/tvbox/` into your Home Assistant config dir and
  restart it. Home Assistant's MQTT integration cannot create a `media_player`
  entity from a discovery payload (there is no such platform), so this is a small
  local integration over the same broker connection - no polling, no credentials of
  its own. See docs/homeassistant-integration.md.
- **The MQTT device id now defaults to the hostname, not the literal `tvbox`.** That
  is the fix for two boxes sharing one topic tree, but a box that configured MQTT by
  hand and never set a `deviceId` changes topics on this update: its old
  auto-discovered "Now playing" sensor stays behind in Home Assistant as
  unavailable. Delete the stale retained discovery message to clear it
  (`mosquitto_pub -t 'homeassistant/sensor/tvbox_tvbox/nowplaying/config' -r -n`),
  or pin the old value with `"deviceId": "tvbox"` in `~/.tvbox/config.json`.
- The SD image is now smoke-tested in CI before it is uploaded (geometry, payload,
  and a real boot of its userspace under nspawn). See docs/sd-image.md for what a
  pass does and does not prove.

## 1.21.3

### hu

- A box naplója nem őrzi meg a lejátszott cím webcímét. Egy IPTV-cím a felhasználónevet és a jelszót magában a címben hordozza, és a naplóból hibakeresésnél a memóriakártyára is átkerülhet; mostantól csak az szerepel benne, honnan indult a lejátszás.

### en

- The box's log no longer keeps the web address of what it played. An IPTV address carries the username and password inside the address itself, and the log can be copied to the memory card for troubleshooting; it now records only where playback came from.

## 1.21.2

### hu

- Ha a box nem éri el a boltot, most ezt mondja, nem azt, hogy az alkalmazás nem létezik. Eddig egy megszakadt hálózat és egy tényleg hiányzó app ugyanúgy nézett ki.

### en

- When the box cannot reach the store it says so, instead of reporting that the app does not exist. A dropped network and a genuinely missing app used to look the same.

## 1.21.1

### hu

- Javítva: ha egy alkalmazás frissítése épp akkor jelent meg, a telepítés hibás letöltésre panaszkodott és nem ment végig. A box a frissítés pillanatában rákérdez a bolt aktuális tartalmára, és ha egy fájlt a gyorsítótár még régi formájában adna vissza, még egyszer elkéri.

### en

- Fixed: installing an app update that had only just been published could fail as if the download were corrupt. The box now asks the store what it holds at the moment of the install, and a file the cache would still answer with an old copy of is fetched once more.

## 1.21.0

### hu

- A Plexben a szüneteltetés nem szakítja meg többé a filmet. Eddig nagyjából két perc állás után "Playback error" üzenettel kilépett, mert a box tévesen azt jelentette a Plexnek, hogy még tölt.
- A Plex a saját döntéseit kapja vissza: az általa választott hangsáv szól, és ha nála ki van kapcsolva a felirat, akkor kikapcsolva is marad. Eddig a box a fájlban alapértelmezettnek jelölt feliratot kapcsolta be helyette, és a hangsávot is maga választotta. A lejátszás közbeni átállítás (felirat, hangsáv, késleltetés, sebesség) szintén működik már.
- Ha egy távirányító párosítása nem sikerül, a Beállítások > Bluetooth alatt megjelenik egy "Párosítás wifi nélkül" gomb. A wifi és a Bluetooth ugyanazon az antennán osztozik, és épp a párosítás az, ami emiatt elhasal; a box egy percre lelép a hálózatról, aztán magától visszatér. A wifit csak akkor kapcsolja vissza, ha előtte be volt kapcsolva.

### en

- Pausing a film in Plex no longer ends it. It used to stop with a "Playback error" about two minutes into a pause, because the box was telling Plex it was still loading.
- Plex's own choices are honoured: the audio track it picked is the one you hear, and subtitles stay off when they are off in Plex. The box used to switch on whatever subtitle the file marked as default and pick the audio track itself. Changing any of it mid-film (subtitles, audio track, delay, speed) works now too.
- When pairing a remote fails, Settings > Bluetooth offers "Pair without Wi-Fi". Wi-Fi and Bluetooth share one antenna on this box and pairing is what loses; the box leaves the network for up to a minute, then rejoins on its own. It only turns Wi-Fi back on if it was on to begin with.

## 1.20.0

### hu

- A retro játékok mostantól a box saját felületén vannak, borítókkal. Konzolonként végig tudod nézni őket, az OK pedig egyenesen elindítja a játékot - nem kell többé az emulátor saját menüjén átvergődni. Ha kilépsz a játékból, oda kerülsz vissza, ahol voltál: a játékok listájába.
- Hosszú listákhoz jobb oldalon ott az ábécé: A-tól Z-ig ugorhatsz benne, és halványan látszik, melyik betűhöz nincs játékod. Kereső is van, a box saját képernyő-billentyűzetével.
- Kontrolleren az Xbox gomb játék közben előhozza az emulátor menüjét - mentett állások, játék bezárása, beállítások -, és a játék addig meg is áll. Ez eddig egyes kontrollereken egyszerűen nem működött; a box most magától kideríti, melyik gomb az az adott kontrolleren.
- A konzolokat (emulátorokat) és a borítókat mostantól a tévén is kezelheted, nem csak telefonról.
- A játékok appja magától frissül a boxon, néhány perccel a bekapcsolás után - neked nem kell tenned semmit.

### en

- Your retro games now live in the box's own screen, with covers. Browse them console by console and press OK to start a game straight away - no emulator menu to get through first. When you leave a game you land back where you were: in the list of games.
- For a long list there is an A-Z index down the right: jump to any letter, and the letters you have no games for are dimmed. There is a search too, with the box's own on-screen keyboard.
- On a controller, the Xbox button brings up the emulator's menu mid-game - save states, closing the game, its settings - and the game pauses while it is up. On some controllers this simply did nothing before; the box now works out which button it is on the controller you have.
- Consoles (emulators) and covers can be managed on the TV now, not only from your phone.
- The games app updates itself on the box a few minutes after it starts up - nothing for you to do.

## 1.19.0

### hu

- A box mostantól megmondja, mi a baja akkor is, ha egyáltalán nem indul el. Eddig ha a képernyő fekete maradt és a hálózaton sem válaszolt, semmilyen módon nem lehetett megkérdezni tőle, mi történt. Most minden bekapcsoláskor kiír egy `tvbox-diag.txt` nevű szöveges fájlt a memóriakártyára, oda, ahol a beállításfájl is van: elég kivenni a kártyát és bármelyik gépen megnyitni. A fájl elején az áll, mit talált gyanúsnak, és utána a részletek, a szabad hely, a hálózat és a hőmérséklet.
- Új biztonsági mód arra az esetre, ha a box nem jut el a főképernyőig. Ilyenkor hálózattal és távoli eléréssel indul el, de a TV-műsor helyett magát a hibajelentést mutatja a tévén, benne a box IP-címével és azzal, mit tehetsz. Kérheted te is: hozz létre egy `tvbox-safe-mode` nevű üres fájlt a kártyán, vagy írd bele a beállításfájlba, hogy `SAFE_MODE=true`. Ha háromszor egymás után nem sikerül elindulnia, magától belép, egyetlen bekapcsolás erejéig, tehát nem tud beragadni.
- Javítva egy hiba, ami miatt egy box a saját indítási beállításai nélkül kapcsolt be, és ezt semmi nem jelezte. A rendszer minden bekapcsolásnál újraírt egy fájlt a memóriakártyán, és ha eközben elment az áram, a fájl kiürült. Ez most már nem tud így elveszni, és ha egy boxon már megtörtént, a következő telepítés helyreállítja.
- Az új dolgok frissen telepített vagy újratelepített boxokon lépnek életbe: a jelentést és a biztonsági módot a rendszer olyan részei végzik, amiket egy szokásos szoftverfrissítés nem tud lecserélni. Ha a boxod már megy, ebben a verzióban nem fog máshogy működni.

### en

- The box can now tell you what is wrong even when it does not start at all. Until now, if the screen stayed black and it answered nothing over the network, there was no way left to ask it anything. It now writes a text file called `tvbox-diag.txt` onto the memory card at every start, next to the settings file: take the card out and open it on any computer. The top of the file says what looked wrong, and the rest has the detail, the free space, the network and the temperature.
- A new safe mode for a box that cannot reach the home screen. It comes up with networking and remote access, but instead of your TV screen it shows the report itself on the TV, including the box's address and what you can do. You can ask for it yourself: create an empty file named `tvbox-safe-mode` on the card, or put `SAFE_MODE=true` in the settings file. After three starts in a row that fail, it enters safe mode on its own for a single start, so it cannot get stuck there.
- Fixed a fault that left a box starting up without its own boot settings, with nothing to show it had happened. The system was rewriting a file on the memory card at every start, and a power cut during that emptied the file. It can no longer be lost that way, and on a box where it already happened the next install restores it.
- The new parts take effect on freshly installed or reinstalled boxes: the report and safe mode are done by parts of the system a normal software update cannot replace. If your box is already working, nothing about it changes in this version.

## 1.18.1

### hu

- Beállítások visszatöltése után egy alkalmazás eltűnhetett a főképernyőről - a Plex volt ilyen -, és az Alkalmazások alatt már telepítettnek látszott, úgyhogy előbb el kellett távolítani, majd újra telepíteni. A box ezt most magától rendbe teszi: bekapcsolás után pár percen belül letölti, ami hiányzik, és az alkalmazás megjelenik. Neked nem kell tenned semmit.
- Frissen telepített boxokon a tárhely eddig nem nyúlt ki a memóriakártya teljes méretére, hanem alig pár száz megabájton maradt, és emiatt az első bekapcsolás után furcsa hibák jöhettek: néma fekete képernyő, vagy egy box, ami el sem indult rendesen. Ez javítva - az új telepítések a kártya egészét használják. Meglévő boxokat nem érint.

### en

- After restoring your settings, an app could vanish from the home screen - Plex did - while Apps still listed it as installed, so the only way back was to remove it and install it again. The box now sorts this out on its own: within a few minutes of starting up it fetches what was missing and the app reappears. Nothing for you to do.
- On newly installed boxes the storage was not being expanded to the full size of the memory card, leaving only a few hundred megabytes, and that could cause odd trouble after the first start: a silent black screen, or a box that never came up properly. Fixed - new installs now use the whole card. Existing boxes are unaffected.

## 1.18.0

### hu

- Sokkal gyorsabb és stabilabb wifi. A box eddig energiatakarékos módban járatta a wifit, ami egy hálózatról működő készüléknek semmit nem ad, viszont erősen visszafogta: mérve több mint tízszeresére gyorsult az adatátvitel, és a kapcsolat sokkal ritkábban akad meg. A távirányító és a kontrollerek is jól járnak vele, mert a wifi és a Bluetooth ugyanazt az antennát használja - amit a wifi nem foglal, azon a gombnyomások pontosabban érnek célba.
- A Wi-Fi ország beállítás mostantól tényleg érvényre jut. Ha a boxot más országban használod, mint amire készült, a Beállítások → Wi-Fi alatt átállíthatod: eddig megjegyezte a választást, de a rádióhoz nem jutott el, és így hálózatok maradhattak láthatatlanok.
- Új, alapból kikapcsolt lehetőség a Beállítások → Perifériák alatt azokhoz a kontrollerekhez, amelyeknél beragadnak vagy duplán érkeznek a gombnyomások. A beállítás alatti leírás elmondja, mikor érdemes bekapcsolni - és hogy minden Bluetooth-eszközre hatással van, ezért nem alapból aktív.

### en

- Much faster, steadier Wi-Fi. The box had been running its Wi-Fi in a power-saving mode that gains a mains-powered device nothing while holding it back badly: measured, data now moves more than ten times faster and the connection stalls far less often. The remote and the game controllers gain too, because Wi-Fi and Bluetooth share one aerial - whatever Wi-Fi is not occupying, your button presses get.
- The Wi-Fi country setting now really takes effect. If you use the box in a different country than it was built for, you can correct it under Settings → Wi-Fi: until now it remembered your choice but never passed it on to the radio, which could leave networks invisible.
- A new option, off by default, under Settings → Peripherals, for controllers whose buttons stick or register twice. The text under it says when to turn it on - and that it affects every Bluetooth device, which is why it is not on to begin with.

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
