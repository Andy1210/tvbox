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
    <div
      className={[
        "fixed left-1/2 -translate-x-1/2 top-[4vh] z-[70] w-[60vw] px-[2.4vw] py-[1.6vh] rounded-[1.2vh]",
        "bg-[rgba(70,20,20,0.96)] shadow-[0_1vh_3vh_rgba(0,0,0,0.5)]",
      ].join(" ")}
      role="alert"
      aria-live="assertive"
    >
      <div className="text-[2.2vh] font-semibold">{t("storage.failed.title")}</div>
      {/* white/80 rather than the fg-dim token: that one is a blue-grey chosen
          against the dark UI background, and it is barely legible on this red. */}
      <div className="mt-[0.6vh] text-[1.8vh] text-white/80">{t("storage.failed.detail")}</div>
    </div>
  );
}
