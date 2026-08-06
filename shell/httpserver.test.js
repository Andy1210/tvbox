// The two decisions in the transport that are security decisions, and the one that
// is easy to get subtly wrong.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const httpserver = require("./httpserver");

// A response object that records instead of writing.
function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: "",
    piped: null,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(body) {
      res.body = String(body || "");
    },
  };
  return res;
}

test("a static path cannot escape its root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-http-"));
  fs.mkdirSync(path.join(dir, "web"));
  fs.writeFileSync(path.join(dir, "web", "index.html"), "<h1>app</h1>");
  fs.writeFileSync(path.join(dir, "secret.json"), '{"token":"no"}');

  const root = path.join(dir, "web");
  const res = fakeRes();
  httpserver.serveStatic(res, root, "/../secret.json", null);
  assert.strictEqual(res.status, 404, "a traversal must not reach a sibling file");
  assert.strictEqual(res.body, "not found");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a sibling directory that merely shares a prefix is not inside the root", () => {
  // /apps/plexi starts with /apps/plex, and is a different app's directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-http-"));
  fs.mkdirSync(path.join(dir, "plex"));
  fs.mkdirSync(path.join(dir, "plexi"));
  fs.writeFileSync(path.join(dir, "plexi", "config.json"), "{}");

  const res = fakeRes();
  httpserver.serveStatic(res, path.join(dir, "plex"), "../plexi/config.json", null);
  assert.strictEqual(res.status, 404);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a path that is not a file falls back to the SPA's index", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-http-"));
  const index = path.join(dir, "index.html");
  fs.writeFileSync(index, "<h1>launcher</h1>");

  const res = fakeRes();
  httpserver.serveStatic(res, dir, "/some/client/route", index);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers["Content-Type"], "text/html");
  assert.match(res.body, /launcher/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("only our own pages may change state, and a tool with no Origin is not a page", () => {
  const origins = httpserver.ownOrigins(8097);

  // A browser attaches an Origin to every cross-origin request; a LAN page firing
  // at the control API through the TV's own renderer is exactly what this refuses.
  assert.strictEqual(httpserver.foreignOrigin({ headers: { origin: "http://192.168.1.5" } }, origins), true);
  assert.strictEqual(httpserver.foreignOrigin({ headers: { origin: "http://127.0.0.1:8098" } }, origins), true);

  assert.strictEqual(httpserver.foreignOrigin({ headers: { origin: "http://127.0.0.1:8097" } }, origins), false);
  assert.strictEqual(httpserver.foreignOrigin({ headers: { origin: "http://localhost:8097" } }, origins), false);
  // Case is the browser's business, not ours.
  assert.strictEqual(httpserver.foreignOrigin({ headers: { origin: "HTTP://LOCALHOST:8097" } }, origins), false);
  // curl, the CEC bridge, the tvbox CLI: no Origin, and the server only listens on
  // loopback anyway.
  assert.strictEqual(httpserver.foreignOrigin({ headers: {} }, origins), false);
});

test("a plugin route matches on a path segment, not a prefix", () => {
  const hit = () => "spotify";
  const routes = [{ prefix: "/tvbox/api/spotify", table: { "GET /status": hit, "POST /play": hit } }];

  assert.strictEqual(httpserver.matchPluginRoute(routes, "GET", "/tvbox/api/spotify/status"), hit);
  assert.strictEqual(httpserver.matchPluginRoute(routes, "POST", "/tvbox/api/spotify/play"), hit);
  // A different app whose id begins with the same letters must not be captured.
  assert.strictEqual(httpserver.matchPluginRoute(routes, "GET", "/tvbox/api/spotifyX/status"), null);
  // The method is part of the key.
  assert.strictEqual(httpserver.matchPluginRoute(routes, "GET", "/tvbox/api/spotify/play"), null);
  assert.strictEqual(httpserver.matchPluginRoute([], "GET", "/tvbox/api/spotify/status"), null);
});

test("a URL is logged as its origin, and an unparseable one says so", () => {
  assert.strictEqual(
    httpserver.originOf("http://plex.example:32400/library/parts/1?token=secret"),
    "http://plex.example:32400",
  );
  assert.strictEqual(httpserver.originOf("not a url"), "(unparseable url)");
  assert.strictEqual(httpserver.originOf(undefined), "(unparseable url)");
});
