import { useState } from "react";

import { api, errorMessage } from "../api/client.ts";
import { useBoardList } from "./boards.tsx";
import { BoardSketch } from "./BoardSketch.tsx";
import { Mascot } from "./Mascot.tsx";
import { useSession } from "./session.tsx";
import { navigate } from "./useRoute.ts";
import "./Shell.css";

// =============================================================================
// Module Overview
// =============================================================================
// The empty state for a user with no boards: start one, or open the example
// board to see a finished threat model first. Dawg waits here in the hackUMBC
// theme.

/** First screen for a user with no boards. */
export function Welcome() {
  const { config } = useSession();
  const { refresh } = useBoardList();
  const [busy, setBusy] = useState<"new" | "example" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: "new" | "example") => {
    setBusy(kind);
    setError(null);
    try {
      const board = kind === "new" ? await api.createBoard("My system") : await api.restoreExample();
      await refresh();
      navigate({ name: "board", boardId: board.id });
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(null);
    }
  };

  return (
    <section className="welcome">
      <div className="welcome-card">
        <Mascot bubble="Fresh board. Let's sniff it out." className="welcome-mascot" />
        <h1 className="hand welcome-title">A clean whiteboard.</h1>
        <p className="welcome-text">
          Start a board for a system you are building. {config.app_name} draws its data flow, finds threats on it, and
          then quizzes you until you can defend it.
        </p>
        <div className="welcome-actions">
          <button type="button" className="btn btn-primary" onClick={() => void run("new")} disabled={busy !== null}>
            {busy === "new" && <span className="spinner" aria-hidden="true" />} Start a board
          </button>
          <button type="button" className="btn" onClick={() => void run("example")} disabled={busy !== null}>
            {busy === "example" && <span className="spinner" aria-hidden="true" />} Open the example board
          </button>
        </div>
        {error && (
          <p role="alert" className="welcome-error">
            {error}
          </p>
        )}
      </div>
      <div className="welcome-sketch">
        <BoardSketch />
      </div>
    </section>
  );
}
