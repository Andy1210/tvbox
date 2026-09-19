import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { fetchStorageStatus } from "../lib/storage";

// "This box cannot write to its card any more."
//
// When an SD card fails, ext4 forces the filesystem read-only and the box keeps
// running out of the page cache for a while: the launcher is up, the remote works,
// tiles still draw. Then it dies one piece at a time and ends on a black screen,
// with nothing on the way having said why - the shell's own log cannot be written
// either. Measured on a box here: eight minutes between the card going and the
// screen, all of them spent looking normal.
//
// Those minutes are the only chance to tell the person in the room, so this says
// it and then stays said: the condition does not clear without a restart, and a
// banner that fades is one nobody saw. Renders no focusable element, so it cannot
// steal spatial-nav focus (cf. InstallWatcher, RestoreWatcher).
//
// Because it never goes away it must not stand where anything else does, and that
// turned out to rule out most of the screen. The top belongs to NotificationToast,
// and a permanent panel there would silence every note for the rest of the box's
// uptime - crash-restart notices above all, which is exactly what a failing card
// produces. The band a few vh up from the bottom is where the centred panels and
// the tails of the settings lists live. What is left is the edge itself, which is
// why this is a strip rather than a card.
//
// One limit it shares with every structured note the shell raises (`crashRestart`,
// `lowBattery`): the launcher's window is BEHIND a fullscreen app, so a person
// watching a film does not see this until they come back to the launcher. The
// overlay strip that can draw over an app takes finished text, and the sentence
// lives here rather than in the shell, which has no locale of its own. Same reason
// those notes are drawn here too.
//
// Slow poll: this is a once-in-the-life-of-a-card event, and the read is free on
// the shell side, so a minute is soon enough to catch the window and rare enough
// to cost nothing.
const POLL_MS = 60000;

export function StorageWatcher() {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const s = await fetchStorageStatus();
      if (!alive) return;
      // Only a definite `true` shows anything. A box that cannot answer - an old
      // shell, a request that failed - is not a box with a broken card, and
      // saying so would be the same mistake in the other direction.
      if (s && s.readOnly) setFailed(true);
      timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!failed) return null;

  return (
    // A strip along the very bottom edge, not a panel floating in the content.
    // Measured at 1360x768: at `bottom-[18vh]` it covered PowerMenu's Cancel
    // button outright - the menu this banner's own text sends the person to - and
    // the free-space row in Settings -> About, which is the first thing anyone
    // checks after being told the card failed. The band 18vh up from the bottom is
    // where this app's centred panels and list tails live; the last few vh are not.
    //
    // Above everything rather than tied for a z with the panels it used to lose
    // to: at this edge it covers none of their controls, and a box that cannot
    // write is a fact that outranks whatever is open in front of it.
    <div
      className={[
        // 4.9vh tall, measured in a browser at 1360x768 and 3840x2160 in both
        // languages: one line, and clear of the ambient clock block anchored 8vh
        // up. The padding is deliberately tight - Settings -> About's last row
        // ends within a couple of pixels of this edge on the small panel.
        "fixed inset-x-0 bottom-0 z-[80] px-[2.4vw] py-[0.9vh]",
        "bg-[rgba(70,20,20,0.97)] border-t-[0.3vh] border-[rgba(255,130,120,0.5)]",
        "shadow-[0_-0.6vh_2vh_rgba(0,0,0,0.45)]",
      ].join(" ")}
      role="alert"
      aria-live="assertive"
    >
      {/* One flowing line so the strip stays short enough to clear the ambient
          screen's clock block, which is anchored 8vh up. white/80 for the detail
          rather than the fg-dim token: that one is a blue-grey chosen against the
          dark UI background, and it is barely legible on this red. */}
      <p className="mx-auto max-w-[92vw] text-center text-[1.7vh] leading-[1.45]">
        <span className="font-semibold">{t("storage.failed.title")}</span>{" "}
        <span className="text-white/80">{t("storage.failed.detail")}</span>
      </p>
    </div>
  );
}
