// EDID parsing, against a real one.
//
// The block below was read out of /sys/class/drm on a box, from the LG set the
// HDR and IR-brand paths were developed against - a hand-built EDID would only
// prove the parser agrees with whoever wrote the test.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const edid = require("./edid");

const LG_TV = Buffer.from(
  "AP///////wAebQEAAQEBAQEYAQOAoFp4Cu6Ro1RMmSYPUFShCAAxQEVAYUBxQAEBAQEBAQEBZiFQsFEAGzBAcDYAQIRjAAAe" +
    "ZBkAQEEAJjAYiDYAQIRjAAAYAAAA/QA6Ph5TEAAKICAgICAgAAAA/ABMRyBUVgogICAgICAgAXUCAyLxThAfBJMFFAMCEiAh" +
    "IhUBJhUHUAlXB2cDDAAgAIAeAR2AGHEcFiBYLCUAoFoAAACeAR0AclHQHiBuKFUAIMIxAAAejArQiiDgLRAQPpYAoFoAAAAY" +
    "AjqAGHE4LUBYLEUAoFoAAAAeAAAAAAAAAAAAAAAAAAAAAAAAAAAASw==",
  "base64",
);

// The HDR blocks are BUILT, not captured: the set above is the SDR one in the
// second room, and the HDR set is in use. The base block stays real, so what is
// synthetic here is only the extension the parser walks. The byte values are the
// ones the HDR set reports: c0 (BT2020 YCC+RGB) and 0d (SDR|PQ|HLG).
function withCta({ colorimetry = null, eotf = null } = {}) {
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
  ext[2] = i; // where the timing descriptors would start
  const base = Buffer.from(LG_TV.slice(0, 128));
  base[126] = 1; // one extension follows
  return Buffer.concat([base, ext]);
}

test("an HDR set says both BT2020 and PQ", () => {
  assert.deepStrictEqual(edid.hdr(withCta({ colorimetry: 0xc0, eotf: 0x0d })), {
    bt2020: true,
    pq: true,
  });
});

test("either half alone is not an HDR set", () => {
  // Asking a set for PQ on half an answer is what puts an SDR UI in a PQ frame.
  assert.deepStrictEqual(edid.hdr(withCta({ colorimetry: 0xc0 })), { bt2020: true, pq: false });
  assert.deepStrictEqual(edid.hdr(withCta({ eotf: 0x0d })), { bt2020: false, pq: true });
  // An SDR-only set: the colorimetry block is there with no BT2020 bits, and the
  // EOTF byte says SDR.
  assert.deepStrictEqual(edid.hdr(withCta({ colorimetry: 0x00, eotf: 0x01 })), {
    bt2020: false,
    pq: false,
  });
});

test("a real SDR set says neither, extension and all", () => {
  // This one does have a CTA extension; what it lacks is those two blocks.
  assert.deepStrictEqual(edid.hdr(LG_TV), { bt2020: false, pq: false });
  assert.deepStrictEqual(edid.hdr(LG_TV.slice(0, 128)), { bt2020: false, pq: false });
  assert.deepStrictEqual(edid.hdr(null), { bt2020: false, pq: false });
  assert.deepStrictEqual(edid.hdr(Buffer.alloc(64)), { bt2020: false, pq: false });
});

test("the manufacturer is a three-letter code, not a brand name", () => {
  // LG registered GSM (Goldstar), so a substring match on the brand finds nothing
  // here - the caller needs a table.
  assert.strictEqual(edid.manufacturer(LG_TV), "GSM");
  assert.strictEqual(edid.manufacturer(null), null);
});

test("the set's own name is what a human would recognise", () => {
  assert.strictEqual(edid.name(LG_TV), "LG TV");
});

test("a truncated or absent EDID gives no name rather than a wrong one", () => {
  assert.strictEqual(edid.name(Buffer.alloc(128)), null);
  assert.strictEqual(edid.name(null), null);
});

test("reading picks the connector that has an EDID, and survives one that has none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-edid-"));
  // A Pi 5 has two HDMI connectors and normally only one is plugged in; the empty
  // one has an edid file of zero length, not a missing one.
  fs.mkdirSync(path.join(dir, "card1-HDMI-A-1"));
  fs.mkdirSync(path.join(dir, "card1-HDMI-A-2"));
  fs.mkdirSync(path.join(dir, "card1-Writeback-1"));
  fs.writeFileSync(path.join(dir, "card1-HDMI-A-1", "edid"), Buffer.alloc(0));
  fs.writeFileSync(path.join(dir, "card1-HDMI-A-2", "edid"), LG_TV);

  const got = edid.read(dir);
  assert.strictEqual(edid.name(got), "LG TV");
  assert.strictEqual(edid.read(path.join(dir, "nope")), null);

  fs.rmSync(dir, { recursive: true, force: true });
});
