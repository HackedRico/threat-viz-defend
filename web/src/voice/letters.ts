import type { QuizOption } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Reads a spoken choice such as "A, C" or "b and d" and maps each letter to an
// option id by position. Speech recognition spells some letters as words, so a
// few of those are accepted too; anything that matches an option id directly
// (such as a STRIDE letter out of letter range) is taken as that id.

/** Option letter for a zero based position: 0 is `A`. */
export function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

// Only spellings that are rarely real words in an answer; "be" and "see" would misfire.
const SPOKEN_LETTERS: Record<string, string> = { ay: "a", bee: "b", cee: "c", sea: "c", dee: "d" };
const FILLER = new Set(["letter", "letters", "option", "options", "and", "or", "the", "answer", "is", "are", "both"]);

/** The option ids a spoken or typed choice names, in option order, and any words that matched nothing. */
export function lettersToOptionIds(answer: string, options: readonly QuizOption[]): { ids: string[]; unmatched: string[] } {
  const picked = new Set<string>();
  const unmatched: string[] = [];
  const tokens = answer
    .split(/[\s,;.&/+]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "");
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (FILLER.has(lower)) continue;
    const letter = SPOKEN_LETTERS[lower] ?? (lower.length === 1 ? lower : null);
    const position = letter === null ? -1 : letter.charCodeAt(0) - 97;
    const byPosition = position >= 0 ? options[position] : undefined;
    const byId = options.find((option) => option.id.toLowerCase() === lower);
    const match = byPosition ?? byId;
    if (match) picked.add(match.id);
    else unmatched.push(token);
  }
  return { ids: options.filter((option) => picked.has(option.id)).map((option) => option.id), unmatched };
}
