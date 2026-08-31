/**
 * Which focusable a vertical press on HOME lands on.
 *
 * HOME is a stack of rows - the header, the plugin widgets, the running apps,
 * the app rail - and geometry cannot see that. The header buttons sit at the
 * right edge, so Up from a tile on the right of the rail reached the settings
 * gear and passed over the running apps, a row closer; and the running row is
 * chip-plus-quit-button pairs, so a press that did reach it landed on a quit
 * button as often as on the app it belongs to.
 *
 * So the rows are declared and a vertical press steps to the next one that has
 * a registered focusable in it. Horizontal movement stays geometry's: inside a
 * row it is right, and it is the only thing that reaches a quit button.
 */
export function homeRowTarget(
  /**
   * The rows, top to bottom, each in ENTRY-PREFERENCE order: the press lands on
   * the first key of the row that spatial navigation actually knows about, so a
   * row names the key it wants entered at first. Membership is what locates the
   * cursor, so every key of a row has to be in it, entered at or not.
   */
  rows: readonly (readonly string[])[],
  from: string,
  dir: "up" | "down",
  /**
   * Whether a key is registered. A row can name a focusable that is not on the
   * screen - a widget whose app was uninstalled is still in the widget list
   * until the next fetch answers - and aiming at one swallows the press: the
   * cursor goes nowhere and stays where it was, with the move already refused.
   */
  exists: (key: string) => boolean,
): string | null {
  const at = rows.findIndex((row) => row.includes(from));
  if (at < 0) return null; // not a HOME row: a modal's own button, say
  const step = dir === "up" ? -1 : 1;
  for (let i = at + step; i >= 0 && i < rows.length; i += step) {
    const target = rows[i].find(exists);
    if (target) return target;
  }
  return null; // the top or the bottom of the screen
}
