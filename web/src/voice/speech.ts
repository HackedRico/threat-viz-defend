import type { AttemptOut, Mastery, QuestionOut, QuizOut } from "../api/types.ts";
import { optionLetter } from "./letters.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The words the voice coach's client tools hand back to the agent to read out.
// Each builder writes plain sentences with no markup, since everything here is
// spoken, and names questions by id so the agent can answer them.

/** The first question with no result yet, or `null` when every question is answered. */
export function nextQuestion(quiz: Pick<QuizOut, "questions" | "results">): QuestionOut | null {
  return quiz.questions.find((question) => quiz.results[question.id] === undefined) ?? null;
}

/** A question read aloud: number, id, prompt, lettered options and how to answer. */
export function questionSpeech(question: QuestionOut, index: number, total: number): string {
  const head = `Question ${index + 1} of ${total}, id ${question.id}. ${sentence(question.prompt)}`;
  if (question.kind === "open") return `${head} Answer in your own words.`;
  const options = question.options.map((option, i) => `${optionLetter(i)}, ${sentence(option.label)}`).join(" ");
  const how = question.kind === "single" ? "Pick one letter." : "Say every letter that applies.";
  return `${head} Options: ${options} ${how}`;
}

/** The score and weak spots, read when every question is answered. */
export function doneSpeech(mastery: Mastery, weakLabels: readonly string[]): string {
  const percent = Math.round(mastery.score * 100);
  const parts = [`All ${mastery.total} questions are answered. Score ${percent} percent: ${mastery.correct} correct`];
  if (mastery.partial > 0) parts.push(`, ${mastery.partial} partly right`);
  const weak = weakLabels.length > 0 ? ` Weak spots to review: ${joinWords(weakLabels)}.` : " No weak spots left.";
  return `${parts.join("")}.${weak}`;
}

/** A graded answer for the agent to read out. */
export function resultSpeech(attempt: Pick<AttemptOut, "result" | "feedback" | "explanation">): string {
  const verdict = attempt.result === "partial" ? "partly right" : attempt.result;
  return [`Result: ${verdict}.`, sentence(attempt.feedback), sentence(attempt.explanation)].filter(Boolean).join(" ");
}

/** What `show_on_board` reports back: the labels shown and the ids it could not find. */
export function showingSpeech(labels: readonly string[], missing: readonly string[]): string {
  const shown = labels.length > 0 ? `Showing ${joinWords(labels)}.` : "Nothing to show.";
  return missing.length > 0 ? `${shown} Not on this board: ${joinWords(missing)}.` : shown;
}

/** Join words as `a, b and c`. */
export function joinWords(words: readonly string[]): string {
  const kept = words.filter((word) => word !== "");
  if (kept.length <= 1) return kept.join("");
  return `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return /[.?!:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
