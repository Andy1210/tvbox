import { create } from "zustand";
import {
  fetchConfig,
  saveIptv,
  saveParental,
  saveAmbient,
  saveUpdate,
  type IptvInput,
  type AmbientInput,
  type PublicConfig,
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
  setParental: (p: { pin?: string; lockedGroups?: string[] }) => Promise<void>;
  setAmbient: (ambient: AmbientInput) => Promise<void>;
  setUpdate: (update: { auto: boolean }) => Promise<void>;
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
}));
