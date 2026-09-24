// Routes the default audio sink before anything plays: audio-default.sh detects
// the present HDMI sink (or applies the one picked in Settings) and prints its
// node.name, which mpv needs as an explicit --audio-device.
//
// A player launch passes { launch: true }, and only a launch is ever dropped: one
// that something newer overtook while the script ran (a later launch, or any stop
// of the player: a Stop, Home, the TV going to standby). Every other caller, boot
// and the settings route included, always gets its callback.
"use strict";

function create(deps) {
  let sink = null;
  let launchSeq = 0;
  function ensure(done, opts) {
    const launch = !!(opts && opts.launch);
    const seq = launch ? ++launchSeq : 0;
    const stops = deps.stopCount();
    const finish = () => {
      if (launch && (seq !== launchSeq || stops !== deps.stopCount())) {
        deps.log("[audio] launch superseded, dropped");
        return;
      }
      if (done) done();
    };
    try {
      deps.run(deps.preferredSink() || "", (stdout) => {
        const name = ((stdout || "").trim().split("\n").pop() || "").trim();
        if (name) sink = name;
        finish();
      });
    } catch (e) {
      finish();
    }
  }
  return { ensure, sink: () => sink };
}

module.exports = { create };
