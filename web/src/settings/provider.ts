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
}

/** The active model provider for the signed-in user. */
export const useProvider = create<ProviderStore>()((set, get) => ({
  provider: null,
  loading: false,
  error: null,
  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      set({ provider: await api.provider(), error: null });
    } catch (caught) {
      // Screens that only show the label leave it out; the settings screen shows this message.
      set({ error: errorMessage(caught) });
    } finally {
      set({ loading: false });
    }
  },
  set: (provider) => set({ provider }),
}));
