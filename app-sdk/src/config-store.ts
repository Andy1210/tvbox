import { create } from "zustand";
import {
  fetchConfig,
  saveIptv,
  saveParental,
  saveAmbient,
  saveUpdate,
  saveRemote,
  saveRemotePower,
  type IptvInput,
  type AmbientInput,
  type PublicConfig,
  type RemoteDeviceConfig,
  type RemotePower,
  saveUi,
  type UiInput,
  savePlayer,
  type PlayerInput,
  saveWifi,
  saveMqtt,
  type MqttInput,
  saveIr,
  type IrInput,
} from "./config";

// Single source of truth for the shell config (IPTV source + parental lock +
// Home Assistant target + ambient/update). Loaded once and refreshed after
// writes, so components subscribe instead of each fetching on mount. Shared by
// the launcher (Settings) and app packages (e.g. Live TV reads config.iptv,
// writes it from its own settings) - every consumer hits the same /tvbox/api/config.
interface ConfigState {
  config: PublicConfig | null;
  error: boolean; // shell unreachable (config stays null) - the UI offers retry
  load: () => Promise<PublicConfig | null>;
  setIptv: (iptv: IptvInput) => Promise<void>;
  setParental: (p: { pin?: string; lockedGroups?: string[]; requirePin?: boolean }) => Promise<void>;
  setAmbient: (ambient: AmbientInput) => Promise<void>;
  setUpdate: (update: { auto?: boolean; appsAuto?: boolean }) => Promise<void>;
  setUi: (ui: UiInput) => Promise<void>;
  setPlayer: (player: PlayerInput) => Promise<void>;
  setWifi: (wifi: { country: string }) => Promise<void>;
  setMqtt: (mqtt: MqttInput) => Promise<void>;
  setIr: (ir: IrInput) => Promise<void>;
  setRemote: (devices: Record<string, RemoteDeviceConfig>) => Promise<void>;
  setRemotePower: (power: RemotePower) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set) => ({
  config: null,
  error: false,
  load: async () => {
    const c = await fetchConfig();
    if (c) set({ config: c, error: false });
    else set({ error: true });
    return c;
  },
  setIptv: async (iptv) => set({ config: await saveIptv(iptv) }),
  setParental: async (p) => set({ config: await saveParental(p) }),
  setAmbient: async (ambient) => set({ config: await saveAmbient(ambient) }),
  setUpdate: async (update) => set({ config: await saveUpdate(update) }),
  setUi: async (ui) => set({ config: await saveUi(ui) }),
  setPlayer: async (player) => set({ config: await savePlayer(player) }),
  setWifi: async (wifi) => set({ config: await saveWifi(wifi) }),
  setMqtt: async (mqtt) => set({ config: await saveMqtt(mqtt) }),
  setIr: async (ir) => set({ config: await saveIr(ir) }),
  setRemote: async (devices) => set({ config: await saveRemote(devices) }),
  setRemotePower: async (power) => set({ config: await saveRemotePower(power) }),
}));
