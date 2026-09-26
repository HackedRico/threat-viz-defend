import { create } from "zustand";

// =============================================================================
// Module Overview
// =============================================================================
// What the user is pointing at on the open board: the selected element, the ids
// lit by an answer, a quiz result, the voice coach or an attack path, and the
// threat in focus. It is a store rather than props because the voice coach's
// tools light the map from outside React's render.

/** Where the current highlight came from, shown beside the map so it is never a mystery. */
export type HighlightSource = "ask" | "quiz" | "voice" | "weak" | "threat";

interface BoardUi {
  selected: string | null;
  highlight: string[];
  highlightSource: HighlightSource | null;
  hoverPath: string | null;
  pinnedPath: string | null;
  /** The threat the list opens and scrolls to: a new object per request, so asking for the same threat twice works. */
  focusThreat: { id: string } | null;
  select: (id: string | null) => void;
  setHighlight: (ids: string[], source: HighlightSource) => void;
  clearHighlight: () => void;
  setHoverPath: (id: string | null) => void;
  togglePinnedPath: (id: string) => void;
  showThreat: (id: string | null) => void;
  openThreat: (id: string) => void;
  reset: () => void;
}

const EMPTY = {
  selected: null,
  highlight: [],
  highlightSource: null,
  hoverPath: null,
  pinnedPath: null,
  focusThreat: null,
} as const;

/** The open board's pointing state. */
export const useBoardUi = create<BoardUi>()((set) => ({
  ...EMPTY,
  highlight: [],
  select: (id) => set({ selected: id }),
  setHighlight: (ids, source) =>
    set((state) => ({
      highlight: ids,
      highlightSource: ids.length > 0 ? source : null,
      pinnedPath: null,
      // A quiz, voice or weak-spot highlight is about the whole map, so the details card steps aside.
      selected: source === "quiz" || source === "voice" || source === "weak" ? null : state.selected,
    })),
  clearHighlight: () => set({ highlight: [], highlightSource: null, pinnedPath: null }),
  setHoverPath: (id) => set({ hoverPath: id }),
  togglePinnedPath: (id) => set((state) => ({ pinnedPath: state.pinnedPath === id ? null : id })),
  showThreat: (id) => set({ focusThreat: id === null ? null : { id } }),
  // The threat opens in the list, which the details would cover, so the selection steps aside
  // and the threat lights its pin and element instead.
  openThreat: (id) => set({ selected: null, focusThreat: { id }, highlight: [id], highlightSource: "threat", pinnedPath: null }),
  reset: () => set({ ...EMPTY, highlight: [] }),
}));
