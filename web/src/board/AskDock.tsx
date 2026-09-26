import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { Answer, BoardOut, SystemMap } from "../api/types.ts";
import { useProvider } from "../settings/provider.ts";
import { CloseIcon, SparkIcon } from "../shell/icons.tsx";
import { useSession } from "../shell/session.tsx";
import { labelOf } from "./elements.ts";
import { useBoardUi } from "./store.ts";
import "./AskDock.css";

// =============================================================================
// Module Overview
// =============================================================================
// Ask the analyst about a finished board, from a bar docked under the canvas
// so the question sits next to the map it lights. The selected element, if
// any, goes along as the focus; the answer comes back as plain text plus ids
// that light up on the map.

const STARTERS = [
  "What should I fix first, and why?",
  "Where can untrusted input reach an AI part?",
  "What happens if the database leaks?",
];

/** The ask bar under the canvas and its latest answer. Each new `focusSignal` puts the cursor in the box. */
export function AskDock({ board, map, focusSignal }: { board: BoardOut; map: SystemMap; focusSignal: number }) {
  const { config, refreshMe } = useSession();
  // The user's own provider answers when they saved one, so name it rather than the server's model.
  const { provider, load } = useProvider();
  useEffect(() => {
    if (provider === null) void load();
  }, [provider, load]);
  const model = provider?.label ?? config.analyst;
  const selected = useBoardUi((s) => s.selected);
  const select = useBoardUi((s) => s.select);
  const setHighlight = useBoardUi((s) => s.setHighlight);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ question: string; reply: Answer } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const analysis = board.analysis;

  useEffect(() => {
    if (focusSignal > 0) input.current?.focus();
  }, [focusSignal]);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
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

  const pickStarter = (starter: string) => {
    setQuestion(starter);
    input.current?.focus();
  };

  return (
    <section className="ask-dock" aria-label="Ask about this board">
      {answer && (
        <div className="ask-answer" aria-live="polite">
          <div className="ask-answer-head">
            <p className="ask-question">{answer.question}</p>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss the answer" onClick={() => setAnswer(null)}>
              <CloseIcon width={14} height={14} />
            </button>
          </div>
          <p className="ask-reply">{answer.reply.answer}</p>
          {answer.reply.highlight.length > 0 && (
            <div className="ask-lit">
              <span className="panel-label">On the map</span>
              {answer.reply.highlight.map((item) => (
                <button key={item} type="button" className="chip" onClick={() => setHighlight([item], "ask")}>
                  {labelOf(item, map, analysis)}
                </button>
              ))}
              <button type="button" className="chip" onClick={() => setHighlight(answer.reply.highlight, "ask")}>
                All of them
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}

      <form onSubmit={ask} className="ask-form">
        <div className="ask-head">
          <SparkIcon width={16} height={16} className="ask-mark" />
          <label htmlFor={id} className="panel-label">
            Ask {model} about this board
          </label>
          {selected && (
            <span className="ask-focus">
              About <strong>{labelOf(selected, map, analysis)}</strong>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => select(null)}>
                Ask about the whole board
              </button>
            </span>
          )}
          <span className="field-hint ask-hint">Uses one model call. Ctrl or Cmd with Enter sends.</span>
        </div>
        <div className="ask-row">
          <textarea
            ref={input}
            id={id}
            className="textarea ask-input"
            rows={1}
            maxLength={2000}
            placeholder="What could go wrong if..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(e);
            }}
          />
          <button type="submit" className="btn btn-primary ask-send" disabled={busy || question.trim() === ""}>
            {busy && <span className="spinner" aria-hidden="true" />} Ask
          </button>
        </div>
        {!answer && question === "" && (
          <div className="ask-starters">
            {STARTERS.map((starter) => (
              <button key={starter} type="button" className="chip ask-starter" onClick={() => pickStarter(starter)}>
                {starter}
              </button>
            ))}
          </div>
        )}
      </form>
    </section>
  );
}
