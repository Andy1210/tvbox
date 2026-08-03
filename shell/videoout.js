// Which mpv video output a given stream should be presented with.
//
// `gpu` renders every frame on the GPU. On a Pi 5 that is a full 4K pass by
// itself, and the compositor needs a second one for as long as ANY window sits
// over the video - which is always, because the app's UI is a fullscreen
// transparent window above mpv. The two passes together miss vblank: at 4K the
// player drops ~17 frames a second (75%) with the decoder idle at zero. Removing
// either pass fixes it, and only one of them is ours to remove.
//
// `dmabuf-wayland` is that removal: the decoded frame goes to the compositor
// untouched, so mpv does no GPU work at all and the composite pass has the GPU to
// itself. It has two hard limits. It can only carry frames the decoder produced in
// hardware (a software-decoded stream fails at the hwupload with no picture), and
// because it processes nothing it also tone-maps nothing, so HDR reaches the panel
// as raw PQ. So it is used exactly where the GPU renderer cannot keep up and not
// one case wider: fullscreen, hardware-decoded, 4K-class video. PiP is excluded on
// top of that - it runs under XWayland, where this output does not exist.
const ZERO_COPY_VO = "dmabuf-wayland";

// Below this the GPU renderer keeps up (the output mode follows the content, so a
// 1080p film is composited at 1080p) and its tone mapping is worth having.
const ZERO_COPY_MIN_HEIGHT = 1440;

// Video this output could serve if the decoder cooperates - resolution and window
// alone, before anything is known about the decoder.
function zeroCopyCandidate(content, pip) {
  return !pip && !!content && Number(content.height) >= ZERO_COPY_MIN_HEIGHT;
}

// mpv answers hwdec-current with "property unavailable" until the decoder has
// really started (~0.7s after a paused start), and "no" once it has settled on
// software decoding. Only the unavailable answer is worth waiting for, and only
// for video whose renderer it decides.
function hwdecPending(content, pip) {
  return zeroCopyCandidate(content, pip) && !content.hwdec;
}

function zeroCopyVideo(content, pip) {
  if (!zeroCopyCandidate(content, pip)) return false;
  const hwdec = content.hwdec;
  return !!hwdec && hwdec !== "no";
}

module.exports = { ZERO_COPY_VO, ZERO_COPY_MIN_HEIGHT, zeroCopyCandidate, hwdecPending, zeroCopyVideo };
