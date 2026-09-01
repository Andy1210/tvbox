/**
 * Which focusable a press on HOME lands on.
 *
 * HOME is a stack of rows - the header, the plugin widgets, the running apps,
 * the app rail - and geometry cannot see that. The header buttons sit at the
 * right edge, so Up from a tile on the right of the rail reached the settings
 * gear and passed over the running apps, a row closer; the running row is
 * chip-plus-quit-button pairs, so a press that did reach it landed on a quit
 * button as often as on the app it belongs to; and because spatial navigation
 * needs no orthogonal overlap for a horizontal press, the header is a legal
 * "right" from the end of any row below it.
 *
 * So the rows are declared, a vertical press steps to the next one that has a
 * registered focusable in it, and a horizontal press that runs off the end of a
 * row goes round inside it rather than leaving it.
 */
export interface HomeRow {
  /**
   * What this row is called, for the cursor it remembers.
   *
   * A row is re-entered where it was left, so Up undoes Down: coming back to a
   * row at its first item is a highlight jumping several places for a reason
   * nothing on screen explains. A row with no name remembers nothing, which is
   * what the header wants - arriving there should always be the settings gear
   * rather than the power button, whichever was pressed last.
   */
  name: string;
  /** Every key in the row, left to right. This is what locates the cursor. */
  keys: readonly string[];
  /**
   * The keys a press may LAND on, left to right.
   *
   * The running row's quit buttons are in `keys` but not here: a row is never
   * entered at the control that quits an app, and a wrap must not put the
   * cursor there either. Right from a chip still reaches its own quit button,
   * which is how one is meant to be reached.
   */
  entries: readonly string[];
}

/** Where each named row was last left. Module state: one launcher session is one
 *  HOME, and nothing in the app clears it. */
const entered = new Map<string, string>();

/** Record where a row was left. Called as the cursor lands, not as it leaves. */
export function rememberRow(name: string, key: string): void {
  if (name) entered.set(name, key);
}

/** Forget every row. Nothing in the app calls this; a test does, because module
 *  state outlives one render. */
export function forgetRows(): void {
  entered.clear();
}

/** Where a row was left, for the two places that place the cursor without a
 *  press: the screen's own first focus, and the landing after a quit. */
export function enteredIn(name: string): string | undefined {
  return entered.get(name);
}

/**
 * Where this row wants to be entered.
 *
 * `exists` decides, because a row can name a focusable that is not on the
 * screen - a widget whose app was uninstalled is still in the widget list until
 * the next fetch answers - and aiming at one swallows the press: the cursor
 * goes nowhere and stays where it was, with the move already refused.
 */
function entryOf(row: HomeRow, exists: (key: string) => boolean): string | null {
  const held = entered.get(row.name);
  if (held && row.entries.includes(held) && exists(held)) return held;
  return row.entries.find(exists) ?? null;
}

/** The row above or below, entered where it was left. Null at the top and the
 *  bottom of the screen, and for a key that is on no row - a modal's own
 *  button - which is the caller's cue to hand the press back to geometry. */
export function homeRowTarget(
  rows: readonly HomeRow[],
  from: string,
  dir: "up" | "down",
  exists: (key: string) => boolean,
): string | null {
  const at = rows.findIndex((row) => row.keys.includes(from));
  if (at < 0) return null;
  const step = dir === "up" ? -1 : 1;
  for (let i = at + step; i >= 0 && i < rows.length; i += step) {
    const target = entryOf(rows[i], exists);
    if (target) return target;
  }
  return null;
}

/**
 * A horizontal press at the end of a row.
 *
 * A rail on a television is a ring, which is what the poster rows in the media
 * app decided too: with no candidate past the end, spatial navigation asks the
 * container and what it does there is not a boundary, it is whatever was
 * focused last somewhere else on the screen - or, on HOME, the header sitting
 * above and to the right of everything.
 *
 * Returns the key to go round to; `null` when there is nowhere to go and the
 * press belongs to the row anyway (a row of one); `undefined` when this is not
 * an end at all, and geometry should move inside the row as it always has.
 */
export function homeRowEnd(
  rows: readonly HomeRow[],
  from: string,
  dir: "left" | "right",
  exists: (key: string) => boolean,
): string | null | undefined {
  const row = rows.find((r) => r.keys.includes(from));
  if (!row) return undefined;
  const at = row.keys.indexOf(from);
  if (dir === "left" ? at !== 0 : at !== row.keys.length - 1) return undefined;
  const targets = row.keys.filter((key) => row.entries.includes(key) && exists(key));
  const to = dir === "left" ? targets[targets.length - 1] : targets[0];
  return to && to !== from ? to : null;
}
