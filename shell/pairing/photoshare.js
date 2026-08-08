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
const fs = require("fs");
const photoshare = require("../photoshare");
const images = require("../images");

const STR = {
  hu: {
    title: "tvbox - Képek a TV-re",
    hint: "Válaszd ki a képeket - megjelennek a TV-n, ahogy megérkeznek.",
    pick: "Képek kiválasztása",
    uploading: "Küldés",
    done: "kész - nézd a TV-t.",
    onTv: "A TV-n most",
    photos: "kép",
    del: "Levétel",
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
    del: "Take it off",
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
    // What is on the TV. Names as well as a count, so the phone can show the
    // session back and take one photo off it - picking the same album twice is a
    // mistake to undo, not just one to be told about.
    "GET /pshare-list": (req, res, ctx) => {
      const names = photoshare.list();
      ctx.json(res, { count: names.length, names, max: photoshare.MAX_ITEMS });
    },
    // The TILE, not the photo. The phone already holds the original it sent; what
    // it needs back is something small enough to put thirty of on a screen over
    // wifi, and images.js will usually have the camera's own thumbnail to hand.
    "GET /pshare-img": (req, res, ctx) => {
      const p = photoshare.pathFor(ctx.query.get("name"));
      if (!p) {
        res.writeHead(400);
        return res.end();
      }
      images.thumb(p, (err, tile) => {
        if (err) {
          res.writeHead(err === "not_found" ? 404 : 500);
          return res.end();
        }
        // The headers wait for the file to open, and an `error` is handled: the
        // cache entry can be pruned between the callback above and this read, and
        // an unhandled stream error takes the whole shell down with it.
        const stream = fs.createReadStream(tile);
        stream.on("open", () => {
          res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
          stream.pipe(res);
        });
        stream.on("error", (e) => {
          console.warn("[photoshare] tile read failed:", tile, e.message);
          if (!res.headersSent) res.writeHead(500);
          try {
            res.end();
          } catch (e2) {}
        });
        // `pipe` unpipes on a closed response but does not close the file, and a
        // phone scrolling a grid abandons tiles it has moved past.
        res.on("close", () => stream.destroy());
      });
    },
    "POST /pshare-delete": (req, res, ctx) => ctx.json(res, { ok: photoshare.remove(String(ctx.body.name || "")) }),
    "POST /pshare-clear": (req, res, ctx) => ctx.json(res, { ok: true, removed: photoshare.clear() }),
  },
};
