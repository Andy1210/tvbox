// Ambient backdrop behind every launcher view: one continuous full-screen
// colour field (three huge overlapping glows blending diagonally), a wash
// tinted by the focused tile's accent (Tile.tsx sets --tile-accent), and a
// weak edge falloff. Pure CSS layers (index.css .tv-backdrop*) -
// transform-only animation so the Pi's compositor stays happy - and hidden
// entirely while html.tvbox-video is on so it can never paint over mpv.
export function Backdrop() {
  return (
    <div className="tv-backdrop" aria-hidden="true">
      <div className="tv-backdrop-glow tv-backdrop-a" />
      <div className="tv-backdrop-glow tv-backdrop-b" />
      <div className="tv-backdrop-glow tv-backdrop-c" />
      <div className="tv-backdrop-accent" />
      <div className="tv-backdrop-vignette" />
    </div>
  );
}
