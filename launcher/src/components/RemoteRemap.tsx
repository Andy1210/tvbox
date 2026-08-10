import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { RemotePower } from "@sdk/config";
import { useI18n } from "../lib/i18n";
import { useConfigStore } from "../stores/config";
import { fetchRemoteDevices, fetchFinderCapable, findRemote, type ConnectedRemote } from "../lib/remote";
import { fetchProgrammableRemotes } from "../lib/firetvir";
import { FocusButton } from "./FocusButton";
import { RemoteKeymapPage, keyBase } from "./RemoteKeymap";
import { useSettingsNav } from "../settings/nav";
import { FiretvIrPage } from "../settings/pages/firetvir";

// Settings -> Remotes & accessories -> Remote buttons. The remotes the bridge can
// see; pressing one opens what that remote offers.
//
// It is a MENU, not the settings themselves. Everything a remote can be asked for
// used to hang directly off its row, and the button map alone is every navigation
// action plus one row per installed app - around twenty-five rows, which buried
// ringing the remote and its IR blaster below a long scroll on a screen driven by
// a D-pad. Each of the three is its own page now.
const keyOf = keyBase;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"w-[2.4vh] h-[2.4vh] shrink-0 opacity-60 transition-transform " + (open ? "rotate-90" : "")}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-[2.2vh] h-[2.2vh] shrink-0 text-accent"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

const POWER_OPTS: RemotePower[] = ["tv", "tv_and_box", "ignore"];

// Which remote's menu was open, remembered across an unmount: every entry here is a
// pushed page now, and a push unmounts this screen - so a plain useState would bring
// the user back to a collapsed list with the row they came from gone, and with it
// the focus the settings stack recorded to return to.
let lastExpanded: string | null = null;

