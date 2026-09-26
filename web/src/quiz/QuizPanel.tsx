import { useEffect, useId, useState, type FormEvent } from "react";

import { errorMessage } from "../api/client.ts";
import type { AttemptOut, QuestionOut } from "../api/types.ts";
import { useBoardUi } from "../board/store.ts";
import { CheckIcon, CloseIcon } from "../shell/icons.tsx";
import { optionLetter } from "../voice/letters.ts";
import { RESULT_LABEL, TOPIC_LABEL } from "./topics.ts";
import type { QuizState } from "./useQuiz.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The text quiz, one question at a time. A strip of numbered stops shows every
// question and how it went; the current card takes letters or words, then
// shows the grade stamp, feedback, the explanation and the evidence quotes, and
// lights the answer on the map.

/** The text quiz; `active` is the question on screen, shared with the voice coach. */
export function QuizPanel({
  state,
  active,
  onActive,
}: {
  state: QuizState;
  active: string | null;
  onActive: (id: string) => void;
}) {
  const { quiz } = state;
  if (quiz === null) return null;
  const index = Math.max(0, quiz.questions.findIndex((q) => q.id === active));
  const question = quiz.questions[index];
  if (!question) return <p className="muted">This board has no quiz questions yet.</p>;

  return (
    <div className="quiz">
      <ol className="quiz-stops" aria-label="Questions">
        {quiz.questions.map((q, i) => {
          const result = quiz.results[q.id]?.result;
          return (
            <li key={q.id}>
              <button
                type="button"
                className={`quiz-stop ${result ? `is-${result}` : ""} ${i === index ? "is-current" : ""}`}
                aria-current={i === index ? "step" : undefined}
                aria-label={`Question ${i + 1}, ${TOPIC_LABEL[q.topic]}, ${result ? RESULT_LABEL[result] : "not answered"}`}
                onClick={() => onActive(q.id)}
              >
                {i + 1}
              </button>
            </li>
          );
        })}
      </ol>
      <QuestionCard
        key={question.id}
        question={question}
        number={index + 1}
        total={quiz.questions.length}
        attempt={quiz.results[question.id] ?? null}
        state={state}
        onNext={() => {
          const next = quiz.questions.find((q, i) => i > index && !quiz.results[q.id]) ?? quiz.questions[index + 1];
          if (next) onActive(next.id);
        }}
        isLast={index === quiz.questions.length - 1}
      />
    </div>
  );
}

