import type { MemoryUse, QuizFocus } from "../api/types.ts";
import { TOPIC_LABEL } from "../quiz/topics.ts";
import { MemoryIcon } from "../shell/icons.tsx";
import "./Memory.css";

// =============================================================================
// Module Overview
// =============================================================================
// Backboard memory at work, shown where it happens. `MemoryTrace` sits under
// an answer or a graded quiz answer: the earlier notes that were fed into the
// model, and that a note of this one was kept. `MemoryFocus` sits above the
// quiz when memory says which topics the developer found hard, which is why
// those questions come first. Notes render as plain text.

/** What memory did around one answer or grade. */
export function MemoryTrace({ memory, what }: { memory: MemoryUse; what: "answer" | "grade" }) {
  const count = memory.recalled.length;
  return (
    <div className="memory-trace">
      <MemoryIcon width={15} height={15} className="memory-mark" />
      {count > 0 ? (
        <details className="memory-recalled">
          <summary>
            Backboard fed {count} earlier {count === 1 ? "note" : "notes"} into this {what}
          </summary>
          <ul>
            {memory.recalled.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </details>
      ) : (
        <span className="memory-none">Backboard has no earlier notes on this yet</span>
      )}
      {memory.kept && <span className="memory-kept">Saved to memory</span>}
    </div>
  );
}

/** The topics memory says were hard before, which the quiz now asks first. */
export function MemoryFocus({ focus }: { focus: QuizFocus }) {
  return (
    <div className="memory-focus" role="note">
      <MemoryIcon width={18} height={18} className="memory-mark" />
      <div className="memory-focus-body">
        <p>
          <strong>From Backboard memory:</strong> you found these hard in earlier sessions, so they come first.
        </p>
        <div className="memory-topics">
          {focus.topics.map((topic) => (
            <span key={topic} className="chip memory-topic">
              {TOPIC_LABEL[topic]}
            </span>
          ))}
        </div>
        {focus.notes.length > 0 && (
          <details className="memory-recalled">
            <summary>What memory recalled</summary>
            <ul>
              {focus.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