export function RemoteRemap() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const config = useConfigStore((s) => s.config);
  const setRemotePower = useConfigStore((s) => s.setRemotePower);
  const saved = config?.remote?.devices || {};
  const power: RemotePower = config?.remote?.power || "tv";

  // null = first poll still in flight (renders nothing), [] = really no remotes -
  // so the "none connected" copy can't flash before the list arrives
  const [devices, setDevices] = useState<ConnectedRemote[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(lastExpanded);
  useEffect(() => {
    lastExpanded = expanded;
  }, [expanded]);

  // MACs of connected remotes that are programmable Fire TV / Alexa remotes (expose
  // the keymap GATT service). Only these get the "TV IR" row, so a non-Fire-TV
  // remote's menu stays clean.
  const [ftirMacs, setFtirMacs] = useState<string[]>([]);
  useEffect(() => {
    fetchProgrammableRemotes().then(setFtirMacs);
  }, []);
  // Remotes with a buzzer, and which one is ringing. `ringing` is tracked so the row
  // can turn into a stop - a ring that only the shell's timer ends would leave the
  // user holding a beeping remote with no way to silence it.
  const [finderMacs, setFinderMacs] = useState<string[]>([]);
  const [ringing, setRinging] = useState<string | null>(null);
  useEffect(() => {
    fetchFinderCapable().then((f) => {
      setFinderMacs(f.macs);
      setRinging(f.ringing);
    });
  }, []);
  // Keep asking while this screen is up: the shell stops a ring by itself after a
  // minute, and MQTT or the phone can start one behind our back - so the poll has to
  // run even when we believe nothing is ringing, just more slowly. The shell caches
  // the capability answer for 8 s, so the idle rate costs nothing.
  useEffect(() => {
    const tick = () =>
      fetchFinderCapable().then((f) => {
        // Both halves: a remote that connects while this screen is open would
        // otherwise never get its row until the user left and came back.
        setFinderMacs(f.macs);
        setRinging(f.ringing);
      });
    const t = setInterval(tick, ringing ? 3000 : 10000);
    return () => clearInterval(t);
  }, [ringing]);

  // Poll connected remotes (hotplug; only presence + names are used from it, the
  // keymap count comes from the config store which updates instantly). Nothing here
  // needs pausing any more: the learn flow lives on a page above this one, and a
  // push unmounts this component along with its timers.
  useEffect(() => {
    let alive = true;
    const tick = () => fetchRemoteDevices().then((d) => alive && setDevices(d));
    tick();
    const iv = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const toggle = (id: string) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next) setTimeout(() => setFocus(keyOf(id) + "-keys"), 0);
  };

  return (
    <div className="mt-[4vh]">
      {devices !== null && !devices.length && <div className="text-[1.9vh] text-fg-dim">{t("remote.none")}</div>}
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {(devices ?? []).map((d) => {
          const custom = Object.keys(saved[d.id]?.keymap || {}).length;
          const open = expanded === d.id;
          return (
            <div key={d.id}>
              <FocusButton
                focusKey={keyOf(d.id) + "-dev"}
                onEnter={() => toggle(d.id)}
                className="px-[2vw] py-[1.6vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
              >
                <span className="text-[2.1vh] flex-1 text-left truncate">{d.name}</span>
                {custom > 0 && (
                  <span className="text-[1.7vh] text-accent shrink-0">{t("remote.customCount", { n: custom })}</span>
                )}
                <Chevron open={open} />
              </FocusButton>
              {open && (
                <div className="flex flex-col gap-[0.8vh] mt-[0.8vh] mb-[1.4vh] pl-[2vw]">
                  {/* The button map: its own page, and the reason this row exists. */}
                  <FocusButton
                    focusKey={keyOf(d.id) + "-keys"}
                    onEnter={() =>
                      nav.push({
                        id: "remote-keys-" + d.id,
                        title: d.name,
                        render: () => <RemoteKeymapPage device={{ id: d.id, name: d.name }} />,
                      })
                    }
                    className="px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
                  >
                    <span className="text-[2vh] flex-1 text-left truncate">{t("remote.keysEntry")}</span>
                    <span className="text-[1.7vh] text-fg-dim shrink-0">
                      {custom > 0 ? t("remote.customCount", { n: custom }) : t("remote.allDefault")}
                    </span>
                    <Chevron open={false} />
                  </FocusButton>

                  {/* Make this remote ring, for the remote that has a buzzer. Shown
                      only for those - and it is here as well as on the phone and over
                      MQTT, because the remote you are looking for is the one you
                      cannot press a button on. */}
                  {finderMacs.includes(d.id.toLowerCase()) && (
                    <FocusButton
                      focusKey={keyOf(d.id) + "-find"}
                      onEnter={() => {
                        // The box's answer decides the label, not the press: a start
                        // that fails must not leave a "stop" the user can only press
                        // to no effect.
                        const on = ringing !== d.id.toLowerCase();
                        findRemote(d.id, on).then(setRinging);
                      }}
                      className="px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
                    >
                      <span className="text-[2vh] flex-1 text-left truncate">
                        {ringing === d.id.toLowerCase() ? t("remote.findStop") : t("remote.find")}
                      </span>
                    </FocusButton>
                  )}

                  {/* Fire TV / Alexa remote: teach its OWN IR blaster the TV's
                      volume/mute/power. Shown ONLY for remotes that expose the keymap
                      service, so other remotes don't see it. */}
                  {ftirMacs.includes(d.id.toLowerCase()) && (
                    <FocusButton
                      focusKey={keyOf(d.id) + "-firetvir"}
                      onEnter={() =>
                        nav.push({
                          id: "ftir-" + d.id,
                          title: t("firetvir.title"),
                          render: () => <FiretvIrPage device={{ id: d.id, name: d.name }} />,
                        })
                      }
                      className="px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
                    >
                      <span className="text-[2vh] flex-1 text-left truncate">{t("firetvir.entry")}</span>
                      <Chevron open={false} />
                    </FocusButton>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Power button policy (global, not per-device). The bridge always intercepts
          KEY_POWER so it can never power off the box unintentionally. */}
      <div className="mt-[3.5vh]">
        <div className="text-[2.1vh] font-semibold mb-[0.8vh]">{t("remote.powerTitle")}</div>
        <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
          {POWER_OPTS.map((v) => (
            <FocusButton
              key={v}
              focusKey={"remote-power-" + v}
              onEnter={() => setRemotePower(v)}
              className="px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
            >
              <span className="text-[2vh] flex-1 text-left truncate">{t("remote.power." + v)}</span>
              {power === v && <Check />}
            </FocusButton>
          ))}
        </div>
        {power === "tv_and_box" && (
          <div className="text-[1.7vh] text-warn mt-[0.9vh] max-w-[64vw]">{t("remote.powerWarn")}</div>
        )}
      </div>
    </div>
  );
}