function QuestionCard({
  question,
  number,
  total,
  attempt,
  state,
  onNext,
  isLast,
}: {
  question: QuestionOut;
  number: number;
  total: number;
  attempt: AttemptOut | null;
  state: QuizState;
  onNext: () => void;
  isLast: boolean;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const pending = state.pending === question.id;
  const showResult = attempt !== null && !retrying;

  // A result arriving from the voice coach replaces any half-made choice here.
  useEffect(() => {
    setRetrying(false);
  }, [attempt]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const open = question.kind === "open";
    if (open ? text.trim() === "" : picked.length === 0) {
      setError(open ? "Write your answer first." : "Pick at least one option.");
      return;
    }
    setError(null);
    try {
      await state.submit(question.id, open ? [] : picked, open ? text.trim() : null, "quiz");
      setRetrying(false);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const toggle = (id: string) => {
    if (question.kind === "single") setPicked([id]);
    else setPicked((before) => (before.includes(id) ? before.filter((x) => x !== id) : [...before, id]));
  };

  const how = question.kind === "single" ? "Pick one." : question.kind === "multi" ? "Pick every one that applies." : "Answer in your own words.";

  return (
    <article className="question" aria-labelledby={`${ids}-prompt`}>
      <p className="question-meta">
        <span>
          Question {number} of {total}
        </span>
        <span className="question-topic">{TOPIC_LABEL[question.topic]}</span>
      </p>
      <h3 id={`${ids}-prompt`} className="question-prompt">
        {question.prompt}
      </h3>

      {showResult ? (
        <Result attempt={attempt} question={question} onRetry={() => setRetrying(true)} onNext={onNext} isLast={isLast} />
      ) : (
        <form onSubmit={submit} className="question-form">
          {question.kind === "open" ? (
            <div className="field">
              <label htmlFor={`${ids}-text`} className="visually-hidden">
                Your answer
              </label>
              <textarea
                id={`${ids}-text`}
                className="textarea"
                rows={5}
                maxLength={3000}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Walk it through as you would at the whiteboard..."
                disabled={pending}
              />
            </div>
          ) : (
            <fieldset className="options" disabled={pending}>
              <legend className="options-how">{how}</legend>
              {question.options.map((option, i) => (
                <label key={option.id} className={`option ${picked.includes(option.id) ? "is-picked" : ""}`}>
                  <input
                    type={question.kind === "single" ? "radio" : "checkbox"}
                    name={`${ids}-opt`}
                    checked={picked.includes(option.id)}
                    onChange={() => toggle(option.id)}
                  />
                  <span className="option-letter" aria-hidden="true">
                    {optionLetter(i)}
                  </span>
                  <span className="option-label">{option.label}</span>
                </label>
              ))}
            </fieldset>
          )}
          {question.kind === "open" && <p className="field-hint">{how} A model grades it, which takes a few seconds.</p>}
          {error && (
            <p className="panel-error" role="alert">
              {error}
            </p>
          )}
          <div className="panel-row">
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending && <span className="spinner" aria-hidden="true" />}
              {pending ? (question.kind === "open" ? "Grading your answer..." : "Checking...") : "Submit answer"}
            </button>
            {retrying && (
              <button type="button" className="btn btn-ghost" onClick={() => setRetrying(false)}>
                Back to the result
              </button>
            )}
          </div>
        </form>
      )}
    </article>
  );
}

function Result({
  attempt,
  question,
  onRetry,
  onNext,
  isLast,
}: {
  attempt: AttemptOut;
  question: QuestionOut;
  onRetry: () => void;
  onNext: () => void;
  isLast: boolean;
}) {
  const setHighlight = useBoardUi((s) => s.setHighlight);
  const correct = new Set(attempt.correct_ids);
  const yours = new Set(attempt.your_ids);

  return (
    <div className="result" aria-live="polite">
      <p className={`stamp stamp-${attempt.result}`}>{RESULT_LABEL[attempt.result]}</p>

      {question.kind !== "open" ? (
        <ul className="options options-graded">
          {question.options.map((option, i) => {
            const right = correct.has(option.id);
            const chose = yours.has(option.id);
            const mark = right ? (chose ? "You picked it, and it is right" : "Right answer you missed") : chose ? "You picked it, but it is wrong" : "";
            return (
              <li key={option.id} className={`option ${right ? "is-right" : ""} ${chose && !right ? "is-wrong" : ""} ${chose ? "is-picked" : ""}`}>
                <span className="option-letter" aria-hidden="true">
                  {optionLetter(i)}
                </span>
                <span className="option-label">{option.label}</span>
                {mark && (
                  <span className="option-mark">
                    {right ? <CheckIcon width={15} height={15} /> : <CloseIcon width={15} height={15} />}
                    <span className="visually-hidden">{mark}</span>
                    <span aria-hidden="true">{right ? (chose ? "yes" : "missed") : "no"}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        attempt.your_text && <blockquote className="your-text">{attempt.your_text}</blockquote>
      )}

      <p className="result-feedback">{attempt.feedback}</p>
      <p className="result-explanation">{attempt.explanation}</p>

      {attempt.evidence.length > 0 && (
        <div className="result-evidence">
          <p className="panel-label">From the material</p>
          <ul>
            {attempt.evidence.map((item) => (
              <li key={item.id}>
                <span className="evidence-label">{item.label}</span>
                <q>{item.evidence}</q>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="panel-row">
        {!isLast && (
          <button type="button" className="btn btn-primary" onClick={onNext}>
            Next question
          </button>
        )}
        {attempt.highlight.length > 0 && (
          <button type="button" className="btn" onClick={() => setHighlight(attempt.highlight, "quiz")}>
            Show on the map
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
