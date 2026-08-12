// Tests for the root half of a system update (deploy/tvbox-sysupdate).
//
// This is the one thing on the box that runs code as root out of a download, so
// what is pinned here is mostly what it REFUSES. Two of those refusals are not
// obvious and are the reason the script exists in this shape:
//
//   - a validly signed but OLDER release. The box user can set the box's DNS (the
//     NetworkManager polkit grant covers group netdev), and every release's
//     artifacts stay public forever, so "the signature checks out" is not enough:
//     a replay would otherwise let root re-run a historical provision.sh with its
//     historical grants and its historical pinned key.
//   - a provision run that exited 0 having only warned. Most of provision.sh's
//     failure branches do not set FAIL, so exit status alone cannot mean
//     "revision N is applied" - and recording it anyway would let a later release
//     declare a requirement the box only half has.
//
// Everything runs against a fake root (TVBOX_SYSUPDATE_TEST_ROOT, honoured only
// when not running as root) and a feed served from this process, so no test
// touches the real /etc, /var/lib or the network.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const test = require("node:test");
const assert = require("node:assert");

const SCRIPT = path.join(__dirname, "tvbox-sysupdate");
const USER = os.userInfo().username;

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

// ---------------------------------------------------------------- fixtures

function makeKeys(dir) {
  const priv = path.join(dir, "priv.pem");
  const pub = path.join(dir, "pub.pem");
  sh("openssl", ["genpkey", "-algorithm", "ed25519", "-out", priv]);
  sh("openssl", ["pkey", "-in", priv, "-pubout", "-out", pub]);
  return { priv, pub };
}

function sign(priv, file) {
  const bin = file + ".bin";
  sh("openssl", ["pkeyutl", "-sign", "-inkey", priv, "-rawin", "-in", file, "-out", bin]);
  const b64 = sh("openssl", ["base64", "-A", "-in", bin]);
  fs.rmSync(bin, { force: true });
  return b64;
}

// A release tarball with the shape make-release.sh produces: shell/, infra/ and
// manifest.json at the top. The provision.sh in it is a stand-in that prints the
// same last line the real one does.
function makeTarball(dir, { revision = 2, bad = 0, warn = 0, resultLine = true, extra } = {}) {
  const stage = fs.mkdtempSync(path.join(dir, "stage-"));
  fs.mkdirSync(path.join(stage, "shell"), { recursive: true });
  fs.mkdirSync(path.join(stage, "infra"), { recursive: true });
  fs.writeFileSync(path.join(stage, "shell", "package.json"), JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({ version: "9.9.9" }));
  const lines = [
    "#!/usr/bin/env bash",
    "PROVISION_REVISION=" + revision,
    'echo "ran as $1 unattended=${TVBOX_UNATTENDED:-0}" > "$(dirname "$0")/../../../ran.txt" 2>/dev/null || true',
    'echo "   [ok]   pretend"',
  ];
  if (resultLine) lines.push(`echo "PROVISION_RESULT rev=${revision} bad=${bad} warn=${warn}"`);
  lines.push(`exit ${bad ? 1 : 0}`);
  fs.writeFileSync(path.join(stage, "infra", "provision.sh"), lines.join("\n") + "\n");
  if (extra) extra(stage);
  const tar = path.join(dir, "release-" + Math.random().toString(36).slice(2) + ".tar.gz");
  sh("tar", ["-czf", tar, "-C", stage, "shell", "infra", "manifest.json"]);
  fs.rmSync(stage, { recursive: true, force: true });
  return tar;
}

