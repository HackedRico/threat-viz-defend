import { create } from "zustand";

import { api, errorMessage } from "../api/client.ts";
import type { ProviderOut } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The user's active model provider, fetched once and shared, so the settings
// screen and the "finding threats" states name the same model. Screens call
// `load` when they mount; saving in settings replaces it.

interface ProviderStore {
  provider: ProviderOut | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  set: (provider: ProviderOut | null) => void;
  /** Forget the provider on sign out, so the next account on this tab never sees it. */
  reset: () => void;
}

// Bumped by `reset`, so a load still in flight for the previous account is dropped when it lands.
let generation = 0;

/** The active model provider for the signed-in user. */
export const useProvider = create<ProviderStore>()((set, get) => ({
  provider: null,
  loading: false,
  error: null,
  load: async () => {
    if (get().loading) return;
    const mine = generation;
    set({ loading: true });
    try {
      const provider = await api.provider();
      if (mine === generation) set({ provider, error: null });
    } catch (caught) {
      // Screens that only show the label leave it out; the settings screen shows this message.
      if (mine === generation) set({ error: errorMessage(caught) });
    } finally {
      if (mine === generation) set({ loading: false });
    }
  },
  set: (provider) => set({ provider }),
  reset: () => {
    generation += 1;
    set({ provider: null, loading: false, error: null });
  },
}));
