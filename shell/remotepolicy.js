// Where a remote web app is allowed to go, and what may be put in its cookie jar.
//
// A remote site is UNTRUSTED relative to the launcher, so navigation is locked to
// the manifest's declared `runtime.origins` and popups are held to the same list.
// The decisions are here rather than beside the window they guard, because they are
// pure string work and this is the boundary: a manifest arrives from a registry,
// and getting "is this host declared" wrong is what lets one reach an origin its
// author never named.
let deps = {
  config: null, // ./config - uiLocale + appConfig
  lang: null, // ./lang - resolve + expand
  netguard: null, // ./netguard - isLanHost
  systemLocale: () => "", // app.getSystemLocale()
};

function init(d) {
  deps = { ...deps, ...d };
}

// Which language the app should be told it runs in, both channels: the
// Accept-Language header (the server's view) and navigator.language (the page's).
function languageFor(rt) {
  return deps.lang.resolve(deps.config.uiLocale(), deps.systemLocale(), (rt || {}).language);
}

/**
 * A remote app's URL: either literal in the manifest (runtime.url, e.g.
 * youtube.com/tv) or config-driven (runtime.urlConfig names a config section
 * holding { baseUrl }, e.g. a user's Home Assistant). Returns "" when a
 * config-driven URL isn't set yet, so the caller can treat the app as
 * unconfigured instead of loading a blank window.
 */
function resolveRemoteUrl(m) {
  const rt = m.runtime || {};
  if (rt.urlConfig) return (deps.config.appConfig(rt.urlConfig) || {}).baseUrl || "";
  // A {locale} placeholder in the URL is how a site that keeps its market in the
  // PATH follows the box's language (xbox.com ignores Accept-Language and redirects
  // by IP - measured - so /{locale}/play is the only lever that works there). It is
  // a template, not a pinned market: change the UI language and the next launch
  // follows it.
  return deps.lang.expand(rt.url || "", languageFor(rt).tag);
}

// Loopback / RFC1918 / link-local / mDNS - a self-hosted LAN service (Home
// Assistant, Jellyfin, ...) can't be a public untrusted site, so plain http to
// it is acceptable; public hosts must still be https.
function remoteProtoOk(x) {
  return x.protocol === "https:" || (x.protocol === "http:" && deps.netguard.isLanHost(x.hostname));
}

// What the manifest declared, or - with nothing declared - the host of the URL the
// app was opened at, so an app that names no origins is still locked to its own.
function allowedRemoteHosts(rt, url) {
  const declared = ((rt || {}).origins || []).map((s) => String(s).toLowerCase());
  if (declared.length) return declared;
  try {
    return [new URL(url).hostname.toLowerCase()];
  } catch (e) {
    return [];
  }
}

// May this window go there? A subdomain of a declared host counts; anything else,
// and anything that is not a URL at all, does not.
function navigationAllowed(u, hosts) {
  try {
    const x = new URL(u);
    const n = x.hostname.toLowerCase();
    return remoteProtoOk(x) && hosts.some((h) => n === h || n.endsWith("." + h));
  } catch (e) {
    return false;
  }
}

/**
 * The cookies a manifest asks for (e.g. a site's own locale cookie), with the same
 * {locale} templating as the URL.
 *
 * Restricted to the app's DECLARED origins: a registry manifest must not be able
 * to plant a cookie for an unrelated domain, and the partition is the app's own
 * anyway. At most eight, because this is a list from a file we did not write.
 *
 * Returns the argument objects for `session.cookies.set`, plus the ones refused so
 * the caller can say why.
 */
const MAX_COOKIES = 8;
function cookiesFor(rt, hosts, tag) {
  const set = [];
  const skipped = [];
  for (const c of Array.isArray((rt || {}).cookies) ? rt.cookies.slice(0, MAX_COOKIES) : []) {
    const cUrl = String((c && c.url) || "");
    let host = "";
    try {
      host = new URL(cUrl).hostname.toLowerCase();
    } catch (e) {
      host = "";
    }
    const allowedHost = host && hosts.some((h) => host === h || host.endsWith("." + h));
    if (!allowedHost || !c.name) {
      skipped.push({ url: cUrl, name: c && c.name });
      continue;
    }
    set.push({
      url: cUrl,
      name: String(c.name),
      value: deps.lang.expand(String(c.value == null ? "" : c.value), tag),
      domain: c.domain ? String(c.domain) : undefined,
      path: c.path ? String(c.path) : undefined,
      secure: cUrl.startsWith("https:"),
    });
  }
  return { set, skipped };
}

module.exports = {
  init,
  languageFor,
  resolveRemoteUrl,
  remoteProtoOk,
  allowedRemoteHosts,
  navigationAllowed,
  cookiesFor,
  MAX_COOKIES,
};
