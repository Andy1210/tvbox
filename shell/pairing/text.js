// Pairing provider: type into a keyboard-less app from the phone. The TV shows a
// QR + 4-digit code (the launcher's typing screen), the phone opens one field and
// submits, and the shell delivers the text to the app's focused field as
// keystrokes (../textinput.js). The pairing core supplies the code gate, the TTL
// and the brute-force lockout.
//
// The phone form is deliberately dumb: it never learns what the text is FOR beyond
// the label the page reported, and nothing is stored - the value goes straight to
// ../textinput.submit() and the session ends.
const textinput = require("../textinput");

// A JS string literal for a value that goes inside a <script> block. `render` does
// raw substitution with no escaping of its own, so JSON.stringify is not enough on
// its own: the one sequence that ends a script block is `</script>`, and JSON leaves
// it exactly as it came. Escaping every `<` closes that without changing the string
// the browser ends up with. U+2028/2029 go with it - a line terminator inside a
// literal is a parse error in older engines, and a phone's browser is not ours to
// choose. The label reaches the page the same way but is charset-stripped first (no
// `<` survives it); a field's own contents cannot be stripped like that without
// corrupting perfectly ordinary text, so they are escaped instead.
function jsString(text) {
  return JSON.stringify(String(text == null ? "" : text))
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const STR = {
  hu: {
    title: "tvbox - Beírás",
    hint: "Írd be ide, és a TV-n megjelenik a kijelölt mezőben.",
    field: "Szöveg",
    send: "Küldés a TV-re",
    sent: "Elküldve ✓ - ez a lap bezárható.",
    empty: "Írj be valamit.",
    expired: "A TV már nem vár beírásra - indítsd újra ott.",
    error: "Hiba történt - próbáld újra.",
    secret: "Jelszó jellegű mező: a szöveg a helyi hálózaton, titkosítás nélkül megy a TV-hez.",
  },
  en: {
    title: "tvbox - Type",
    hint: "Type here and it lands in the field selected on the TV.",
    field: "Text",
    send: "Send to the TV",
    sent: "Sent ✓ - you can close this page.",
    empty: "Type something first.",
    expired: "The TV isn't waiting for input any more - start again there.",
    error: "Something went wrong - try again.",
    secret: "Password-like field: the text travels to the TV over your local network, unencrypted.",
  },
};

module.exports = {
  page: (ctx) => {
    const st = textinput.status();
    // The label comes from the REMOTE page (its placeholder/aria-label), so it is
    // untrusted text and the pairing renderer does no escaping. Strip it down to
    // harmless characters, cap it, and hand it over JSON-encoded for a textContent
    // assignment - it never reaches the HTML as markup.
    const label = String(st.active ? st.label || "" : "")
      .replace(/[^\p{L}\p{N} .,:!?_@-]/gu, "")
      .slice(0, 60)
      .trim();
    return ctx.render("text.html", {
      lang: ctx.locale,
      labelJson: jsString(label),
      // What the field already holds, so the phone edits it instead of replacing it
      // blind - the TV types the result back over the whole field either way. Never a
      // password and never longer than the shell will type: textinput.js decides both
      // and hands over an empty string when it says no.
      valueJson: jsString(st.active ? st.value || "" : ""),
      isPassword: st.active && st.password ? "1" : "",
      inputType: st.active && st.password ? "password" : "text",
      maxlen: String(textinput.MAX_TEXT),
      ...(STR[ctx.locale] || STR.en),
    });
  },
  routes: {
    // One shot: deliver and end the session. A late submit (the TV already moved
    // on) answers "expired" rather than typing into whatever is focused now.
    "POST /text": (req, res, ctx) => {
      const text = String(ctx.body.text == null ? "" : ctx.body.text);
      if (!text) {
        ctx.json(res, { ok: false, error: "empty" });
        return;
      }
      const r = textinput.submit(text);
      ctx.json(res, r.ok ? { ok: true } : { ok: false, error: "expired" });
    },
  },
};
