import { create } from "zustand";

import { api, errorMessage } from "../api/client.ts";
import type { MemoryOut } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The user's Backboard memory setting, fetched once and shared, so the sidebar
// can say whether memory is on and the memory page can change it in one place.
// Screens call `load` when they mount; the memory page replaces it on a change.

interface MemoryStore {
  memory: MemoryOut | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  set: (memory: MemoryOut) => void;
  /** Forget the setting on sign out, so the next account on this tab never sees it. */
  reset: () => void;
}

// Bumped by `reset`, so a load still in flight for the previous account is dropped when it lands.
let generation = 0;

/** The signed-in user's memory setting. */
export const useMemory = create<MemoryStore>()((set, get) => ({
  memory: null,
  loading: false,
  error: null,
  load: async () => {
    if (get().loading) return;
    const mine = generation;
    set({ loading: true });
    try {
      const memory = await api.memory();
      if (mine === generation) set({ memory, error: null });
    } catch (caught) {
      if (mine === generation) set({ error: errorMessage(caught) });
    } finally {
      if (mine === generation) set({ loading: false });
    }
  },
  set: (memory) => set({ memory }),
  reset: () => {
    generation += 1;
    set({ memory: null, loading: false, error: null });
  },
}));

/** A few words on the memory setting, for places with room for one line. */
export function memoryStatus(memory: MemoryOut): string {
  if (memory.source === "none") return "needs a key";
  if (!memory.enabled) return "off";
  return "on";
}
