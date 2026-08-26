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

// The same names as an HTTP HEADER, which is the form an exception carries them
// in: a stack or a "fetch failed" message quotes the request, and the query and
// JSON shapes above never match a `X-Plex-Token: abc` line. Anchored to the start
// of a line so a sentence merely containing the word is left alone.
const HEADER = new RegExp(
  "^([ \\t]*(?:" + SECRET_PARAMS.join("|") + "|authorization|cookie)[ \\t]*:[ \\t]*).+$",
  "gim",
);
// Credentials in a URL's userinfo (`mqtt://tvbox:PASS@broker`, an SMB share, an
// IPTV portal). The user is kept: it is what makes the line worth reading, and it
// is not the secret.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)([^\s/@]*)(@)/gi;
// Node writes a failed child process up as "Command failed: <the whole command
// line>", and these command lines carry the wifi PSK, an rclone password and a
// share's credentials. The program is the diagnostic part; its arguments are not.
// The "Error: " a stack puts in front of it is part of the same line, so the
// anchor allows it: without that the shape only matched a bare message.
const COMMAND = /^([ \t]*(?:[A-Za-z]*Error: )?Command failed: *)(\S+)[^\n]*/gim;

function redact(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(QUERY, "$1REDACTED")
    .replace(JSON_FIELD, "$1REDACTED$3")
    .replace(HEADER, "$1REDACTED")
    .replace(USERINFO, "$1REDACTED$3")
    .replace(COMMAND, "$1$2 REDACTED");
}

module.exports = { redact, _test: { SECRET_PARAMS } };
