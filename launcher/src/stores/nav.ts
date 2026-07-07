import { create } from "zustand";

// Top-level launcher view: "home", "settings", "catalog" or "ambient". Apps are
// launched by the shell and replace the window, so they're not views here.
interface NavState {
  view: string;
  open: (view: string) => void;
  home: () => void;
}

export const useNavStore = create<NavState>((set) => ({
  view: "home",
  open: (view) => set({ view }),
  home: () => set({ view: "home" }),
}));
