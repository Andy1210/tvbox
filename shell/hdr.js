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
const compositor = require("./compositor");
const edid = require("./edid");

// A set can only be asked for PQ if it said it accepts both BT2020 and the PQ
// transfer function.
function panelSupportsHdr(sysfs) {
  const caps = edid.hdr(edid.read(sysfs));
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

module.exports = { panelSupportsHdr, wants, gammaPending, claim };
