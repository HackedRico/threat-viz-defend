import type { Threat } from "../api/types.ts";
import type { Box, MapLayout } from "./layout.ts";
import { rankThreats } from "./severity.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Where each threat's numbered pin sits: on the top right corner of its node,
// or beside its flow's label, on whichever side is clear of nodes, labels and
// other pins. Pins on one element line up worst first, so the most severe pin
// is always the one nearest the corner or the label. `pinState` keeps a pin
// bright while its threat or its element is lit.

/** One pin on the canvas. */
export interface Pin {
  threat: Threat;
  x: number;
  y: number;
  number: string;
}

/** How a mark shows while part of the map is lit: bright, faded, or plain when nothing is lit. */
export type LitState = "lit" | "dim" | "";

/** Spacing between pins that share an element. */
export const PIN_STEP = 28;

/** Gap between a flow's label and the center of its first pin, so a pin never covers the label. */
export const LABEL_GAP = 16;

// How far a pin reaches from its center: the widest severity shape plus its outline.
const PIN_REACH = 13;
// Pins sit just inside a node's corner, so the corner itself still shows which node they are on.
const CORNER_INSET = 4;

/** Pin positions for every threat whose element is on the canvas, worst first, as the threat list orders them. */
export function placePins(threats: readonly Threat[], layout: MapLayout): Pin[] {
  const ranked = rankThreats(threats);
  const byElement = new Map<string, Threat[]>();
  for (const threat of ranked) byElement.set(threat.element, [...(byElement.get(threat.element) ?? []), threat]);

  const taken: Box[] = [
    ...Object.values(layout.nodes),
    ...Object.values(layout.boundaryLabels),
    ...Object.values(layout.edges).flatMap((route) => (route.label ? [route.label] : [])),
  ];
  const placed = new Map<string, Pin>();
  for (const [element, onIt] of byElement) {
    const node = layout.nodes[element];
    const label = layout.edges[element]?.label;
    let spots: Array<{ x: number; y: number }>;
    if (node) {
      spots = onIt.map((_, slot) => ({ x: node.x + node.width - CORNER_INSET - slot * PIN_STEP, y: node.y }));
    } else if (label) {
      const y = label.y + label.height / 2;
      const after = onIt.map((_, slot) => ({ x: label.x + label.width + LABEL_GAP + slot * PIN_STEP, y }));
      const before = onIt.map((_, slot) => ({ x: label.x - LABEL_GAP - slot * PIN_STEP, y }));
      // After the label reads first, so it wins a tie; the side before it is for when that is crowded.
      spots = clash(before, taken) < clash(after, taken) ? before : after;
    } else {
      continue;
    }
    onIt.forEach((threat, slot) => {
      const spot = spots[slot]!;
      placed.set(threat.id, { threat, ...spot, number: threat.id.replace(/\D/g, "") || threat.id });
      taken.push(pinBox(spot));
    });
  }
  // Tab order follows the ranking, so moving through the pins reads the threat list in order.
  return ranked.flatMap((threat) => placed.get(threat.id) ?? []);
}

/** How a threat's pin shows while part of the map is lit: bright when its threat or its element is lit. */
export function pinState(threat: Pick<Threat, "id" | "element">, lit: ReadonlySet<string> | null): LitState {
  if (lit === null) return "";
  // A quiz result, an answer or the voice coach lights the element alone, and its pins are what is being discussed.
  return lit.has(threat.id) || lit.has(threat.element) ? "lit" : "dim";
}

function clash(spots: ReadonlyArray<{ x: number; y: number }>, taken: readonly Box[]): number {
  return spots.reduce((sum, spot) => sum + taken.filter((box) => overlaps(pinBox(spot), box)).length, 0);
}

/** The box a pin centered on `spot` covers, for keeping pins apart and for bringing a focused one into view. */
export function pinBox(spot: { x: number; y: number }): Box {
  return { x: spot.x - PIN_REACH, y: spot.y - PIN_REACH, width: PIN_REACH * 2, height: PIN_REACH * 2 };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
