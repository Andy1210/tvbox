// HDR output: on for the film, off for everything else.
//
// The box hands a PQ video buffer straight to a display plane, and the TV will
// switch into HDR for it - but only if the output is in the matching colour space.
// Putting it there is not free: the colour space covers the WHOLE output, so
// everything else on screen is then sRGB content in a PQ frame, and the compositor
// cannot convert it (its renderer has no colour transform). Nothing compares
// colour spaces on the scan-out path, which makes this module's promise
// load-bearing:
//
//   the output is in a colour space only while content in that space is playing.
//
// So HDR is claimed for a PQ film that goes to the plane, and released when it
// ends. Neither "always on" nor "always off" works: an SDR film on a PQ output
// and a PQ film on an SDR output both lose the plane path, and with it 4K.
const fs = require("fs");
const path = require("path");
const compositor = require("./compositor");

// CTA-861 extension blocks in an EDID. Both blocks are needed before a set can be
// asked for PQ: the colorimetry block says it accepts BT2020, the HDR static
// metadata block says it accepts the PQ transfer function.
//
// Layout: byte 0 of an extension is the tag (0x02 = CTA-861), byte 2 is where the
// DTDs start, and the data blocks live between byte 4 and there. Each block starts
// with a byte of (tag << 5 | length); tag 7 is "extended", and then the next byte
// says which extended block it is - 5 for colorimetry, 6 for HDR static metadata.
function parseEdidHdr(edid) {
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

// The connected panel's EDID, from the first DRM connector that has one. A box
// with no EDID (a set that answered nothing) simply gets no HDR.
function readPanelEdid(sysfs = "/sys/class/drm") {
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

function panelSupportsHdr(sysfs) {
  const caps = parseEdidHdr(readPanelEdid(sysfs));
  return caps.bt2020 && caps.pq;
}

// Whether this stream should put the output in PQ. Only content that is PQ, and
// only when it reaches the plane untouched: below the zero-copy threshold mpv
// renders and tone-maps the frame itself, so the output must stay SDR or the
// picture would be tone-mapped twice.
function wants(content, zeroCopy, panelHdr) {
  return !!panelHdr && !!zeroCopy && !!content && content.gamma === "pq";
}

// video-params/gamma has the same late-property race as hwdec-current: mpv answers
// "property unavailable" for the first moments after a paused start. It decides the
// output's colour space, so it is worth a few more reads - but only where the answer
// changes anything, which is the zero-copy path.
function gammaPending(content, candidate) {
  return !!candidate && !!content && !content.gamma;
}

// Claim the output's colour space, or give it back. The compositor holds the
// claim; this module is the shell saying what is on screen.
//
// The output name is asked for rather than assumed: there is one connector on this
// box, but its name is the driver's business.
function claim(on, cb) {
  const next = cb || (() => {});
  compositor.list((info) => {
    if (!info || !info.output) return next(false, "no output");
    if (info.hdr && info.hdr.supported === false) return next(false, "this connector has no HDR properties");
    compositor.setHdr(info.output, on, next);
  });
}

module.exports = { parseEdidHdr, readPanelEdid, panelSupportsHdr, wants, gammaPending, claim };
