import { useId, useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { Answer, BoardOut, SystemMap } from "../api/types.ts";
import { useSession } from "../shell/session.tsx";
import { labelOf } from "./elements.ts";
import { useBoardUi } from "./store.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Ask the analyst about a finished board. The selected element, if any, goes
// along as the focus; the answer comes back as plain text plus ids that light
// up on the map.

const STARTERS = [
  "What should I fix first, and why?",
  "Where can untrusted input reach an AI part?",
  "What happens if the database leaks?",
];

/** The ask box and its latest answer. */
export function AskBox({ board, map }: { board: BoardOut; map: SystemMap }) {
  const { config, refreshMe } = useSession();
  const selected = useBoardUi((s) => s.selected);
  const select = useBoardUi((s) => s.select);
  const setHighlight = useBoardUi((s) => s.setHighlight);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ question: string; reply: Answer } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const analysis = board.analysis;

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const reply = await api.ask(board.id, text, selected);
      setAnswer({ question: text, reply });
      setHighlight(reply.highlight, "ask");
      setQuestion("");
      refreshMe();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ask">
      <form onSubmit={ask} className="ask-form">
        <label htmlFor={id} className="panel-label">
          Ask {config.analyst} about this board
        </label>
        {selected && (
          <p className="ask-focus">
            About <strong>{labelOf(selected, map, analysis)}</strong>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => select(null)}>
              Ask about the whole board
            </button>
          </p>
        )}
        <textarea
          id={id}
          className="textarea"
          rows={3}
          maxLength={2000}
          placeholder="What could go wrong if..."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(e);
          }}
        />
        <div className="panel-row">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || question.trim() === ""}>
            {busy && <span className="spinner" aria-hidden="true" />} Ask
          </button>
          <span className="field-hint">Uses one model call.</span>
        </div>
        {!answer && (
          <div className="ask-starters">
            {STARTERS.map((starter) => (
              <button key={starter} type="button" className="chip ask-starter" onClick={() => setQuestion(starter)}>
                {starter}
              </button>
            ))}
          </div>
        )}
      </form>

      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}

      {answer && (
        <section className="ask-answer" aria-live="polite">
          <p className="ask-question">{answer.question}</p>
          <p className="ask-reply">{answer.reply.answer}</p>
          {answer.reply.highlight.length > 0 && (
            <div className="ask-lit">
              <span className="panel-label">On the map</span>
              <div className="ask-lit-chips">
                {answer.reply.highlight.map((item) => (
                  <button key={item} type="button" className="chip" onClick={() => setHighlight([item], "ask")}>
                    {labelOf(item, map, analysis)}
                  </button>
                ))}
                <button type="button" className="chip" onClick={() => setHighlight(answer.reply.highlight, "ask")}>
                  All of them
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
