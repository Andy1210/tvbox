// How a store source is named on screen. The owner's label if they gave one,
// otherwise the host: a full index.json URL does not fit a row, and the host is
// the part that says whose registry it is.
export function sourceLabel(
  s: { url: string; name?: string | null; official?: boolean },
  officialName?: string,
): string {
  if (s.name) return s.name;
  // The official catalogue by the name the rest of the UI gives it, not by its
  // host: "andy1210.github.io" on a button beside "dev" reads as somebody's
  // personal registry, which is the opposite of what it is.
  if (s.official && officialName) return officialName;
  try {
    return new URL(s.url).host;
  } catch {
    return s.url;
  }
}
