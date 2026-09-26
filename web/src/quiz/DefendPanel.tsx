import { useEffect, useState } from "react";

import { errorMessage } from "../api/client.ts";
import type { BoardOut, SystemMap } from "../api/types.ts";
import { labelOf } from "../board/elements.ts";
import { useBoardUi } from "../board/store.ts";
import { MicIcon } from "../shell/icons.tsx";
import { useSession } from "../shell/session.tsx";
import { voiceEnabled, VoicePanel } from "../voice/index.tsx";
import { nextQuestion } from "../voice/speech.ts";
import { QuizPanel } from "./QuizPanel.tsx";
import { useQuiz } from "./useQuiz.ts";
import "./Quiz.css";

// =============================================================================
// Module Overview
// =============================================================================
// Where the developer proves they can defend the board: a mastery score with
// weak spots, and the same quiz answered by typing or by talking to the voice
// coach. Both modes share one quiz state, so switching mid-way loses nothing.

type Mode = "text" | "voice";

/** The defend panel for a finished board. */
export function DefendPanel({ board, map }: { board: BoardOut; map: SystemMap }) {
  const { config } = useSession();
  const state = useQuiz(board.id, board.analysis_version);
  const [mode, setMode] = useState<Mode>("text");
  const [active, setActive] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const setHighlight = useBoardUi((s) => s.setHighlight);
  const { quiz } = state;
  const voice = voiceEnabled(config);

  // Open on the first unanswered question, once the quiz arrives.
  useEffect(() => {
    if (quiz && active === null) setActive(nextQuestion(quiz)?.id ?? quiz.questions[0]?.id ?? null);
  }, [quiz, active]);

  if (state.loading && quiz === null) {
    return (
      <p className="muted" role="status">
        <span className="spinner" aria-hidden="true" /> Loading the quiz...
      </p>
    );
  }
  if (quiz === null) {
    return (
      <div className="panel-error" role="alert">
        {state.error ?? "The quiz could not be loaded."}{" "}
        <button type="button" className="btn btn-sm" onClick={() => void state.reload()}>
          Try again
        </button>
      </div>
    );
  }

  const { mastery } = quiz;
  const percent = Math.round(mastery.score * 100);
  const startOver = async () => {
    setResetting(true);
    setResetError(null);
    try {
      await state.reset();
      setActive(null);
    } catch (caught) {
      setResetError(errorMessage(caught));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="defend">
      <section className="mastery" aria-label="How well you can defend this board">
        <div className="mastery-score">
          <span className="hand mastery-percent">{percent}%</span>
          <span className="mastery-caption">
            {mastery.answered} of {mastery.total} answered, {mastery.correct} correct
            {mastery.partial > 0 && `, ${mastery.partial} partly`}
          </span>
        </div>
        <div
          className="mastery-bar"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="Defense score"
        >
          <div className="mastery-fill" style={{ width: `${percent}%` }} />
        </div>
        {mastery.weak_spots.length > 0 && (
          <div className="weak-spots">
            <button type="button" className="panel-link" onClick={() => setHighlight(mastery.weak_spots, "weak")}>
              Weak spots
            </button>
            <div className="weak-chips">
              {mastery.weak_spots.slice(0, 8).map((id) => (
                <button key={id} type="button" className="chip weak-chip" onClick={() => setHighlight([id], "weak")}>
                  {labelOf(id, map, board.analysis)}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="defend-modes" role="radiogroup" aria-label="How to answer">
        <button type="button" role="radio" aria-checked={mode === "text"} className="defend-mode" onClick={() => setMode("text")}>
          Type answers
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "voice"}
          className="defend-mode"
          onClick={() => setMode("voice")}
          disabled={!voice}
        >
          <MicIcon width={16} height={16} /> Talk it through
        </button>
      </div>
      {!voice && <p className="field-hint">The voice coach is off on this server, so the quiz is text only.</p>}

      {mode === "voice" && voice ? (
        <VoicePanel board={board} map={map} state={state} active={active} onActive={setActive} onUseText={() => setMode("text")} />
      ) : (
        <QuizPanel state={state} active={active} onActive={setActive} />
      )}

      <div className="defend-foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void startOver()} disabled={resetting || mastery.answered === 0}>
          {resetting && <span className="spinner" aria-hidden="true" />} Start the quiz over
        </button>
        {resetError && (
          <span className="panel-error" role="alert">
            {resetError}
          </span>
        )}
      </div>
    </div>
  );
}
