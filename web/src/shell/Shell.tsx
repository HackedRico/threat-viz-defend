import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import { api } from "../api/client.ts";
import type { BoardSummary } from "../api/types.ts";
import { BoardView } from "../board/BoardView.tsx";
import { SettingsView } from "../settings/SettingsView.tsx";
import { BoardListContext, type BoardList } from "./boards.tsx";
import { ResizeHandle, useStoredWidth } from "./ResizeHandle.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { usePolling } from "./usePolling.ts";
import { navigate, useRoute } from "./useRoute.ts";
import { Welcome } from "./Welcome.tsx";
import "./Shell.css";

// =============================================================================
// Module Overview
// =============================================================================
// The signed-in layout: the sidebar and the current screen. It owns the board
// list, reloading it on a slow timer so boards a coding agent creates or
// changes show up without a refresh.

const LIST_POLL_MS = 15_000;
const COLLAPSE_KEY = "sidebar-collapsed";
const WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 272;
const WIDTH_BOUNDS = { min: 200, max: 480 };

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    // Storage can be blocked in private windows; the sidebar just starts open.
    return false;
  }
}

/** The signed-in app. */
export function Shell() {
  const route = useRoute();
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [width, setWidth] = useStoredWidth(WIDTH_KEY, DEFAULT_WIDTH, WIDTH_BOUNDS);

  const refresh = useCallback(async () => {
    const next = await api.boards();
    setBoards(next);
    setLoaded(true);
    return next;
  }, []);

  useEffect(() => {
    refresh().catch(() => setLoaded(true));
  }, [refresh]);
  usePolling(refresh, LIST_POLL_MS);

  const toggle = () => {
    setCollapsed((was) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, was ? "0" : "1");
      } catch {
        // Not remembering the choice is harmless.
      }
      return !was;
    });
  };

  // Home opens the most recently touched board, so returning users land where they left off.
  const latest = useMemo(
    () => [...boards].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null,
    [boards],
  );
  useEffect(() => {
    if (route.name === "home" && latest) navigate({ name: "board", boardId: latest.id }, true);
  }, [route.name, latest]);

  const list = useMemo<BoardList>(() => ({ boards, loaded, refresh }), [boards, loaded, refresh]);
  const activeBoardId = route.name === "board" ? route.boardId : route.name === "settings" ? route.boardId : null;

  return (
    <BoardListContext value={list}>
      <div className="shell" style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
        <Sidebar collapsed={collapsed} onToggle={toggle} activeBoardId={activeBoardId} />
        {!collapsed && (
          <ResizeHandle
            label="Resize sidebar"
            controls="sidebar"
            edge="right"
            width={width}
            bounds={WIDTH_BOUNDS}
            fallback={DEFAULT_WIDTH}
            onResize={setWidth}
          />
        )}
        <main className="shell-main">
          {route.name === "board" && <BoardView key={route.boardId} boardId={route.boardId} />}
          {route.name === "settings" && <SettingsView section={route.section} boardId={route.boardId} />}
          {route.name === "home" && (loaded && latest === null ? <Welcome /> : <div className="shell-blank" />)}
        </main>
      </div>
    </BoardListContext>
  );
}
