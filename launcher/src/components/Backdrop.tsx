// Ambient backdrop behind every launcher view. One static element on purpose:
// it used to be five stacked layers, two drifting and one tinted by the focused
// tile, which kept the Pi's compositor busy at 60 fps forever. Hidden while
// html.tvbox-video is on so it can never paint over mpv.
export function Backdrop() {
  return <div className="tv-backdrop" aria-hidden="true" />;
}
