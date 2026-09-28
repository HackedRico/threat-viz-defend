import type { QuizOption } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Reads a spoken choice such as "A, C" or "b and d" and maps each letter to an
// option id by position. Speech recognition spells some letters as words, so a
// few of those are accepted too; anything that matches an option id directly
// (such as a STRIDE letter out of letter range) is taken as that id. A single
// choice keeps only the last letter named.

/** Option letter for a zero based position: 0 is `A`. */
export function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

// Only spellings that are rarely real words in an answer; "be" and "see" would misfire. A `Map`, since
// looking a spoken word up on a plain object finds built-ins such as "constructor".
const SPOKEN_LETTERS = new Map([
  ["ay", "a"],
  ["bee", "b"],
  ["cee", "c"],
  ["sea", "c"],
  ["dee", "d"],
]);
const FILLER = new Set(["letter", "letters", "option", "options", "and", "or", "the", "answer", "is", "are", "both"]);

/** The option ids a spoken or typed choice names, in option order, and unmatched words; `single` keeps the last named. */
export function lettersToOptionIds(
  answer: string,
  options: readonly QuizOption[],
  single = false,
): { ids: string[]; unmatched: string[] } {
  const named: string[] = [];
  const unmatched: string[] = [];
  const tokens = answer
    .split(/[\s,;.&/+]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "");
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (FILLER.has(lower)) continue;
    const letter = SPOKEN_LETTERS.get(lower) ?? (lower.length === 1 ? lower : null);
    const position = letter === null ? -1 : letter.charCodeAt(0) - 97;
    const byPosition = position >= 0 ? options[position] : undefined;
    const byId = options.find((option) => option.id.toLowerCase() === lower);
    const match = byPosition ?? byId;
    if (match) named.push(match.id);
    else unmatched.push(token);
  }
  // Speech puts the article "a" before the letter, as in "it's a C", so one pick means the last letter said.
  const ids = single
    ? named.slice(-1)
    : options.filter((option) => named.includes(option.id)).map((option) => option.id);
  return { ids, unmatched };
}
