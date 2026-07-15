// Pairing provider: ambient/screensaver wallpapers. The phone downscales images
// to ~1080p and uploads them; it also lists and deletes the ones already on the
// box. Owns its page + all /photo* routes; the shell provides code-gating.
const fs = require("fs");
const path = require("path");
const ambient = require("../ambient");

const STR = {
  hu: {
    title: "tvbox - Háttérképek feltöltése",
    hint: "Válaszd ki a fotókat - automatikusan feltöltődnek a TV képernyővédőjéhez (átméretezve).",
    pick: "Fotók kiválasztása",
    uploading: "Feltöltés",
    done: "kész - a TV-n zárd be.",
    current: "Feltöltött képek",
    empty: "Még nincs feltöltött kép.",
    del: "Törlés",
    delConfirm: "Törlöd ezt a képet?",
  },
  en: {
    title: "tvbox - Upload wallpapers",
    hint: "Pick photos - they upload to the TV's ambient screen automatically (resized).",
    pick: "Choose photos",
    uploading: "Uploading",
    done: "done - close on the TV.",
    current: "Uploaded photos",
    empty: "No photos uploaded yet.",
    del: "Delete",
    delConfirm: "Delete this photo?",
  },
};

// A bare, traversal-safe filename inside PHOTO_DIR, or "" if it escapes.
function safePath(name) {
  name = String(name || "");
  if (!name || /[/\\]/.test(name) || name.includes("..")) return "";
  const p = path.join(ambient.PHOTO_DIR, name);
  return p.startsWith(ambient.PHOTO_DIR + path.sep) ? p : "";
}

module.exports = {
  page: (ctx) => ctx.render("photos.html", { lang: ctx.locale, ...(STR[ctx.locale] || STR.en) }),
  routes: {
    // Upload one resized photo (base64). Large body: full-frame 1080p JPEG.
    "POST /photo": {
      maxBody: 12e6,
      handler: (req, res, ctx) => {
        try {
          const name = ambient.savePhoto(ctx.body.name, ctx.body.data);
          ctx.json(res, { ok: true, name });
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
        }
      },
    },
    // localPhotos: the phone page manages UPLOADS only - the Bing wallpaper
    // cache is neither previewable nor deletable through it
    "GET /photos": (req, res, ctx) => ctx.json(res, { names: ambient.localPhotos() }),
    "GET /photo-img": (req, res, ctx) => {
      const p = safePath(ctx.query.get("name"));
      if (!p) {
        res.writeHead(400);
        return res.end();
      }
      let buf;
      try {
        buf = fs.readFileSync(p);
      } catch (e) {
        res.writeHead(404);
        return res.end();
      }
      const ext = p.toLowerCase().split(".").pop();
      const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(buf);
    },
    "POST /photo-delete": (req, res, ctx) => ctx.json(res, { ok: ambient.deletePhoto(String(ctx.body.name || "")) }),
  },
};
