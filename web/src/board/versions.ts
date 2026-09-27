import type { MapVersionSummary, Severity, SeverityCounts, VersionSource } from "../api/types.ts";
import { SEVERITIES } from "./severity.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The logic behind the map's version bar and compare dialog, kept free of React
// so it is tested directly. `versionBar` picks the few chips the canvas shows
// and counts the rest, `comparePair` decides which two versions a click opens,
// and `threatChanges` says how the threats moved between two versions.

/** How many version chips the canvas shows; older ones wait behind the history button. */
export const VISIBLE_CHIPS = 3;

/** What the canvas shows: the newest few versions, and how many older ones are folded away. */
export interface VersionBar {
  chips: MapVersionSummary[];
  hidden: number;
  current: number;
}

/** The chips for `versions` (oldest first), or `null` when there is only one map and nothing to compare. */
export function versionBar(versions: readonly MapVersionSummary[], visible = VISIBLE_CHIPS): VersionBar | null {
  if (versions.length < 2) return null;
  const chips = versions.slice(-visible);
  return { chips, hidden: versions.length - chips.length, current: versions[versions.length - 1]!.number };
}

/** The two versions a click compares: a past version against the current map, or the current one against the one before. */
export function comparePair(versions: readonly MapVersionSummary[], clicked: number | null): { before: number; after: number } | null {
  if (versions.length < 2) return null;
  const current = versions[versions.length - 1]!.number;
  const previous = versions[versions.length - 2]!.number;
  if (clicked === null || clicked === current || !versions.some((v) => v.number === clicked)) {
    return { before: previous, after: current };
  }
  return { before: clicked, after: current };
}

/** One severity whose threat count differs between two versions. */
export interface ThreatChange {
  severity: Severity;
  before: number;
  after: number;
}

/** Severities whose counts differ; `null` when either version never had its threats found, so none can be told. */
export function threatChanges(before: SeverityCounts | null, after: SeverityCounts | null): ThreatChange[] | null {
  if (before === null || after === null) return null;
  return SEVERITIES.filter((severity) => before[severity] !== after[severity]).map((severity) => ({
    severity,
    before: before[severity],
    after: after[severity],
  }));
}

const SOURCE_WORDS: Record<VersionSource, string> = {
  example: "Example",
  upload: "Upload",
  github: "GitHub",
  agent: "Agent",
  edit: "Hand edit",
  earlier: "Earlier",
};

/** A short word for what made a version, for badges. */
export function sourceWord(source: VersionSource): string {
  return SOURCE_WORDS[source];
}

// Sources whose label only restates the source, so a title shows the source alone.
const PLAIN_SOURCES: ReadonlySet<VersionSource> = new Set(["edit", "example"]);

/** One line naming a version for menus and tooltips, such as "v4, Agent: Claude Code: added a cache". */
export function versionTitle(version: MapVersionSummary, current: number): string {
  const tag = version.number === current ? " (current)" : "";
  const what = PLAIN_SOURCES.has(version.source) ? sourceWord(version.source) : `${sourceWord(version.source)}: ${version.label}`;
  return `v${version.number}${tag}, ${what}`;
}

/** Parts, flows and threats in a few words, such as "12 parts, 18 flows, 7 threats". */
export function versionFacts(version: MapVersionSummary): string {
  const parts = `${version.nodes} part${version.nodes === 1 ? "" : "s"}, ${version.flows} flow${version.flows === 1 ? "" : "s"}`;
  if (version.counts === null) return `${parts}, threats not found yet`;
  const total = SEVERITIES.reduce((sum, severity) => sum + version.counts![severity], 0);
  return `${parts}, ${total} threat${total === 1 ? "" : "s"}`;
}
