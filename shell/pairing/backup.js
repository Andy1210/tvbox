// Pairing provider: settings backup/restore from the phone. One QR session
// serves both directions - the phone page has a "save backup" card (set a
// password, download the encrypted .tvbackup file) and a "restore" card (pick
// the file, enter its password, upload). The pairing core supplies the code
// gate; the crypto + file layout live in ../backup.js.
//
// The save card also asks WHO the file is for: this box's own safety copy, or a
// seed for a second box. That choice belongs here, on the source box, because the
// target cannot tell a re-flash from a clone (both have a fresh machine id, and
// before setup the same default hostname) and guessing wrong either renames a
// box's Home Assistant entities or hands two boxes one identity.
//
// The launcher POSTs /tvbox/api/backup/context (its localStorage snapshot)
// right before starting the pairing session - the shell can't read renderer
// storage itself. After a successful restore the shell must restart (plugins
// only read credentials at boot); main.js wires that via onRestored.
const backup = require("../backup");

const STR = {
  hu: {
    title: "tvbox - Mentés és visszaállítás",
    hint: "A mentés egy jelszóval titkosított fájl a telefonodon. Ugyanitt tudod később visszatölteni - akár egy újratelepített boxra is.",
    saveTitle: "Mentés a telefonra",
    saveHint: "Adj meg egy jelszót a fájlhoz (ezt kéri majd a visszaállítás).",
    password: "Jelszó (min. 4 karakter)",
    saveBtn: "Mentés letöltése",
    forTitle: "Mihez lesz ez a fájl?",
    forSelf: "Ehhez a boxhoz (biztonsági mentés)",
    forClone: "Egy másik boxhoz (beállítások átvitele)",
    forCloneHint:
      "Másik boxhoz: a beállítások átkerülnek, de az eszközazonosítók (MQTT, Spotify-név) újra képződnek, hogy a két box ne ütközzön.",
    restoreTitle: "Visszaállítás fájlból",
    restoreHint: "Válaszd ki a .tvbackup fájlt és add meg a jelszavát.",
    pickFile: "Fájl kiválasztása",
    newName: "Ennek a boxnak a neve (nem kötelező)",
    newNameHint: "Ha megadod, a box át is nevezi magát erre - egy második boxnál ez alapján kap saját azonosítót.",
    restoreBtn: "Visszaállítás",
    working: "Folyamatban…",
    saved: "Mentés letöltve ✓",
    restored: "Visszaállítva ✓ - a TV újraindul, majd letölti az alkalmazásokat. Ez a lap bezárható.",
    wrongPassword: "Hibás jelszó vagy sérült fájl.",
    passShort: "Túl rövid jelszó.",
    noFile: "Előbb válassz fájlt.",
    error: "Hiba történt - próbáld újra.",
  },
  en: {
    title: "tvbox - Backup & restore",
    hint: "The backup is a password-encrypted file saved to your phone. Restore it here later - even onto a re-flashed box.",
    saveTitle: "Save to this phone",
    saveHint: "Set a password for the file (restore will ask for it).",
    password: "Password (min. 4 characters)",
    saveBtn: "Download backup",
    forTitle: "What is this file for?",
    forSelf: "This box (a backup)",
    forClone: "Another box (copy the settings over)",
    forCloneHint:
      "For another box: the settings travel, but the device identifiers (MQTT, Spotify name) are re-derived so the two boxes don't collide.",
    restoreTitle: "Restore from a file",
    restoreHint: "Pick the .tvbackup file and enter its password.",
    pickFile: "Choose file",
    newName: "Name for this box (optional)",
    newNameHint: "If set, the box renames itself to this - a second box derives its own identifiers from it.",
    restoreBtn: "Restore",
    working: "Working…",
    saved: "Backup downloaded ✓",
    restored: "Restored ✓ - the TV is restarting, then it downloads your apps. You can close this page.",
    wrongPassword: "Wrong password or corrupted file.",
    passShort: "Password too short.",
    noFile: "Pick a file first.",
    error: "Something went wrong - try again.",
  },
};

let context = null; // { localStorage } from the launcher, per session
let restoredHook = null; // main.js: restart the shell + surface state on the TV
let hostnameHook = null; // main.js: hostnamectl set-hostname (needs the polkit grant it owns)

function setContext(data) {
  context = data && typeof data === "object" ? data : null;
}
function onRestored(fn) {
  restoredHook = fn;
}
// Renaming the box is root-adjacent (hostnamectl + a polkit grant), so it stays in
// main.js; this only asks for it. Best effort: an older image without the grant
// refuses, and a restore must not fail over a name.
function onHostname(fn) {
  hostnameHook = fn;
}

module.exports = {
  setContext,
  onRestored,
  onHostname,
  page: (ctx) =>
    ctx.render("backup.html", { lang: ctx.locale, host: require("os").hostname(), ...(STR[ctx.locale] || STR.en) }),
  routes: {
    // Build + encrypt + hand the file to the phone. POST (not GET) so the
    // password never lands in the browser history / server logs.
    "POST /backup-file": (req, res, ctx) => {
      const password = String(ctx.body.password || "");
      if (password.length < backup.MIN_PASSWORD) {
        ctx.json(res, { ok: false, error: "password" });
        return;
      }
      const envelope = backup.encrypt(backup.collect(context, { clone: ctx.body.clone === true }), password);
      ctx.json(res, { ok: true, envelope });
    },
    "POST /restore": {
      maxBody: 25e6,
      handler: async (req, res, ctx) => {
        let payload;
        try {
          payload = backup.decrypt(ctx.body.envelope, String(ctx.body.password || ""));
        } catch (e) {
          ctx.json(res, { ok: false, error: "password" });
          return;
        }
        // Rename FIRST, then apply: the identity fields of a clone are derived
        // from this box's hostname, so a name given here has to be in place
        // before the config lands - otherwise the new box derives from the name
        // it is about to stop having.
        const newName = String(ctx.body.hostname || "").trim();
        if (newName && hostnameHook) {
          try {
            await hostnameHook(newName);
          } catch (e) {
            console.warn("[backup] rename to", newName, "failed:", e.message);
          }
        }
        try {
          backup.apply(payload);
        } catch (e) {
          console.warn("[backup] restore failed:", e.message);
          ctx.json(res, { ok: false, error: "apply" });
          return;
        }
        ctx.json(res, { ok: true });
        ctx.stopSoon(4000); // pairing server down, then the shell restarts (hook)
        if (restoredHook) restoredHook();
      },
    },
  },
};
