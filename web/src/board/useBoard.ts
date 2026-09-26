import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, errorMessage } from "../api/client.ts";
import type { BoardOut } from "../api/types.ts";
import { useBoardList } from "../shell/boards.tsx";
import { usePolling } from "../shell/usePolling.ts";
import { isBusy } from "../shell/statusText.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Loads one board and keeps it current. It polls fast while the server draws or
// analyzes, and slowly otherwise, because a coding agent can change a board at
// any time. A change the user did not make here raises a `notice` naming it.

const BUSY_POLL_MS = 1500;
const IDLE_POLL_MS = 5000;

/** The loaded board and the ways to update it. */
export interface BoardState {
  board: BoardOut | null;
  loadError: { message: string; missing: boolean } | null;
  notice: string | null;
  dismissNotice: () => void;
  /** Adopt a board returned by the user's own action, without a change notice. */
  apply: (next: BoardOut) => void;
  reload: () => Promise<void>;
}

/** Load board `id` and poll it. */
export function useBoard(id: string): BoardState {
  const [board, setBoard] = useState<BoardOut | null>(null);
  const [loadError, setLoadError] = useState<BoardState["loadError"]>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { refresh: refreshList } = useBoardList();
  // Refs, not state: the poll compares against the latest values without restarting its timer.
  const revision = useRef<number | null>(null);
  const status = useRef<BoardOut["status"] | null>(null);
  const lastEvent = useRef(0);

  const adopt = useCallback(
    (next: BoardOut, announce: boolean) => {
      const newest = next.events.reduce((max, event) => Math.max(max, event.id), 0);
      if (announce && revision.current !== null && newest > lastEvent.current) {
        const latest = next.events.find((event) => event.id === newest);
        if (latest) setNotice(latest.text);
      }
      const statusChanged = status.current !== next.status;
      revision.current = next.revision;
      status.current = next.status;
      lastEvent.current = Math.max(lastEvent.current, newest);
      setBoard(next);
      if (statusChanged || announce) void refreshList().catch(() => undefined);
    },
    [refreshList],
  );

  const reload = useCallback(async () => {
    try {
      const next = await api.board(id);
      setLoadError(null);
      if (next.revision !== revision.current || next.status !== status.current) adopt(next, true);
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      // A failed poll on a loaded board is not worth interrupting the user; the next poll retries.
      if (revision.current === null || missing) setLoadError({ message: errorMessage(error), missing });
      throw error;
    }
  }, [id, adopt]);

  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);

  const busy = board !== null && isBusy(board.status);
  usePolling(reload, loadError?.missing ? null : busy ? BUSY_POLL_MS : IDLE_POLL_MS);

  const apply = useCallback((next: BoardOut) => adopt(next, false), [adopt]);
  const dismissNotice = useCallback(() => setNotice(null), []);

  return { board, loadError, notice, dismissNotice, apply, reload };
}
