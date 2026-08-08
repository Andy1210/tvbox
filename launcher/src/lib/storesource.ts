// How a store source is named on screen. The owner's label if they gave one,
// otherwise the host: a full index.json URL does not fit a row, and the host is
// the part that says whose registry it is.
export function sourceLabel(s: { url: string; name?: string | null }): string {
  if (s.name) return s.name;
  try {
    return new URL(s.url).host;
  } catch {
    return s.url;
  }
}
