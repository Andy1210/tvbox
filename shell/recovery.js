// The way back to HOME that does not go through the launcher's renderer.
//
// Every ordinary route home is a key that some renderer of ours has to receive:
// the launcher's own handler, an app window's before-input-event, a bridge's HTTP
// call that lands in a page. When the launcher's page is the part that is wrong -
// crashed, frozen, or showing HOME with a cursor on nothing - none of them can
// repair it, and a TV has no keyboard to do it with.
//
// So the compositor watches for the remote's Home key being HELD and runs
// ~/.tvbox/recover.sh (deploy/recover.sh), which signals this process. SIGUSR2 is
// "reload the launcher and bring it forward"; the harder stage, restarting the
// shell, needs nothing from us and is done by that script with SIGTERM.

/**
 * Reload the launcher page and put it on screen.
 *
 * `showLauncher` first: it ends whatever app or native program is in front and
 * raises the window, and a reload of a window that stays hidden repairs nothing
 * anyone can see. The reload also covers a renderer that has crashed, because
 * reloading a webContents whose renderer is gone starts a new one.
 *
 * With no launcher window left there is nothing to reload, and the respawn loop
 * in session.sh is the thing that makes a new one: exiting is the repair.
 */
function recover({
  getWindow,
  showLauncher,
  onDeliberateCrash,
  isUnresponsive,
  isStarted = () => true,
  exit = process.exit,
  log = console,
}) {
  // Before the launcher window exists the shell is still starting, and ending it
  // would cost one of the boot attempts an update is given; the hold is ignored.
  if (!isStarted()) {
    log.warn("[recovery] the shell is still starting - ignoring");
    return "ignored";
  }
  const win = getWindow();
  if (!win || win.isDestroyed()) {
    log.warn("[recovery] no launcher window - restarting the shell");
    exit(1);
    return "restart";
  }
  log.warn("[recovery] reloading the launcher");
  try {
    showLauncher();
  } catch (e) {
    log.warn("[recovery] showLauncher failed:", e && e.message);
  }
  try {
    // A renderer stuck in a loop never gets to run a reload it is sent, so it is
    // ended first; the reload below then starts a fresh one. main.js is told
    // first, so its crash-loop counter does not count the renderer this replaces
    // - and only then, so a real crash right after an ordinary reload still counts.
    if (isUnresponsive && isUnresponsive() && win.webContents.forcefullyCrashRenderer) {
      log.warn("[recovery] launcher renderer is unresponsive - ending it");
      if (onDeliberateCrash) {
        try {
          onDeliberateCrash();
        } catch (e) {}
      }
      win.webContents.forcefullyCrashRenderer();
    }
    win.webContents.reloadIgnoringCache();
  } catch (e) {
    log.warn("[recovery] reload failed - restarting the shell:", e && e.message);
    exit(1);
    return "restart";
  }
  return "reload";
}

/** Wire the signal. Returns the handler, for a test to call. */
function install(deps, proc = process) {
  const handler = () => recover(deps);
  proc.on("SIGUSR2", handler);
  return handler;
}

module.exports = { recover, install };
