// HDR output: on for the film, off for everything else.
//
// The box can hand a PQ video buffer straight to a display plane (the wlroots
// patches in scripts/patches/), and the TV will switch into HDR for it - but only
// if the output is in the matching colour space. Putting it there is not free:
// the colour space covers the WHOLE output, so everything else on screen is then
// sRGB content in a PQ frame, and the compositor cannot convert it (its renderer
// has no colour transform). The scan-out path is patched to trust this module's
// promise rather than compare colour spaces, which makes the promise load-bearing:
//
//   the output is in a colour space only while content in that space is playing.
//
// So HDR is claimed for a PQ film that goes to the plane, and released when it
// ends. Neither "always on" nor "always off" works: an SDR film on a PQ output
// and a PQ film on an SDR output both lose the plane path, and with it 4K.
const fs = require("fs");
const { execFile } = require("child_process");
const path = require("path");
const os = require("os");

const RC_XML = path.join(os.homedir(), ".config", "labwc", "rc.xml");

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
  let dirs = [];
  try {
    dirs = fs.readdirSync(sysfs).filter((d) => d.includes("-HDMI-") || d.includes("-DP-"));
  } catch (e) {
    return null;
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

// labwc reads <hdr> from rc.xml, and re-reads it on SIGHUP - but a re-read alone
// does not touch the output. What applies it is the next output reconfiguration,
// which is exactly what the display-mode claim does a moment later. So: write,
// signal, and let the mode change carry it.
function writeConfig(on, file = RC_XML) {
  const xml =
    '<?xml version="1.0"?>\n<labwc_config>\n  <core>\n    <hdr>' +
    (on ? "yes" : "no") +
    "</hdr>\n  </core>\n</labwc_config>\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch (e) {
    /* first write */
  }
  if (current === xml) return false;
  fs.writeFileSync(file, xml);
  return true;
}

// labwc re-reads rc.xml on SIGHUP, and that is only half the switch: a re-read
// does not touch the connector, the next output reconfiguration does. The caller
// follows this with the display-mode claim, which is that reconfiguration.
function reload(cb) {
  execFile("pkill", ["-HUP", "-x", "labwc"], () => cb && cb());
}

module.exports = { parseEdidHdr, readPanelEdid, panelSupportsHdr, wants, gammaPending, writeConfig, reload, RC_XML };
