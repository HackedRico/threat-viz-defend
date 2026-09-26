import type { Severity, SeverityCounts, Stride, Threat } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Severity and STRIDE facts the whole app shares: the order severities rank in,
// the worst severity on a board, and the name of each STRIDE letter. Pins and
// badges also get a shape per severity so color is never the only signal.

/** Severities from most to least severe. */
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

/** The shape drawn for each severity, so the level reads without color. */
export const SEVERITY_SHAPE: Record<Severity, "octagon" | "triangle" | "circle" | "square"> = {
  critical: "octagon",
  high: "triangle",
  medium: "circle",
  low: "square",
};

/** STRIDE letters with the category name and the property each breaks. */
export const STRIDE: Record<Stride, { name: string; property: string }> = {
  S: { name: "Spoofing", property: "authentication" },
  T: { name: "Tampering", property: "integrity" },
  R: { name: "Repudiation", property: "accountability" },
  I: { name: "Information disclosure", property: "confidentiality" },
  D: { name: "Denial of service", property: "availability" },
  E: { name: "Elevation of privilege", property: "authorization" },
};

/** Rank of a severity, 0 for critical. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** The most severe level with at least one threat, or `null` when there are none. */
export function topSeverity(counts: SeverityCounts): Severity | null {
  return SEVERITIES.find((level) => counts[level] > 0) ?? null;
}

/** How many threats the counts add up to. */
export function totalThreats(counts: SeverityCounts): number {
  return SEVERITIES.reduce((sum, level) => sum + counts[level], 0);
}

/** Threats from most to least severe, ties broken by the number in the id so `T10` follows `T9`. */
export function rankThreats(threats: readonly Threat[]): Threat[] {
  return [...threats].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || idNumber(a.id) - idNumber(b.id),
  );
}

function idNumber(id: string): number {
  const digits = id.replace(/\D/g, "");
  return digits === "" ? 0 : Number.parseInt(digits, 10);
}

/** SVG polygon points for a severity shape centered on 0,0 with radius `r`. */
export function shapePoints(shape: (typeof SEVERITY_SHAPE)[Severity], r: number): string | null {
  if (shape === "circle") return null;
  const sides = shape === "octagon" ? 8 : shape === "triangle" ? 3 : 4;
  // Octagons sit flat on a side and squares on an edge, so offset their first vertex by half a step.
  const offset = shape === "triangle" ? -Math.PI / 2 : Math.PI / sides;
  const radius = shape === "triangle" ? r * 1.2 : shape === "square" ? r * 1.15 : r * 1.05;
  const points: string[] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = offset + (i * 2 * Math.PI) / sides;
    points.push(`${(Math.cos(angle) * radius).toFixed(2)},${(Math.sin(angle) * radius).toFixed(2)}`);
  }
  return points.join(" ");
}
