// =============================================================================
// Module Overview
// =============================================================================
// The steps the home page demo plays through, as `DEMO_STAGES`, and the bits
// of geometry it draws with. `nextStage` loops the demo back to the start, and
// `arrowHead` draws the open arrowhead at the end of a flow.

/** One step of the home page demo. */
export interface DemoStage {
  label: string;
  status: string;
  ms: number;
}

/** The demo's steps in order: material in, the map, the threats, then a quiz answer. */
export const DEMO_STAGES: readonly DemoStage[] = [
  { label: "Add material", status: "Drawing the map", ms: 3200 },
  { label: "Check the map", status: "Check the map", ms: 3800 },
  { label: "Read the threats", status: "Ready to defend", ms: 3800 },
  { label: "Defend it", status: "Ready to defend", ms: 4200 },
];

/** The step after `index`, back to the first after the last. */
export function nextStage(index: number): number {
  return (index + 1) % DEMO_STAGES.length;
}

/** Path data for an open arrowhead whose tip sits at `(toX, toY)`, pointing away from `(fromX, fromY)`. */
export function arrowHead(fromX: number, fromY: number, toX: number, toY: number, size = 9): string {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const spread = Math.PI / 7;
  const point = (turn: number) =>
    `${(toX - size * Math.cos(angle + turn)).toFixed(1)},${(toY - size * Math.sin(angle + turn)).toFixed(1)}`;
  return `M${point(spread)} L${toX},${toY} L${point(-spread)}`;
}
