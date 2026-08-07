import { type ReactNode } from "react";

// Category and status glyphs, drawn on one grid with one stroke weight so the rail
// reads as a set. Inline SVG rather than an icon font or emoji: the box's Chromium
// has no colour-emoji font and renders tofu (hard rule 4).
const svg = (paths: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-full h-full"
    aria-hidden="true"
  >
    {paths}
  </svg>
);

export const icons = {
  network: svg(
    <>
      <path d="M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </>,
  ),
  av: svg(
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>,
  ),
  peripherals: svg(
    <>
      <rect x="8.5" y="2.5" width="7" height="19" rx="3" />
      <circle cx="12" cy="7" r="1.1" fill="currentColor" stroke="none" />
      <path d="M10.5 12h3M12 15v3" />
    </>,
  ),
  apps: svg(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.4" />
      <rect x="14" y="3" width="7" height="7" rx="1.4" />
      <rect x="3" y="14" width="7" height="7" rx="1.4" />
      <rect x="14" y="14" width="7" height="7" rx="1.4" />
    </>,
  ),
  ambient: svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5-5-6 6" />
    </>,
  ),
  system: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>,
  ),
  about: svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </>,
  ),
  wifi: svg(
    <>
      <path d="M3 10a13 13 0 0 1 18 0M6.5 13.5a8 8 0 0 1 11 0" />
      <circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </>,
  ),
  ethernet: svg(
    <>
      <rect x="3" y="9" width="18" height="10" rx="1.5" />
      <path d="M7 9V6h10v3M9 19v2M15 19v2M12 19v2" />
    </>,
  ),
  lock: svg(
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>,
  ),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  keyboard: svg(
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </>,
  ),
  mouse: svg(
    <>
      <rect x="6" y="3" width="12" height="18" rx="6" />
      <path d="M12 7v4" />
    </>,
  ),
  speaker: svg(
    <>
      <rect x="7" y="3" width="10" height="18" rx="3" />
      <circle cx="12" cy="15" r="3" />
      <path d="M12 7h.01" />
    </>,
  ),
  bluetooth: svg(<path d="M7 7l10 10-5 4V3l5 4L7 17" />),
};

// What kind of thing a Bluetooth device is, as the box reported it. A name alone is
// often useless ("BT5.0"), and what you do next depends on the answer.
export function btGlyph(type: string) {
  if (type === "keyboard") return icons.keyboard;
  if (type === "mouse") return icons.mouse;
  if (type === "audio") return icons.speaker;
  return icons.bluetooth;
}
