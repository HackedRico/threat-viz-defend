import { createContext, useContext, useState } from "react";

import type { BoardSummary } from "../api/types.ts";
import "./Shell.css";

// =============================================================================
// Module Overview
// =============================================================================
// The signed-in user's board list, shared by the sidebar and any screen that
// changes a board and needs the list to catch up. When a load fails, `error`
// says why and `BoardListError` shows it with a retry, so a list that never
// arrived is not mistaken for an account with no boards.

/** The board list and a way to reload it. */
export interface BoardList {
  boards: BoardSummary[];
  /** True once a load has worked; until then an empty `boards` means unknown, not none. */
  loaded: boolean;
  /** Why the last load failed, or `null` once one works. */
  error: string | null;
  refresh: () => Promise<BoardSummary[]>;
}

export const BoardListContext = createContext<BoardList | null>(null);

/** Read the board list; only valid inside `Shell`. */
export function useBoardList(): BoardList {
  const list = useContext(BoardListContext);
  if (list === null) throw new Error("`useBoardList` needs the `BoardListContext` provider from `Shell`.");
  return list;
}

/** The last load's error with a Retry button, for where an empty board list would show; nothing once a load works. */
export function BoardListError({ className = "" }: { className?: string }) {
  const { error, refresh } = useBoardList();
  const [retrying, setRetrying] = useState(false);
  if (error === null) return null;

  const retry = async () => {
    setRetrying(true);
    // `refresh` puts a new failure in `error`, which this message already shows.
    await refresh().catch(() => undefined);
    setRetrying(false);
  };

  return (
    <div className={`board-list-error ${className}`}>
      <p className="board-list-error-text" role="alert">
        Your boards did not load. {error}
      </p>
      <button type="button" className="btn btn-sm" onClick={() => void retry()} disabled={retrying}>
        {retrying && <span className="spinner" aria-hidden="true" />} Retry
      </button>
    </div>
  );
}
