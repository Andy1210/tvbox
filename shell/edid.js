// What the TV says about itself.
//
// The EDID is read straight from the DRM connector in sysfs, which is the only
// source that does not depend on a compositor protocol: it is there before the
// session starts, and it stays there whatever the session is running.
//
// Two callers, both of which used to have their own way in: HDR capability
// (hdr.js) and the TV's make, which the Fire TV remote's IR programmer uses to
// pre-select a brand (firetvir.js, previously by parsing wlr-randr's output).
const fs = require("fs");
const path = require("path");

// The connected panel's EDID, from the first DRM connector that has one. A box
// with no EDID (a set that answered nothing) simply gets no answer.
function read(sysfs = "/sys/class/drm") {
  let dirs;
  try {
    dirs = fs.readdirSync(sysfs).filter((d) => d.includes("-HDMI-") || d.includes("-DP-"));
  } catch (e) {
    return null; // no DRM in sight (a container, a test host)
  }
  for (const d of dirs) {
    try {
      const buf = fs.readFileSync(path.join(sysfs, d, "edid"));
      if (buf && buf.length >= 128) return buf;
    } catch (e) {
      /* connector with nothing plugged in */
    }
  }
  return null;
}

// CTA-861 extension blocks. Both are needed before a set can be asked for PQ: the
// colorimetry block says it accepts BT2020, the HDR static metadata block says it
// accepts the PQ transfer function.
//
// Layout: byte 0 of an extension is the tag (0x02 = CTA-861), byte 2 is where the
// DTDs start, and the data blocks live between byte 4 and there. Each block starts
// with a byte of (tag << 5 | length); tag 7 is "extended", and then the next byte
// says which extended block it is - 5 for colorimetry, 6 for HDR static metadata.
function hdr(edid) {
  const out = { bt2020: false, pq: false };
  if (!edid || edid.length < 128) return out;
  for (let off = 128; off + 128 <= edid.length; off += 128) {
    if (edid[off] !== 0x02) continue;
    const end = edid[off + 2];
    if (end <= 4) continue;
    let i = off + 4;
    while (i < off + end && i < off + 128) {
      const tag = edid[i] >> 5;
      const len = edid[i] & 0x1f;
      if (len === 0) break;
      if (tag === 7 && len >= 2) {
        const ext = edid[i + 1];
        // Colorimetry: byte 3 of the block, bits 5-7 are BT2020 cYCC/YCC/RGB.
        if (ext === 5 && len >= 3) {
          if ((edid[i + 2] & 0xe0) !== 0) out.bt2020 = true;
        }
        // HDR static metadata: byte 3 is the supported EOTFs, bit 2 is ST2084 PQ.
        if (ext === 6 && len >= 3) {
          if ((edid[i + 2] & 0x04) !== 0) out.pq = true;
        }
      }
      i += len + 1;
    }
  }
  return out;
}

// The manufacturer's PNP id: bytes 8-9, three five-bit letters, big-endian, with
// the top bit reserved. LG reads as "GSM", which is why the caller needs a table
// rather than a substring match.
function manufacturer(edid) {
  if (!edid || edid.length < 128) return null;
  const word = (edid[8] << 8) | edid[9];
  const letter = (shift) => String.fromCharCode(64 + ((word >> shift) & 0x1f));
  const id = letter(10) + letter(5) + letter(0);
  return /^[A-Z]{3}$/.test(id) ? id : null;
}

// The name the set calls itself, from the display-descriptor block tagged 0xFC.
// Free text, so it is what a human would recognise ("LG TV") and not a model code.
function name(edid) {
  if (!edid || edid.length < 128) return null;
  for (let off = 54; off + 18 <= 126; off += 18) {
    // A descriptor whose first two bytes are zero is not a timing; byte 3 is its tag.
    if (edid[off] !== 0 || edid[off + 1] !== 0 || edid[off + 3] !== 0xfc) continue;
    const text = edid
      .slice(off + 5, off + 18)
      .toString("latin1")
      .split("\n")[0]
      .trim();
    if (text) return text;
  }
  return null;
}

module.exports = { read, hdr, manufacturer, name };
