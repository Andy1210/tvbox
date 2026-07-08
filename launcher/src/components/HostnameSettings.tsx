import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { fetchSystemInfo, setHostname } from "../lib/system";
import { FocusButton } from "./FocusButton";
import { Osk } from "./Osk";

// Settings -> General: name this box so several boxes are easy to tell apart on
// the LAN. A row shows the current hostname; opening it brings up the on-screen
// keyboard. On a box whose image predates the hostname1 polkit grant the POST
// returns false - we keep the entered name on screen and show a "applies after
// the next update" note (mirrors the timezone/keyboard controls). The other way
// to set it is the boot-partition tvbox.conf (HOSTNAME=), see docs/config/.

// One RFC-1123 label: letters/digits/hyphen, no leading/trailing hyphen, <=63.
// Trim hyphens AFTER truncating (like the firstboot sanitiser), so a cut at 63
// can't leave a trailing hyphen the shell's setHostname validator would reject.
const clean = (v: string) =>
  v
    .replace(/[^A-Za-z0-9-]/g, "")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");

export function HostnameSettings() {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [deferred, setDeferred] = useState(false);

  useEffect(() => {
    fetchSystemInfo().then((i) => {
      if (i?.hostname) setName(i.hostname);
    });
  }, []);

  if (editing) {
    return (
      <Osk
        title={t("hostname.title")}
        initial={name}
        onDone={async (v) => {
          setEditing(false);
          setTimeout(() => setFocus("hostname-open"), 0);
          const next = clean(v);
          if (!next || next === name) return;
          setName(next); // reflect immediately, even if the POST is refused
          setDeferred(!(await setHostname(next)));
        }}
        onCancel={() => {
          setEditing(false);
          setTimeout(() => setFocus("hostname-open"), 0);
        }}
      />
    );
  }

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[0.6vh]">{t("hostname.title")}</div>
      <div className="text-[1.9vh] text-fg-dim mb-[1.4vh] max-w-[70vw]">{t("hostname.hint")}</div>
      {deferred && <div className="text-[1.9vh] text-[#e0b64a] mb-[1vh] max-w-[70vw]">{t("hostname.later")}</div>}
      <FocusButton
        focusKey="hostname-open"
        onEnter={() => setEditing(true)}
        className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw] max-w-[70vw]"
      >
        <span className="text-[2.1vh]">{t("hostname.name")}</span>
        <span className="text-[1.9vh] text-fg-dim tabular-nums">{name || "-"}</span>
      </FocusButton>
    </div>
  );
}
