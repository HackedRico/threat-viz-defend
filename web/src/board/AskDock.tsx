import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { Answer, BoardOut, SystemMap } from "../api/types.ts";
import { useProvider } from "../settings/provider.ts";
import { CloseIcon, SparkIcon } from "../shell/icons.tsx";
import { ResizeHandle } from "../shell/ResizeHandle.tsx";
import { clampWidth, parseWidth } from "../shell/resize.ts";
import { useSession } from "../shell/session.tsx";
import { dictationEnabled, DictateButton, joinDictation } from "../voice/index.tsx";
import { labelOf } from "./elements.ts";
import { starterQuestions } from "./starters.ts";
import { useBoardUi } from "./store.ts";
import "./AskDock.css";

// =============================================================================
// Module Overview
// =============================================================================
// Ask the analyst about a finished board, from a bar docked under the canvas
// so the question sits next to the map it lights. The selected element, if
// any, goes along as the focus; the answer comes back as plain text plus ids
// that light up on the map. The bar fits its content until the user drags its
// top edge. The starter questions name this board's own parts and go away
// once the first question is sent. When the server has dictation, a mic beside
// Ask writes a spoken question into the box, where the user reads it before
// sending.

const QUESTION_MAX = 2000;
const HEIGHT_KEY = "ask-height";
const HEIGHT_MIN = 100;
const HEIGHT_MAX = 900;

// Null means the bar fits its content. Storage can be blocked in private windows.
function readHeight(): number | null {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    return raw === null ? null : parseWidth(raw, HEIGHT_MIN, { min: HEIGHT_MIN, max: HEIGHT_MAX });
  } catch {
    return null;
  }
}

function storeHeight(height: number | null) {
  try {
    if (height === null) localStorage.removeItem(HEIGHT_KEY);
    else localStorage.setItem(HEIGHT_KEY, String(height));
  } catch {
    // Not remembering the height is harmless.
  }
}

/** The height the user dragged the bar to, remembered in this browser, and the height it has on screen. */
function useDockHeight() {
  const dock = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(readHeight);
  const [natural, setNatural] = useState(HEIGHT_MIN);
  useEffect(() => storeHeight(height), [height]);
  // A drag starts from the height on screen, so measure it while the bar fits its content.
  useEffect(() => {
    const el = dock.current;
    if (!el || height !== null) return undefined;
    const observer = new ResizeObserver(() => setNatural(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [height]);
  // The bar may grow over most of the canvas but always leaves some map to look at.
  const bounds = { min: HEIGHT_MIN, max: Math.min(HEIGHT_MAX, Math.round(window.innerHeight * 0.7)) };
  const shown = height === null ? null : clampWidth(height, bounds);
  return { dock, shown, size: shown ?? natural, bounds, setHeight };
}

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
  const [asked, setAsked] = useState(false);
  const { dock, shown, size, bounds, setHeight } = useDockHeight();
  const input = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const analysis = board.analysis;
  const starters = useMemo(
    () => (analysis ? starterQuestions(map, analysis, board.exposure) : []),
    [map, analysis, board.exposure],
  );

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
      setAsked(true);
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

  // The heard words join what was typed, and the cursor lands after them so a fix is one keystroke away.
  const takeDictation = (heard: string) => {
    setQuestion((typed) => joinDictation(typed, heard, QUESTION_MAX));
    requestAnimationFrame(() => {
      const box = input.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  };

  return (
    <section
      ref={dock}
      id={`${id}-dock`}
      className={["ask-dock", shown !== null && "is-sized", answer && "has-answer"].filter(Boolean).join(" ")}
      style={shown === null ? undefined : ({ height: `${shown}px` } as CSSProperties)}
      aria-label="Ask about this board"
    >
      <ResizeHandle
        label="Resize the ask bar"
        controls={`${id}-dock`}
        edge="top"
        size={size}
        bounds={bounds}
        fallback={HEIGHT_MIN}
        onResize={setHeight}
        onReset={() => setHeight(null)}
      />
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
            maxLength={QUESTION_MAX}
            placeholder="What could go wrong if..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(e);
            }}
          />
          {dictationEnabled(config) && <DictateButton onText={takeDictation} onError={setError} disabled={busy} />}
          <button type="submit" className="btn btn-primary ask-send" disabled={busy || question.trim() === ""}>
            {busy && <span className="spinner" aria-hidden="true" />} Ask
          </button>
        </div>
        {!asked && question === "" && (
          <div className="ask-starters">
            {starters.map((starter) => (
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
