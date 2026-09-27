import { useEffect, useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { BoardOut } from "../api/types.ts";
import { useBoardList } from "../shell/boards.tsx";
import { CloseIcon, PlugIcon, PlusIcon, TrashIcon } from "../shell/icons.tsx";
import { SeverityBadge } from "../shell/SeverityBadge.tsx";
import { isBusy, STATUS_LABEL } from "../shell/statusText.ts";
import { useSession } from "../shell/session.tsx";
import { navigate } from "../shell/useRoute.ts";
import { Drawing } from "./Drawing.tsx";
import { ExportMenu } from "./ExportMenu.tsx";
import { Intake } from "./Intake.tsx";
import { SEVERITIES } from "./severity.ts";
import { useBoardUi } from "./store.ts";
import { useBoard } from "./useBoard.ts";
import { Workspace } from "./Workspace.tsx";
import "./BoardView.css";

// =============================================================================
// Module Overview
// =============================================================================
// One board, shown by status: intake while empty, the drawing animation while
// the server works, the draft map in review, and the finished threat model when
// ready. The header renames, exports and deletes the board; banners carry the
// last failure and changes that arrived from elsewhere, such as a coding agent.

/** The screen for board `boardId`. */
export function BoardView({ boardId }: { boardId: string }) {
  const { config } = useSession();
  const state = useBoard(boardId);
  const { board, loadError, notice, dismissNotice, apply } = state;
  const [adding, setAdding] = useState(false);
  const reset = useBoardUi((s) => s.reset);

  useEffect(() => {
    reset();
    return reset;
  }, [boardId, reset]);

  useEffect(() => {
    if (board) document.title = `${board.title} | ${config.app_name}`;
    return () => {
      document.title = config.app_name;
    };
  }, [board, config.app_name]);

  if (loadError && (loadError.missing || board === null)) {
    return (
      <section className="board-missing">
        <h1 className="hand">{loadError.missing ? "This board is gone." : "Could not open this board."}</h1>
        <p>{loadError.message}</p>
        <button type="button" className="btn btn-primary" onClick={() => navigate({ name: "home" })}>
          Back to your boards
        </button>
      </section>
    );
  }
  if (board === null) {
    return (
      <section className="board-loading" aria-busy="true">
        <span className="spinner" aria-label="Loading the board" />
      </section>
    );
  }

  // A board whose stored map no longer loads has nothing to draw, so it takes material again rather than waiting.
  const showIntake = board.status === "empty" || adding || (board.map === null && !isBusy(board.status));
  const top = (
    <>
      <BoardHeader board={board} onApply={apply} onAddMaterial={() => setAdding(true)} adding={adding} />
      <ErrorBanner board={board} />
      {/* The failure banner already carries the error; a notice repeating it is noise. */}
      {notice && notice !== board.error && (
        <div className="board-notice" role="status">
          <span className="board-notice-dot" aria-hidden="true" />
          <span className="board-notice-text">{notice}</span>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" onClick={dismissNotice}>
            <CloseIcon />
          </button>
        </div>
      )}
    </>
  );

  // With a map on screen, the header moves into the map column so the side panel can run the
  // full height beside it, mirroring the sidebar on the left.
  if (!showIntake && board.map !== null) {
    return (
      <section className="board-view" aria-labelledby="board-title">
        <Workspace board={board} onApply={apply} top={top} />
      </section>
    );
  }

  return (
    <section className="board-view" aria-labelledby="board-title">
      {top}
      <div className="board-body">
        {showIntake ? (
          <Intake
            board={board}
            onSubmitted={(next) => {
              setAdding(false);
              apply(next);
            }}
            onCancel={board.status === "empty" ? null : () => setAdding(false)}
          />
        ) : (
          <Drawing board={board} />
        )}
      </div>
    </section>
  );
}

// =============================================================================
// Header
// =============================================================================

function BoardHeader({
  board,
  onApply,
  onAddMaterial,
  adding,
}: {
  board: BoardOut;
  onApply: (next: BoardOut) => void;
  onAddMaterial: () => void;
  adding: boolean;
}) {
  const { refresh } = useBoardList();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(board.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const next = title.trim();
    if (!next || next === board.title) {
      setEditing(false);
      setTitle(board.title);
      return;
    }
    try {
      onApply(await api.renameBoard(board.id, next));
      setEditing(false);
      setError(null);
      void refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.deleteBoard(board.id);
      await refresh();
      navigate({ name: "home" }, true);
    } catch (caught) {
      setError(errorMessage(caught));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const busy = isBusy(board.status);
  return (
    <header className="board-head">
      <div className="board-head-title">
        {editing ? (
          <form onSubmit={rename} className="board-rename">
            <label htmlFor="board-title-input" className="visually-hidden">
              Board name
            </label>
            <input
              id="board-title-input"
              className="input board-rename-input hand"
              value={title}
              maxLength={120}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onBlur={(e) => void rename(e)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setTitle(board.title);
                  setEditing(false);
                }
              }}
            />
          </form>
        ) : (
          <h1 id="board-title" className="board-title hand">
            <button
              type="button"
              className="board-title-button"
              onClick={() => {
                setTitle(board.title);
                setEditing(true);
              }}
              title="Rename this board"
            >
              {board.title}
            </button>
          </h1>
        )}
        <div className="board-head-meta">
          <span className={`status-pill status-${board.status}`}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {STATUS_LABEL[board.status]}
          </span>
          {board.status === "ready" &&
            SEVERITIES.filter((level) => board.counts[level] > 0).map((level) => (
              <SeverityBadge key={level} severity={level} count={board.counts[level]} />
            ))}
          {board.analyzed_by && board.status === "ready" && <span className="chip">Analyzed by {board.analyzed_by}</span>}
        </div>
      </div>

      <div className="board-actions">
        {error && (
          <span className="board-head-error" role="alert">
            {error}
          </span>
        )}
        {board.status !== "empty" && !busy && !adding && (
          <button type="button" className="btn btn-sm" onClick={onAddMaterial}>
            <PlusIcon /> Add material
          </button>
        )}
        {board.status === "ready" && <ExportMenu board={board} onError={setError} />}
        <button type="button" className="btn btn-sm" onClick={() => navigate({ name: "settings", section: "agents", boardId: board.id })}>
          <PlugIcon /> Connect an agent
        </button>
        {confirmDelete ? (
          <span className="board-delete-confirm" role="group" aria-label="Confirm delete">
            <span>Delete this board?</span>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} disabled={deleting}>
              {deleting && <span className="spinner" aria-hidden="true" />} Delete
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            aria-label="Delete this board"
            onClick={() => setConfirmDelete(true)}
          >
            <TrashIcon />
          </button>
        )}
      </div>
    </header>
  );
}

function ErrorBanner({ board }: { board: BoardOut }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A retry can fail with the very same message, so a dismissal belongs to one failure event, not to its text.
  const failure = `${board.events.find((event) => event.kind === "failed")?.id ?? ""}:${board.error ?? ""}`;
  if (!board.error || dismissed === failure) return null;
  return (
    <div className="banner banner-error board-banner" role="alert">
      <div className="banner-body">
        <strong>The last step failed.</strong> {board.error}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-icon"
        aria-label="Dismiss the error"
        onClick={() => setDismissed(failure)}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
