// Pairing provider: settings backup/restore from the phone. One QR session
// serves both directions - the phone page has a "save backup" card (set a
// password, download the encrypted .tvbackup file) and a "restore" card (pick
// the file, enter its password, upload). The pairing core supplies the code
// gate; the crypto + file layout live in ../backup.js.
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
    restoreTitle: "Visszaállítás fájlból",
    restoreHint: "Válaszd ki a .tvbackup fájlt és add meg a jelszavát.",
    pickFile: "Fájl kiválasztása",
    restoreBtn: "Visszaállítás",
    working: "Folyamatban…",
    saved: "Mentés letöltve ✓",
    restored: "Visszaállítva ✓ - a TV újraindul, ez a lap bezárható.",
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
    restoreTitle: "Restore from a file",
    restoreHint: "Pick the .tvbackup file and enter its password.",
    pickFile: "Choose file",
    restoreBtn: "Restore",
    working: "Working…",
    saved: "Backup downloaded ✓",
    restored: "Restored ✓ - the TV is restarting, you can close this page.",
    wrongPassword: "Wrong password or corrupted file.",
    passShort: "Password too short.",
    noFile: "Pick a file first.",
    error: "Something went wrong - try again.",
  },
};

let context = null; // { localStorage } from the launcher, per session
let restoredHook = null; // main.js: restart the shell + surface state on the TV

function setContext(data) {
  context = data && typeof data === "object" ? data : null;
}
function onRestored(fn) {
  restoredHook = fn;
}

module.exports = {
  setContext,
  onRestored,
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
      const envelope = backup.encrypt(backup.collect(context), password);
      ctx.json(res, { ok: true, envelope });
    },
    "POST /restore": {
      maxBody: 25e6,
      handler: (req, res, ctx) => {
        let payload;
        try {
          payload = backup.decrypt(ctx.body.envelope, String(ctx.body.password || ""));
        } catch (e) {
          ctx.json(res, { ok: false, error: "password" });
          return;
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