function sha256(file) {
  return require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// One box: a fake filesystem root, a signing key, and an http feed on loopback.
class Box {
  constructor(opts = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "sysupd-"));
    this.keys = makeKeys(this.dir);
    for (const d of ["etc/tvbox/release-keys.d", "var/lib/tvbox", "run/tvbox", "home/tv/.tvbox"]) {
      fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    }
    if (opts.keys !== false) {
      fs.copyFileSync(this.keys.pub, path.join(this.dir, "etc/tvbox/release-keys.d/tvbox.pem"));
    }
    this.served = {};
    this.server = http.createServer((req, res) => {
      const body = this.served[req.url.split("?")[0]];
      if (body === undefined) return res.writeHead(404).end();
      res.writeHead(200).end(body);
    });
    this.port = null;
  }
  async ready() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    // A failing assertion skips the close() below it, and CI runs `node --test`
    // with no --test-force-exit: an open listener would then hang the job rather
    // than report the failure.
    this.server.unref();
    this.port = this.server.address().port;
    this.writeConf("http://127.0.0.1:" + this.port + "/update.json");
    return this;
  }
  writeConf(feed, user = USER) {
    fs.writeFileSync(path.join(this.dir, "etc/tvbox/sysupdate.conf"), `FEED_URL=${feed}\nTVBOX_USER=${user}\n`);
  }
  // Publish a feed + its detached signature + the tarball it points at.
  publish({ version = "9.9.9", revision = 2, publishedAt, signWith, tarball, sha } = {}) {
    const tar = tarball || makeTarball(this.dir, { revision });
    const feed = {
      feedVersion: 1,
      version,
      url: "http://127.0.0.1:" + this.port + "/release.tar.gz",
      sha256: sha || sha256(tar),
      publishedAt: publishedAt || new Date().toISOString(),
      systemRevision: revision,
    };
    const f = path.join(this.dir, "update.json");
    fs.writeFileSync(f, JSON.stringify(feed, null, 2) + "\n");
    this.served["/update.json"] = fs.readFileSync(f);
    this.served["/update.json.sig"] = sign(signWith || this.keys.priv, f);
    this.served["/release.tar.gz"] = fs.readFileSync(tar);
    return feed;
  }
  // Async, and it has to be: the feed is served by an http server in THIS
  // process, so a synchronous spawn would block the event loop that answers it
  // and every run would sit until the fetch timed out.
  run(action = "apply") {
    return new Promise((resolve) => {
      const p = spawn("python3", [SCRIPT, action], {
        env: { ...process.env, TVBOX_SYSUPDATE_TEST_ROOT: this.dir },
      });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out, status: this.status() }));
    });
  }
  status() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "var/lib/tvbox/sysupdate-status.json"), "utf8"));
    } catch (e) {
      return null;
    }
  }
  revision() {
    try {
      return fs.readFileSync(path.join(this.dir, "var/lib/tvbox/system-revision"), "utf8").trim();
    } catch (e) {
      return null;
    }
  }
  close() {
    this.server.close();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

async function box(opts) {
  return await new Box(opts).ready();
}

// ---------------------------------------------------------------- the ladder

test("a release with a higher revision is applied, and the revision is recorded", async () => {
  const b = await box();
  b.publish({ revision: 2 });
  const r = await b.run();
  assert.equal(r.status.code, "ok", r.out);
  assert.equal(b.revision(), "2");
  b.close();
});

test("provision runs unattended, and as the user the root-owned conf names", async () => {
  const b = await box();
  b.publish({ revision: 2 });
  await b.run();
  // The stand-in provision.sh writes what it was given into the staging tree's
  // parent, which is the state dir.
  const ran = path.join(b.dir, "var/lib/tvbox/ran.txt");
  assert.ok(fs.existsSync(ran), "provision.sh did not run");
  assert.match(fs.readFileSync(ran, "utf8"), new RegExp(`ran as ${USER} unattended=1`));
  b.close();
});

test("the same revision again is a no-op, not a re-run", async () => {
  const b = await box();
  b.publish({ revision: 2 });
  assert.equal((await b.run()).status.code, "ok");
  const second = await b.run();
  assert.equal(second.status.code, "up-to-date");
  b.close();
});

test("a validly signed OLDER release is refused - a signature is not freshness", async () => {
  const b = await box();
  b.publish({ revision: 5, version: "9.9.9" });
  assert.equal((await b.run()).status.code, "ok");
  assert.equal(b.revision(), "5");
  // Everything an attacker replays here is genuine: the same key, the same
  // signature, the same tarball. Only the revision is behind.
  b.publish({ revision: 4, version: "9.9.8" });
  const r = await b.run();
  assert.equal(r.status.code, "up-to-date", r.out);
  assert.equal(b.revision(), "5");
  b.close();
});

test("a feed signed by another key is refused", async () => {
  const b = await box();
  const other = makeKeys(b.dir + "");
  b.publish({ revision: 2, signWith: other.priv });
  const r = await b.run();
  assert.equal(r.status.code, "bad-signature", r.out);
  assert.equal(b.revision(), null);
  b.close();
});

test("no pinned key at all means no system update, not an unchecked one", async () => {
  const b = await box({ keys: false });
  b.publish({ revision: 2 });
  const r = await b.run();
  assert.equal(r.status.code, "no-keys", r.out);
  assert.equal(b.revision(), null);
  b.close();
});

test("a feed published long ago is refused even when its revision is higher", async () => {
  const b = await box();
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
  b.publish({ revision: 2, publishedAt: old });
  assert.equal((await b.run()).status.code, "stale-feed");
  assert.equal(b.revision(), null);
  b.close();
});

test("a tarball that does not match the signed sha256 is refused", async () => {
  const b = await box();
  b.publish({ revision: 2, sha: "0".repeat(64) });
  const r = await b.run();
  assert.equal(r.status.code, "bad-checksum", r.out);
  b.close();
});

test("a tarball carrying a symlink is refused before anything is extracted", async () => {
  const b = await box();
  // `install` follows a symlink at the source, so a link where provision expects
  // a file would be copied out as a root-owned 755 file elsewhere.
  const tar = makeTarball(b.dir, {
    revision: 2,
    extra: (stage) => fs.symlinkSync("/etc/shadow", path.join(stage, "infra", "tvbox-radio")),
  });
  b.publish({ revision: 2, tarball: tar });
  const r = await b.run();
  assert.equal(r.status.code, "bad-tarball", r.out);
  b.close();
});

test("a tarball whose provision.sh disagrees with the feed is refused", async () => {
  const b = await box();
  const tar = makeTarball(b.dir, { revision: 3 }); // tarball says 3
  b.publish({ revision: 2, tarball: tar }); // feed says 2
  const r = await b.run();
  assert.equal(r.status.code, "revision-mismatch", r.out);
  assert.equal(b.revision(), null);
  b.close();
});

test("provision exiting 0 with a failed step does not record the revision", async () => {
  const b = await box();
  // bad=1 is what provision.sh's `bad` sets; the script also exits non-zero, but
  // the count is what decides - most of its failure paths only warn.
  const tar = makeTarball(b.dir, { revision: 2, bad: 1 });
  b.publish({ revision: 2, tarball: tar });
  const r = await b.run();
  assert.equal(r.status.code, "provision-failed", r.out);
  assert.equal(b.revision(), null);
  b.close();
});

test("a provision run that never reached its last line is a failure", async () => {
  const b = await box();
  const tar = makeTarball(b.dir, { revision: 2, resultLine: false });
  b.publish({ revision: 2, tarball: tar });
  const r = await b.run();
  assert.equal(r.status.code, "provision-failed", r.out);
  assert.equal(b.revision(), null);
  b.close();
});

test("warnings are applied but reported, so a half-provisioned box is visible", async () => {
  const b = await box();
  const tar = makeTarball(b.dir, { revision: 2, warn: 3 });
  b.publish({ revision: 2, tarball: tar });
  const r = await b.run();
  assert.equal(r.status.code, "ok-warnings", r.out);
  assert.equal(r.status.warnings, 3);
  assert.equal(b.revision(), "2");
  b.close();
});

test("an OTA still settling postpones the system update", async () => {
  const b = await box();
  fs.mkdirSync(path.join(b.dir, "home/tv/.tvbox/update"), { recursive: true });
  fs.writeFileSync(path.join(b.dir, "home/tv/.tvbox/update/pending"), "2.1.0 2.2.0\n");
  b.publish({ revision: 2 });
  const r = await b.run();
  assert.equal(r.status.code, "busy", r.out);
  assert.equal(b.revision(), null);
  b.close();
});

test("an http feed to a NAME is refused; only a literal private address is allowed", async () => {
  const b = await box();
  b.publish({ revision: 2 });
  b.writeConf("http://updates.example.com/update.json");
  const r = await b.run();
  assert.equal(r.status.code, "bad-config", r.out);
  b.close();
});

test("TVBOX_USER must be a real, non-root account", async () => {
  const b = await box();
  b.publish({ revision: 2 });
  b.writeConf("http://127.0.0.1:" + b.port + "/update.json", "root");
  assert.equal((await b.run()).status.code, "bad-config");
  b.writeConf("http://127.0.0.1:" + b.port + "/update.json", "definitely-not-a-user");
  assert.equal((await b.run()).status.code, "bad-config");
  b.close();
});

test("check looks but never installs", async () => {
  const b = await box();
  b.publish({ revision: 2 });
  const r = await b.run("check");
  assert.equal(r.status.code, "available", r.out);
  assert.equal(b.revision(), null);
  b.close();
});

test("an unreachable feed fails without touching anything", async () => {
  const b = await box();
  b.writeConf("http://127.0.0.1:1/update.json");
  const r = await b.run();
  assert.equal(r.status.code, "feed-unreachable", r.out);
  b.close();
});

test("every status a run can end in is one the launcher knows", async () => {
  // The launcher renders these as translated strings; a code it has never heard
  // of would reach a Hungarian TV as an English root-script word.
  const known = new Set(require("../shell/sysupdate.js").CODES);
  const src = fs.readFileSync(SCRIPT, "utf8");
  const used = new Set();
  for (const m of src.matchAll(/(?:fail|set_status)\(\s*"([a-z-]+)"/g)) used.add(m[1]);
  for (const code of used)
    assert.ok(known.has(code), code + " is written by the applier but absent from sysupdate.js CODES");
});
