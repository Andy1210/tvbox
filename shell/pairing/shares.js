// Pairing provider: add a network share from the phone.
//
// This is the one form on the box where every field is a string somebody else
// chose - a server address, a share name, a password - and an on-screen keyboard
// makes short work of nobody's evening. The phone has a real keyboard, and it can
// paste.
//
// The page does the same two-step the TV does: ask the server what it offers, then
// pick a share (and optionally a folder inside it) from what came back. Typing
// only happens for the address and the credentials.
//
// The pairing core supplies the code gate and the QR; the validation and the
// mounting live in ../shares.js, so the TV form and this one cannot disagree.
const config = require("../config");
const shares = require("../shares");

let applyHook = () => ({ ok: true });
let depsHook = () => ({});

// main.js owns the supervisor and the "mount what is configured" pass; this only
// asks for them.
function init({ apply, deps }) {
  if (apply) applyHook = apply;
  if (deps) depsHook = deps;
}

const STR = {
  hu: {
    title: "tvbox - Hálózati megosztás",
    hint: "Add meg a szerver címét, és a box megkérdezi, milyen megosztásokat kínál. A jelszó a boxon marad.",
    host: "Szerver címe (pl. 192.168.1.10 vagy nas.local)",
    user: "Felhasználó (üresen: vendég)",
    pass: "Jelszó",
    lookup: "Megosztások lekérdezése",
    looking: "Kérdezem…",
    pickShare: "Válassz megosztást",
    pickFolder: "Mappa a megosztáson belül (nem kötelező)",
    folderRoot: "A teljes megosztás",
    up: "Vissza egy szintet",
    name: "Név a TV-n",
    nameHint: "Ezen a néven jelenik meg a Fájlok appban.",
    cacheLabel: "Mi van rajta",
    cacheMedia: "Filmek, zene",
    cacheGames: "Játékok",
    cacheHint:
      "A filmek menet közben töltődnek. Egy játékot a box első megnyitáskor átmásol magához, mert egy lemezképben az emulátor folyamatosan ugrál - hálózatról az akadozna.",
    save: "Mentés",
    saving: "Mentés…",
    saved: "Kész - a TV-n megjelenik a megosztás.",
    existing: "Már beállítva",
    failed: "Nem sikerült",
  },
  en: {
    title: "tvbox - Network share",
    hint: "Enter the server's address and the box will ask it what it offers. The password stays on the box.",
    host: "Server address (e.g. 192.168.1.10 or nas.local)",
    user: "User (empty: guest)",
    pass: "Password",
    lookup: "Look up shares",
    looking: "Asking…",
    pickShare: "Pick a share",
    pickFolder: "Folder inside the share (optional)",
    folderRoot: "The whole share",
    up: "Up one level",
    name: "Name on the TV",
    nameHint: "This is what it is called in the Files app.",
    cacheLabel: "What is on it",
    cacheMedia: "Films, music",
    cacheGames: "Games",
    cacheHint:
      "Films play as they arrive. A game is copied to the box the first time it is opened, because an emulator seeks around a disc image constantly - over the network that stutters.",
    save: "Save",
    saving: "Saving…",
    saved: "Done - it shows up on the TV.",
    existing: "Already set up",
    failed: "That didn't work",
  },
};

module.exports = {
  init,
  page: (ctx) => ctx.render("shares.html", { lang: ctx.locale, ...(STR[ctx.locale] || STR.en) }),
  routes: {
    // What is already there, so the phone can say "you have this one" instead of
    // letting someone add it twice under another name. Never a password.
    "GET /share-list": (req, res, ctx) =>
      ctx.json(res, {
        shares: config.rawShares().map((s) => ({ name: s.name, host: s.host, share: s.share, path: s.path || "" })),
      }),
    // With no `share` this asks the server what it offers; with one, what is
    // inside it. Same two answers the TV form gets, from the same code.
    "POST /share-test": (req, res, ctx) => {
      const body = ctx.body || {};
      if (!body.share) return shares.listShares(body, depsHook(), (r) => ctx.json(res, r));
      let share;
      try {
        share = shares.shareFrom(body);
      } catch (e) {
        return ctx.json(res, { ok: false, error: e.message || "bad_request" });
      }
      shares.test(share, depsHook(), (r) => ctx.json(res, r));
    },
    "POST /share-save": (req, res, ctx) => {
      let share;
      try {
        share = shares.shareFrom(ctx.body || {});
      } catch (e) {
        return ctx.json(res, { ok: false, error: e.message || "bad_request" });
      }
      const others = config.rawShares().filter((s) => s.name !== share.name);
      if (others.length >= shares.MAX_SHARES) return ctx.json(res, { ok: false, error: "too_many" });
      // Same name = the same share re-entered from the phone, so it replaces
      // rather than piling up: the name IS the mount point.
      config.setShares([...others, share]);
      applyHook();
      ctx.json(res, { ok: true, name: share.name });
      ctx.stopSoon(4000); // the phone is done; take the LAN server back down
    },
  },
};
