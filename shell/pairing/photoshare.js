// Pairing provider: put photos from the phone on the TV, to look at now.
//
// Its neighbour `photos.js` uploads to the screensaver and keeps what it is given;
// this one fills a session the viewer empties again (photoshare.js). Same phone,
// same QR, two different intentions - so they are two kinds rather than one page
// with a switch on it, and the TV screen the person came from decides which.
//
// The phone downscales before it uploads. 2560 on the long edge is above what the
// viewer renders at, so a modest zoom still has pixels behind it, and it keeps a
// photo around a megabyte - which is what makes sending thirty of them over wifi
// feel immediate.
const photoshare = require("../photoshare");

const STR = {
  hu: {
    title: "tvbox - Képek a TV-re",
    hint: "Válaszd ki a képeket - megjelennek a TV-n, ahogy megérkeznek.",
    pick: "Képek kiválasztása",
    uploading: "Küldés",
    done: "kész - nézd a TV-t.",
    onTv: "A TV-n most",
    photos: "kép",
    clear: "Képek eltávolítása",
    clearConfirm: "Leveszed a képeket a TV-ről?",
    full: "Betelt - előbb vedd le a képeket a TV-ről.",
    failed: "Nem sikerült elküldeni",
  },
  en: {
    title: "tvbox - Photos on the TV",
    hint: "Pick photos - they appear on the TV as they arrive.",
    pick: "Choose photos",
    uploading: "Sending",
    done: "done - look at the TV.",
    onTv: "On the TV now",
    photos: "photos",
    clear: "Remove the photos",
    clearConfirm: "Take the photos off the TV?",
    full: "Full - take the photos off the TV first.",
    failed: "Could not send",
  },
};

module.exports = {
  page: (ctx) => ctx.render("photoshare.html", { lang: ctx.locale, ...(STR[ctx.locale] || STR.en) }),
  routes: {
    // One photo, already downscaled by the phone. The body cap is per request and
    // the session cap is in photoshare.js; this route only reports which was hit.
    "POST /pshare": {
      maxBody: 12e6,
      handler: (req, res, ctx) => {
        try {
          ctx.json(res, { ok: true, name: photoshare.save(ctx.body.name, ctx.body.data) });
        } catch (e) {
          res.writeHead(e && e.message === "full" ? 507 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (e && e.message) || "failed" }));
        }
      },
    },
    // How many are on the TV. The phone shows this so that picking the same album
    // twice is visibly a mistake rather than a silent one.
    "GET /pshare-list": (req, res, ctx) => ctx.json(res, { count: photoshare.list().length }),
    "POST /pshare-clear": (req, res, ctx) => ctx.json(res, { ok: true, removed: photoshare.clear() }),
  },
};
