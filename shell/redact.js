// Keep credentials out of ~/.tvbox/shell.log.
//
// The shell forwards every app's console output to its own log, and an app's
// idea of a debug line is not ours: the Plex client logs whole request URLs at
// DEBUG, and a Plex URL carries the account's `X-Plex-Token` as a query
// parameter. That is an authentication credential landing in a plaintext file
// that backups, diagnostics reports and screenshots all pick up. Plex's own
// developer guidance is explicit about not logging tokens or full request URLs.
//
// Deliberately a denylist of parameter NAMES rather than an attempt to
// recognise secrets by shape: a token looks like any other opaque string, and
// dropping URLs wholesale would take the diagnostic value with it.
const SECRET_PARAMS = [
  "x-plex-token",
  "plextoken",
  "token",
  "access_token",
  "auth_token",
  "api_key",
  "apikey",
  "password",
  "passwd",
  "secret",
  "signature",
];
// `name=value` in a query string or a form body, up to the next separator. The
// value may be empty (nothing to hide, but the shape still matches).
const QUERY = new RegExp("([?&;](?:" + SECRET_PARAMS.join("|") + ")=)([^&;\\s\"'<>\\\\]*)", "gi");
// The same names as a JSON field, e.g. {"token":"abc"} in a logged payload.
const JSON_FIELD = new RegExp("([\"'](?:" + SECRET_PARAMS.join("|") + ")[\"']\\s*:\\s*[\"'])([^\"']*)([\"'])", "gi");

function redact(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(QUERY, "$1REDACTED").replace(JSON_FIELD, "$1REDACTED$3");
}

module.exports = { redact, _test: { SECRET_PARAMS } };
