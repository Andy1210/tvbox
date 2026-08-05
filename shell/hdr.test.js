const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hdr = require("./hdr");

// A CTA-861 extension carrying the two blocks a set needs to be asked for PQ.
// `colorimetry` and `eotf` are the bytes a real EDID puts there: the LG this was
// developed against reports c0 (BT2020 YCC+RGB) and 0d (SDR|PQ|HLG).
function edidWith({ colorimetry = null, eotf = null } = {}) {
  const base = Buffer.alloc(128);
  const ext = Buffer.alloc(128);
  ext[0] = 0x02; // CTA-861
  ext[1] = 0x03; // revision
  let i = 4;
  if (colorimetry !== null) {
    ext[i++] = (7 << 5) | 3; // extended tag, 3 bytes follow
    ext[i++] = 5; // colorimetry data block
    ext[i++] = colorimetry;
    ext[i++] = 0x00;
  }
  if (eotf !== null) {
    ext[i++] = (7 << 5) | 3;
    ext[i++] = 6; // HDR static metadata data block
    ext[i++] = eotf;
    ext[i++] = 0x01; // static metadata type 1
  }
  ext[2] = i; // where the DTDs would start
  return Buffer.concat([base, ext]);
}

test("parseEdidHdr reads the two blocks a PQ set advertises", () => {
  assert.deepStrictEqual(hdr.parseEdidHdr(edidWith({ colorimetry: 0xc0, eotf: 0x0d })), {
    bt2020: true,
    pq: true,
  });
});

test("parseEdidHdr says no when either half is missing", () => {
  assert.deepStrictEqual(hdr.parseEdidHdr(edidWith({ colorimetry: 0xc0 })), { bt2020: true, pq: false });
  assert.deepStrictEqual(hdr.parseEdidHdr(edidWith({ eotf: 0x0d })), { bt2020: false, pq: true });
  // An SDR-only set: colorimetry block present but no BT2020 bits, EOTF says SDR.
  assert.deepStrictEqual(hdr.parseEdidHdr(edidWith({ colorimetry: 0x00, eotf: 0x01 })), {
    bt2020: false,
    pq: false,
  });
});

test("parseEdidHdr survives a truncated or absent EDID", () => {
  assert.deepStrictEqual(hdr.parseEdidHdr(null), { bt2020: false, pq: false });
  assert.deepStrictEqual(hdr.parseEdidHdr(Buffer.alloc(64)), { bt2020: false, pq: false });
});

test("wants: PQ content on the plane path, on a capable panel", () => {
  const pq = { gamma: "pq" };
  assert.strictEqual(hdr.wants(pq, true, true), true);
  // Not on the plane path: mpv renders and tone-maps it, so the output stays SDR
  // or the picture would be mapped twice.
  assert.strictEqual(hdr.wants(pq, false, true), false);
  assert.strictEqual(hdr.wants({ gamma: "bt.1886" }, true, true), false);
  assert.strictEqual(hdr.wants(pq, true, false), false);
  assert.strictEqual(hdr.wants(null, true, true), false);
});

test("writeConfig writes the toggle and reports whether anything changed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-hdr-"));
  const file = path.join(dir, "labwc", "rc.xml");
  assert.strictEqual(hdr.writeConfig(true, file), true);
  assert.match(fs.readFileSync(file, "utf8"), /<hdr>yes<\/hdr>/);
  // Same value again: nothing written, so nothing downstream is asked to reload.
  assert.strictEqual(hdr.writeConfig(true, file), false);
  assert.strictEqual(hdr.writeConfig(false, file), true);
  assert.match(fs.readFileSync(file, "utf8"), /<hdr>no<\/hdr>/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("gammaPending waits only where the colour space matters", () => {
  assert.strictEqual(hdr.gammaPending({ gamma: "" }, true), true);
  assert.strictEqual(hdr.gammaPending({ gamma: "pq" }, true), false);
  // Below the zero-copy threshold the output stays SDR either way, so an
  // unavailable answer must not hold the film up.
  assert.strictEqual(hdr.gammaPending({ gamma: "" }, false), false);
});
