import { create } from "zustand";

// Top-level launcher view. Ambient is an idle overlay rendered on top of Home,
// not a view here; apps are launched by the shell and replace the window, so
// they aren't views either.
export type NavView = "home" | "settings" | "catalog";
interface NavState {
  view: NavView;
  open: (view: NavView) => void;
  home: () => void;
}

export const useNavStore = create<NavState>((set) => ({
  view: "home",
  open: (view) => set({ view }),
  home: () => set({ view: "home" }),
}));
