// What language a web app should see.
//
// The box's UI language lives in the launcher (its i18n store), and until now web
// apps knew nothing about it: a remote app got whatever Chromium derived from the
// system locale, or - worse - whatever the site guessed from the IP (xbox.com came
// up in German on a Hungarian box). Hardcoding a market into the app's URL is the
// wrong fix: it pins ONE language into the registry manifest and stops following
// the setting.
//
// So the shell passes the UI language down two channels, which is what sites
// actually read:
//   - `Accept-Language` on the app's session (what the server sees)
//   - `navigator.language` / `navigator.languages` (what an SPA reads), overridden
//     in the page's own world by the preload before its scripts run
//
// Pure so shell/lang.test.js can pin the tag arithmetic; the wiring is in main.js.

// A locale id from the launcher ("hu", "en") is not a BCP-47 tag a site can use as
// a market. Give the known ones their region; anything else passes through if it
// already looks like a tag, so a new launcher locale needs no change here.
const REGION = { hu: "hu-HU", en: "en-GB", de: "de-DE", sk: "sk-SK", ro: "ro-RO" };

function toTag(locale, systemLocale) {
  const id = String(locale || "").trim();
  if (/^[a-z]{2,3}-[A-Za-z0-9]{2,8}$/.test(id)) return id; // already a tag
  const base = id
    .toLowerCase()
    .slice(0, 3)
    .replace(/[^a-z]/g, "");
  if (!base) return String(systemLocale || "en-GB");
  // The system locale wins the REGION guess when it's the same language: a box set
  // to en_US shouldn't be told en-GB just because that's our default for "en".
  const sys = String(systemLocale || "");
  if (sys.toLowerCase().startsWith(base + "-")) return sys;
  return REGION[base] || base;
}

// The header, most-preferred first: the UI language, its bare form, then English as
// the last resort (a site with no Hungarian should serve English, not German).
function acceptLanguage(tag) {
  const base = String(tag).split("-")[0];
  const parts = [tag];
  if (base && base !== tag) parts.push(base + ";q=0.9");
  if (base !== "en") parts.push("en;q=0.8");
  return parts.join(",");
}

// override: a manifest's runtime.language, for an app that must be pinned (a
// regional service that only exists in one language). "system" / absent = follow
// the box.
function resolve(uiLocale, systemLocale, override) {
  const pinned = String(override || "").trim();
  const tag = pinned && pinned !== "system" ? toTag(pinned, systemLocale) : toTag(uiLocale, systemLocale);
  return { tag, accept: acceptLanguage(tag) };
}

// Placeholders a manifest can use wherever a market/locale belongs - a URL path
// segment or a cookie value - so the app FOLLOWS the box's language instead of
// pinning one. Sites differ in which lever they honour: Accept-Language +
// navigator.language for most, a path segment for xbox.com, its own cookie for
// others, so the manifest picks and this fills it in.
//   {locale}       hu-HU     {locale_lower} hu-hu
//   {lang}         hu        {lang_upper}   HU (the region alone)
function expand(template, tag) {
  const t = String(tag || "");
  const base = t.split("-")[0];
  const region = t.split("-")[1] || "";
  return String(template == null ? "" : template)
    .replace(/\{locale\}/g, t)
    .replace(/\{locale_lower\}/g, t.toLowerCase())
    .replace(/\{lang\}/g, base)
    .replace(/\{lang_upper\}/g, region.toUpperCase());
}

module.exports = { resolve, toTag, acceptLanguage, expand };
