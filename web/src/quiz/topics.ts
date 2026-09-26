import type { QuestionTopic, Result } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Words for quiz topics and results, shared by the text quiz and the voice
// coach's transcript so both describe a question the same way.

/** A short heading for each question topic. */
export const TOPIC_LABEL: Record<QuestionTopic, string> = {
  boundary: "Trust boundaries",
  data: "Sensitive data",
  threat: "Where it breaks",
  stride: "STRIDE",
  trifecta: "Lethal trifecta",
  attack: "Attack path",
  fix: "The fix",
};

/** How each result reads on the page. */
export const RESULT_LABEL: Record<Result, string> = {
  correct: "Correct",
  partial: "Partly right",
  wrong: "Not quite",
};
