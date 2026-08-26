// The cards on the HOME screen.
//
// A service plugin (the only sanctioned background code) can put ONE card there -
// e.g. Spotify's now-playing while a cast is active. The plugin pushes state, the
// launcher renders it, Enter opens the app; renderer apps stay strictly
// foreground-only. Sanitized here; cleared on uninstall.
//
// The second kind is DERIVED rather than pushed: music outlives leaving an app, so
// an album can be playing with the launcher on screen and nothing there naming it.
// The app already reports what it is playing (that is what the house reads over
// MQTT), so nothing new is asked of it.
let deps = {
  // What the launcher hears. One place, because both a card change and a running-app
  // change reach it, and neither may throw at the caller.
  send: () => {},
  playerRunning: () => false,
  playerIsAudioOnly: () => false,
  playerOwner: () => null,
};

function init(d) {
  deps = { ...deps, ...d };
}

const widgets = new Map(); // appId -> { title, subtitle }

const TITLE_MAX = 120;
const SUBTITLE_MAX = 160;

function widgetList() {
  return [...widgets.entries()].map(([id, w]) => ({ id, ...w }));
}

function setWidget(appId, w) {
  const before = JSON.stringify(widgets.get(appId) || null);
  if (!w || typeof w !== "object" || (!w.title && !w.subtitle)) widgets.delete(appId);
  else
    widgets.set(appId, {
      title: String(w.title || "").slice(0, TITLE_MAX),
      subtitle: String(w.subtitle || "").slice(0, SUBTITLE_MAX),
    });
  // Only when it actually moved. The card is now decided on every player event,
  // i.e. once a second while anything plays, and pushing an unchanged list makes
  // the launcher rebuild HOME once a second behind a 4K film for nothing.
  if (JSON.stringify(widgets.get(appId) || null) === before) return;
  deps.send("widgets", widgetList());
}

/**
 * Tell HOME the set of running apps changed.
 *
 * It refetches on `visibilitychange`, which covers every way somebody STARTS an
 * app - they were looking at one when it happened. It does not cover an app that
 * goes on its own: the LRU cap and the memory guard drop a hidden window with
 * the launcher on screen the whole time, so HOME went on offering a Running row
 * for an app that had gone, and its ✕ did nothing.
 */
function appsChanged() {
  deps.send("apps-changed");
}

/**
 * The card an app gets on HOME while its sound is playing.
 *
 * The app id comes from the PLAYER, never from the payload. Every local app
 * shares one origin, so a posted `app` field is a claim any of them can make
 * about any other; `player.owner()` is the shell's own knowledge of who started
 * what is loaded.
 *
 * The launcher is deliberately excluded (its id is null): its own now-playing is
 * Live TV, and HOME is already where its card would point.
 *
 * Two things are load-bearing and were both wrong in the first cut:
 *
 * - **Who the card is about is remembered.** Every report that CLEARS a card
 *   arrives AFTER mpv has gone - stopping is what makes an app report itself
 *   idle - so asking the player at that moment answers nobody, and the card
 *   stayed on HOME for ever, naming something that had finished. A card is
 *   therefore addressed to the app it is already up for when the player has
 *   nothing to say.
 * - **Only sound gets one.** A film owns the screen; a card for it on the HOME
 *   behind it says nothing, and it was the commonest way to get a stale one.
 */
let soundCardFor = null;

function soundWidget(data) {
  const state = data && data.state;
  const sounding = (state === "playing" || state === "paused") && deps.playerRunning() && deps.playerIsAudioOnly();
  const owner = deps.playerRunning() ? deps.playerOwner() : soundCardFor;
  if (owner == null) return;
  if (!sounding) {
    setWidget(owner, null);
    if (soundCardFor === owner) soundCardFor = null;
    return;
  }
  soundCardFor = owner;
  setWidget(owner, {
    title: String((data && data.title) || ""),
    subtitle: String((data && data.artist) || ""),
  });
}

/** Take an app's card down, wherever the app went. */
function clearSoundWidget(id) {
  if (id == null) return;
  setWidget(id, null);
  if (soundCardFor === id) soundCardFor = null;
}

module.exports = { init, setWidget, widgetList, appsChanged, soundWidget, clearSoundWidget };
