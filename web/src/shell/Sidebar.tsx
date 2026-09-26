import { useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { BoardSummary } from "../api/types.ts";
import { topSeverity, totalThreats } from "../board/severity.ts";
import { useBoardList } from "./boards.tsx";
import { BookIcon, PlugIcon, PlusIcon, SidebarIcon } from "./icons.tsx";
import { useSession } from "./session.tsx";
import { SeverityShape } from "./SeverityBadge.tsx";
import { isBusy, STATUS_LABEL } from "./statusText.ts";
import { navigate } from "./useRoute.ts";
import { UserMenu } from "./UserMenu.tsx";
import "./Sidebar.css";

// =============================================================================
// Module Overview
// =============================================================================
// The collapsible left rail: every board with its status and worst severity,
// a quick way to start a new board or bring back the example, and the account
// menu. Collapsed, it keeps one letter per board so boards stay one click away.

function BoardItem({ board, active, collapsed }: { board: BoardSummary; active: boolean; collapsed: boolean }) {
  const worst = topSeverity(board.counts);
  const total = totalThreats(board.counts);
  const status = STATUS_LABEL[board.status];
  const threatText = worst ? `, ${total} threat${total === 1 ? "" : "s"}, worst ${worst}` : "";
  return (
    <li>
      <a
        href={`/boards/${encodeURIComponent(board.id)}`}
        className={`board-item ${active ? "is-active" : ""}`}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? `${board.title}, ${status}${threatText}` : undefined}
        title={collapsed ? board.title : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          navigate({ name: "board", boardId: board.id });
        }}
      >
        <span className={`board-initial ${worst ? `sev-${worst}` : ""}`} aria-hidden="true">
          {board.title.slice(0, 1).toUpperCase()}
        </span>
        {!collapsed && (
          <span className="board-item-text">
            <span className="board-item-title">
              {board.title}
              {board.example && <span className="board-tag">example</span>}
            </span>
            <span className="board-item-status">
              {isBusy(board.status) && <span className="busy-dot" aria-hidden="true" />}
              {status}
            </span>
          </span>
        )}
        {!collapsed && worst && (
          <span className={`sev sev-${worst} board-item-sev`} aria-label={`${total} threats, worst ${worst}`}>
            <SeverityShape severity={worst} />
            {total}
          </span>
        )}
      </a>
    </li>
  );
}

/** The app's left sidebar. */
export function Sidebar({
  collapsed,
  onToggle,
  activeBoardId,
}: {
  collapsed: boolean;
  onToggle: () => void;
  activeBoardId: string | null;
}) {
  const { config } = useSession();
  const { boards, loaded, refresh } = useBoardList();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const example = boards.find((board) => board.example);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim() || "Untitled system";
    setBusy(true);
    setError(null);
    try {
      const board = await api.createBoard(name);
      setCreating(false);
      setTitle("");
      await refresh();
      navigate({ name: "board", boardId: board.id });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const openExample = async () => {
    if (example) {
      navigate({ name: "board", boardId: example.id });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const board = await api.restoreExample();
      await refresh();
      navigate({ name: "board", boardId: board.id });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const startCreating = () => {
    if (collapsed) onToggle();
    setCreating(true);
  };

  return (
    <nav id="sidebar" className={`sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="Boards">
      <div className="sidebar-head">
        {!collapsed && (
          <a
            className="sidebar-brand hand"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate({ name: "home" });
            }}
          >
            {config.app_name}
          </a>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <SidebarIcon />
        </button>
      </div>

      {creating && !collapsed ? (
        <form className="sidebar-new" onSubmit={create}>
          <label className="visually-hidden" htmlFor="new-board-title">
            Name the new board
          </label>
          <input
            id="new-board-title"
            className="input"
            placeholder="Name this system"
            value={title}
            maxLength={120}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <div className="sidebar-new-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              Create
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className={`btn btn-primary sidebar-new-button ${collapsed ? "btn-icon" : ""}`}
          onClick={startCreating}
          aria-label={collapsed ? "New board" : undefined}
        >
          <PlusIcon /> {!collapsed && "New board"}
        </button>
      )}

      {error && !collapsed && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}

      <div className="sidebar-scroll">
        {!collapsed && <p className="sidebar-label">Your boards</p>}
        {loaded && boards.length === 0 && !collapsed && <p className="sidebar-empty">No boards yet.</p>}
        <ul className="board-list">
          {boards.map((board) => (
            <BoardItem key={board.id} board={board} active={board.id === activeBoardId} collapsed={collapsed} />
          ))}
        </ul>
      </div>

      <div className="sidebar-foot">
        <button
          type="button"
          className={`btn btn-ghost sidebar-link ${collapsed ? "btn-icon" : ""}`}
          onClick={() => void openExample()}
          disabled={busy}
          aria-label={collapsed ? (example ? "Open the example board" : "Restore the example board") : undefined}
        >
          <BookIcon /> {!collapsed && (example ? "Example board" : "Restore the example board")}
        </button>
        <button
          type="button"
          className={`btn btn-ghost sidebar-link ${collapsed ? "btn-icon" : ""}`}
          onClick={() => navigate({ name: "settings", section: "agents", boardId: activeBoardId })}
          aria-label={collapsed ? "Connect a coding agent" : undefined}
        >
          <PlugIcon /> {!collapsed && "Connect a coding agent"}
        </button>
        <UserMenu collapsed={collapsed} boardId={activeBoardId} />
      </div>
    </nav>
  );
}
