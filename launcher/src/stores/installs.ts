import { create } from "zustand";

// The set of store installs/updates the user kicked off that we still owe a
// global "done" toast for. StoreSettings adds an id when it fires storeInstall;
// InstallWatcher (mounted at the app root) polls the store list and removes each
// id once its install finishes, firing the toast. Living outside the store view
// means the completion toast still shows if the user has navigated away.
interface InstallsState {
  pending: string[];
  add: (id: string) => void;
  remove: (id: string) => void;
}

export const useInstalls = create<InstallsState>((set) => ({
  pending: [],
  add: (id) => set((s) => (s.pending.includes(id) ? s : { pending: [...s.pending, id] })),
  remove: (id) => set((s) => ({ pending: s.pending.filter((x) => x !== id) })),
}));
