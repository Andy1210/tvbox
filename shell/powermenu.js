// The power menu from HOME, and the sleep timer behind it.
//
// sleep = display off over CEC (the box keeps running; wake by turning the TV on).
//
// reboot/poweroff run as the session user, and the thing that makes that work is
// a polkit rule provision.sh installs - NOT logind's own "an active local session
// may shut down" default. The shell is not such a session: Electron moves its main
// process into its own systemd app scope, so `loginctl` knows nothing about it and
// `subject.active` is false. Same trap the udisks and miracast grants document.
//
// `--no-ask-password` is what keeps a missing grant survivable, and it is
// load-bearing rather than tidy. Without it systemctl answers polkit's
// "interactive authentication required" by spawning **pkttyagent**, which reads a
// controlling terminal; a background process group that reads a terminal is sent
// SIGTTIN, and SIGTTIN stops THE WHOLE GROUP - Electron and session.sh, the
// respawn loop, together. The box then looks bricked: the remote does nothing,
// the HTTP port is dead, and `pkill` cannot fix it because the loop that would
// respawn the shell is stopped too (recovery is `kill -CONT` on session.sh). With
// the flag, systemctl simply fails and the sudo fallback below does the reboot.
//
// On reboot/poweroff the box goes down, so the JSON response may never reach the
// client - that's fine.
const { execFile: realExecFile } = require("child_process");

const MAX_SLEEP_MINUTES = 24 * 60;

let deps = {
  execFile: realExecFile,
  jsonRes: () => {},
  // Denies, like every other default here: with no wiring, the screensaver's
  // auto-sleep stands down rather than turning the television off mid-film.
  boxIdle: () => false,
  showLauncher: () => {},
  stopPlayback: () => {}, // player.setPlaying(null) + stop + setVideoMode(false)
  cecPower: () => {},
};

function init(d) {
  deps = { ...deps, ...d };
}

// User-set sleep timer ("turn the TV off in N minutes") - unconditional by
// design (the user explicitly asked for it), unlike the screensaver auto-sleep.
let sleepTimerAt = null;
let sleepTimerId = null;

const sleepTimer = () => sleepTimerAt;

function setSleepTimer(minutes) {
  if (sleepTimerId) clearTimeout(sleepTimerId);
  sleepTimerId = null;
  sleepTimerAt = null;
  const min = Number(minutes);
  if (Number.isFinite(min) && min > 0 && min <= MAX_SLEEP_MINUTES) {
    sleepTimerAt = Date.now() + min * 60 * 1000;
    sleepTimerId = setTimeout(
      () => {
        sleepTimerId = null;
        sleepTimerAt = null;
        console.log("[power] sleep timer fired");
        deps.showLauncher();
        deps.cecPower(false);
      },
      min * 60 * 1000,
    );
  }
  return { ok: true, at: sleepTimerAt };
}

function handlePower(action, res) {
  if (action === "sleep" || action === "sleep_if_idle") {
    // sleep_if_idle = the screensaver's auto-sleep: refuse while anything plays
    // (Spotify Connect streams with the launcher sitting idle on Home, so
    // "screensaver is up" does NOT imply "nothing is playing"). The power
    // menu's manual Sleep stays unconditional.
    if (action === "sleep_if_idle" && !deps.boxIdle()) return deps.jsonRes(res, { ok: true, slept: false });
    deps.showLauncher(); // leave any app, back to Home
    // Sleep means sleep. `showLauncher` deliberately lets sound outlive a screen
    // change, which is right for Home and wrong for this: measured, Power ->
    // Sleep turned the television off and left the album playing into a dark
    // room - inaudibly, since HDMI is this box's only sink - holding a server
    // session open and the box out of idle for as long as the queue lasted.
    deps.stopPlayback();
    deps.cecPower(false); // TV off via CEC
    return deps.jsonRes(res, { ok: true, slept: true });
  }
  const sub = action === "reboot" || action === "poweroff" ? action : null;
  if (!sub) return deps.jsonRes(res, { ok: false, error: "bad action" });
  console.log("[power]", sub);
  deps.execFile("systemctl", ["--no-ask-password", sub], { timeout: 8000 }, (e, _o, err) => {
    if (!e) return deps.jsonRes(res, { ok: true });
    // The flag rides along under sudo as well. It changes nothing while sudo
    // succeeds (root never consults polkit), and it is the difference between a
    // clean failure and a frozen session if it ever does not.
    deps.execFile("sudo", ["-n", "systemctl", "--no-ask-password", sub], { timeout: 8000 }, (e2, _o2, err2) => {
      deps.jsonRes(
        res,
        e2
          ? {
              ok: false,
              error: String(err2 || err || e.message || "")
                .trim()
                .slice(0, 120),
            }
          : { ok: true },
      );
    });
  });
}

module.exports = { init, setSleepTimer, sleepTimer, handlePower, MAX_SLEEP_MINUTES };
