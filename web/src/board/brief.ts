import type { SeverityCounts } from "../api/types.ts";
import { SEVERITIES, totalThreats } from "./severity.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The words on the brief card, the first thing a reader with no security
// background sees on a finished board. Counts become one plain sentence so the
// card reads without knowing what a severity badge or an attack path is.

/** One sentence on how many threats were found, by severity, and how many attack paths join them. */
export function findingsLine(counts: SeverityCounts, paths: number): string {
  const total = totalThreats(counts);
  if (total === 0) return "The analysis found no threats on this map.";
  const levels = SEVERITIES.filter((level) => counts[level] > 0).map((level) => `${counts[level]} ${level}`);
  const ways = total === 1 ? "1 way" : `${total} ways`;
  const found = `The analysis found ${ways} an attacker could cause harm: ${joinAnd(levels)}.`;
  if (paths === 0) return found;
  return `${found} ${paths === 1 ? "1 attack path chains" : `${paths} attack paths chain`} them into step by step attacks.`;
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
