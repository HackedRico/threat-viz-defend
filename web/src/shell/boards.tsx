import { createContext, useContext } from "react";

import type { BoardSummary } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The signed-in user's board list, shared by the sidebar and any screen that
// changes a board and needs the list to catch up.

/** The board list and a way to reload it. */
export interface BoardList {
  boards: BoardSummary[];
  loaded: boolean;
  refresh: () => Promise<BoardSummary[]>;
}

export const BoardListContext = createContext<BoardList | null>(null);

/** Read the board list; only valid inside `Shell`. */
export function useBoardList(): BoardList {
  const list = useContext(BoardListContext);
  if (list === null) throw new Error("`useBoardList` needs the `BoardListContext` provider from `Shell`.");
  return list;
}
