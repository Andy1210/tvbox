import { create } from "zustand";
import { persist } from "zustand/middleware";

// Per-box home-screen app preferences: a manual order + a hidden set. Kept in
// the launcher (localStorage, like the locale store) rather than the app
// manifests - the order is the user's, not the app's (we deliberately rejected
// an `order` manifest field). Apps not listed in `order` sort after the listed
// ones by name, so a newly installed app just appears at the end.
interface AppPrefsState {
  order: string[]; // app ids, in the user's preferred order
  hidden: string[]; // app ids hidden from Home
  getMoreHidden: boolean; // hide the "Get more apps" tile from Home (shown by default)
  setOrder: (order: string[]) => void;
  toggleHidden: (id: string) => void;
  toggleGetMore: () => void;
}

export const useAppPrefsStore = create<AppPrefsState>()(
  persist(
    (set) => ({
      order: [],
      hidden: [],
      getMoreHidden: false,
      setOrder: (order) => set({ order }),
      toggleHidden: (id) =>
        set((s) => ({ hidden: s.hidden.includes(id) ? s.hidden.filter((x) => x !== id) : [...s.hidden, id] })),
      toggleGetMore: () => set((s) => ({ getMoreHidden: !s.getMoreHidden })),
    }),
    { name: "tvbox.appPrefs" },
  ),
);

// Sort a list of ids by the saved order (listed ids first, in order), falling
// back to `byName` for ids not in the order - the single source of truth for
// both Home and the reorder UI so they never disagree.
export function orderIds(ids: string[], order: string[], byName: (a: string, b: string) => number): string[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => {
    const ra = rank.has(a) ? (rank.get(a) as number) : Infinity;
    const rb = rank.has(b) ? (rank.get(b) as number) : Infinity;
    return ra !== rb ? ra - rb : byName(a, b);
  });
}
