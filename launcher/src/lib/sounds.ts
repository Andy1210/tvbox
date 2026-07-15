// Navigation sounds (Fire TV-style focus ticks), synthesized with WebAudio so
// no audio assets ship. One shared AudioContext, created lazily on the first
// keypress (Chromium's autoplay policy allows it then); volumes deliberately
// low - this is a living-room device. Toggle: Settings > Picture & sound
// (config ui.navSounds); setSoundsEnabled is fed from the config store.
let ctx: AudioContext | null = null;
let enabled = true;
let suppressed = false; // screensaver up: the wake keypress is swallowed, don't tick it

export function setSoundsEnabled(on: boolean) {
  enabled = on;
}
export function setSoundsSuppressed(on: boolean) {
  suppressed = on;
}

function beep(freq: number, dur: number, peak: number) {
  if (!enabled || suppressed) return;
  try {
    ctx = ctx || new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  } catch {
    /* audio is best-effort - never let a sound break navigation */
  }
}

export const tickMove = () => beep(2600, 0.045, 0.05);
export const tickSelect = () => beep(1300, 0.09, 0.08);

// One global capture listener: arrows tick "move", Enter ticks "select". The
// D-pad is the only input surface, so key-level hooking beats instrumenting
// every focusable component - and it stays in sync with what the user FELT
// (a keypress), not what the focus engine did.
const MOVE = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
export function installNavSounds(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (MOVE.has(e.key)) tickMove();
    else if (e.key === "Enter") tickSelect();
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
