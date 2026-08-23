// The two decisions in the transport that are security decisions, and the one that
// is easy to get subtly wrong.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const httpserver = require("./httpserver");

// A response object that records instead of writing. It is also a usable sink for
// a pipe, because serveStatic streams a real file rather than reading it, and
// `done` resolves when the response is closed either way.
function fakeRes() {
  let closed;
  const res = {
    status: 0,
    headers: null,
    body: "",
    piped: null,
    done: new Promise((r) => (closed = r)),
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    on: () => res,
    once: () => res,
    emit: () => false,
    write(chunk) {
      res.body += chunk;
      return true;
    },
    end(body) {
      if (body !== undefined) res.body = String(body || "");
      closed();
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

test("a symlink out of the root is not inside it either", () => {
  // An app's web/ directory is extracted from a tarball we did not write, so the
  // link is the interesting case: the request path stays inside the root and the
  // file it lands on does not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-http-"));
  const root = path.join(dir, "web");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(dir, "config.json"), '{"iptv":{"password":"hunter2"}}');
  fs.symlinkSync(path.join(dir, "config.json"), path.join(root, "logo.png"));

  const res = fakeRes();
  httpserver.serveStatic(res, root, "/logo.png", null);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.includes("hunter2"), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a symlink that stays inside the root is served", async () => {
  // The guard resolves both sides, so a root that is itself a symlink (the OTA
  // `current` -> `versions/<v>` shape) must still serve its own files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-http-"));
  fs.mkdirSync(path.join(dir, "versions", "2.0.0", "web"), { recursive: true });
  fs.writeFileSync(path.join(dir, "versions", "2.0.0", "web", "app.js"), "ok");
  fs.symlinkSync(path.join(dir, "versions", "2.0.0"), path.join(dir, "current"));

  const res = fakeRes();
  httpserver.serveStatic(res, path.join(dir, "current", "web"), "/app.js", null);
  assert.strictEqual(res.status, 200);
  await res.done;
  assert.strictEqual(res.body, "ok");

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

test("a file that goes away mid-request is a 404, not a dead shell", () => {
  // existsSync + statSync asks twice and the answer can change in between; the
  // throw used to reach an http handler with no try/catch around it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-http-"));
  const res = fakeRes();
  httpserver.serveStatic(res, dir, "/gone.js", null);
  assert.strictEqual(res.status, 404);

  // A directory is not a file either, and neither is a path with a NUL in it -
  // statSync throws on that one rather than answering.
  fs.mkdirSync(path.join(dir, "sub"));
  const dirRes = fakeRes();
  httpserver.serveStatic(dirRes, dir, "/sub", null);
  assert.strictEqual(dirRes.status, 404);

  const nulRes = fakeRes();
  httpserver.serveStatic(nulRes, dir, "/a\u0000b", null);
  assert.strictEqual(nulRes.status, 404);

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

test("a plugin can put the same-origin gate on one of its own GETs", () => {
  // An open GET is the policy for a side-effect-free read. A read that SPENDS
  // something is not one - xcloud's wait-time lookup is an authenticated request
  // to Microsoft per distinct id, and any page the box loads can fire a
  // cross-origin GET through an <img> tag even though it cannot read the answer.
  const hit = () => "x";
  const routes = [
    {
      prefix: "/tvbox/api/xcloud",
      table: { "GET /status": hit, "GET /waittime": hit, "POST /session/start": hit },
      guard: ["GET /waittime"],
    },
  ];
  assert.strictEqual(httpserver.pluginRouteGuarded(routes, "GET", "/tvbox/api/xcloud/waittime"), true);
  assert.strictEqual(httpserver.pluginRouteGuarded(routes, "GET", "/tvbox/api/xcloud/status"), false);
  // A path no route serves must not be reported as guarded - the gate would then
  // 403 a request the 404 handler was going to answer.
  assert.strictEqual(httpserver.pluginRouteGuarded(routes, "GET", "/tvbox/api/xcloud/nope"), false);
  assert.strictEqual(httpserver.pluginRouteGuarded(routes, "GET", "/tvbox/api/other/waittime"), false);
  // Declaring no guard is the default, and the handler still resolves.
  const plain = [{ prefix: "/tvbox/api/xcloud", table: { "GET /waittime": hit } }];
  assert.strictEqual(httpserver.pluginRouteGuarded(plain, "GET", "/tvbox/api/xcloud/waittime"), false);
  assert.strictEqual(httpserver.matchPluginRoute(plain, "GET", "/tvbox/api/xcloud/waittime"), hit);
});

test("the guard and the handler are decided by ONE resolution", () => {
  // Two plugins claiming overlapping prefixes: matching is first-wins, so asking
  // the two questions separately could gate against one route and serve another.
  const a = () => "a";
  const b = () => "b";
  const routes = [
    { prefix: "/tvbox/api/x", table: { "GET /go": a } },
    { prefix: "/tvbox/api/x", table: { "GET /go": b }, guard: ["GET /go"] },
  ];
  assert.strictEqual(httpserver.matchPluginRoute(routes, "GET", "/tvbox/api/x/go"), a);
  assert.strictEqual(httpserver.pluginRouteGuarded(routes, "GET", "/tvbox/api/x/go"), false);
});

test("a cross-site load with no Origin is still foreign", () => {
  // The hole the guarded-GET list was built to close and could not: `Origin` is not
  // sent for a cross-origin GET the browser makes on a page's behalf, so an <img
  // src="http://127.0.0.1:8097/tvbox/api/xcloud/waittime?id=…"> in a remote app's
  // window arrived indistinguishable from our own launcher.
  const origins = httpserver.ownOrigins(8097);
  const req = (headers) => ({ headers });
  assert.equal(httpserver.foreignOrigin(req({ "sec-fetch-site": "cross-site" }), origins), true);
  assert.equal(httpserver.foreignOrigin(req({ "sec-fetch-site": "same-origin" }), origins), false);
  assert.equal(httpserver.foreignOrigin(req({ "sec-fetch-site": "same-site" }), origins), false);
  // A typed URL is a person, not a page acting on one.
  assert.equal(httpserver.foreignOrigin(req({ "sec-fetch-site": "none" }), origins), false);
  // `same-site` is deliberately allowed, and it is not the tautology it looks:
  // measured against a real Chromium, a page on ANOTHER loopback port reports
  // same-site, because a port is not part of a site. On this box that is right -
  // the pairing server is ours - but it is why this is no defence against a
  // hostile local port.
  // And a non-browser sends neither header: curl, the CEC bridge, the tvbox CLI.
  assert.equal(httpserver.foreignOrigin(req({}), origins), false);
  // Origin DECIDES when it is there, in both directions. A page cannot forge it,
  // and it has to win: the two spellings this server answers to are not the same
  // site, so a page at `localhost:8097` fetching `127.0.0.1:8097` sends
  // `cross-site` for one server - measured - and `ownOrigins` blesses both.
  assert.equal(
    httpserver.foreignOrigin(req({ origin: "http://evil.invalid", "sec-fetch-site": "same-origin" }), origins),
    true,
  );
  assert.equal(
    httpserver.foreignOrigin(req({ origin: "http://localhost:8097", "sec-fetch-site": "cross-site" }), origins),
    false,
  );
  assert.equal(httpserver.foreignOrigin(req({ origin: "HTTP://LOCALHOST:8097" }), origins), false);
});

test("a guard that names no route is a plugin that does not load", () => {
  // The mechanism's own failure mode: `guard: ["GET /waitTime"]` beside a table
  // defining `"GET /waittime"` matches nothing, the route still answers, and the
  // costly read is open to any page the box loads with nothing saying so. main.js
  // refuses the registration instead - a plugin that does not load is logged, and
  // its tile still works.
  //
  // The rule lives in main.js (which cannot be required here - it needs electron),
  // so this pins the CONTRACT the guard list depends on: an entry only ever gates
  // anything when it is exactly a key of the same table.
  const hit = () => "x";
  const table = { "GET /waittime": hit, "POST /start": hit };
  const routes = [{ prefix: "/tvbox/api/x", table, guard: ["GET /waitTime"] }];
  assert.strictEqual(httpserver.pluginRouteGuarded(routes, "GET", "/tvbox/api/x/waittime"), false);
  assert.strictEqual(httpserver.matchPluginRoute(routes, "GET", "/tvbox/api/x/waittime"), hit);
  // Spelled the way the table spells it, it gates.
  routes[0].guard = ["GET /waittime"];
  assert.strictEqual(httpserver.pluginRouteGuarded(routes, "GET", "/tvbox/api/x/waittime"), true);
});
