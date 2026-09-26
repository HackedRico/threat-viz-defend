import type { Threat } from "../api/types.ts";
import type { MapLayout } from "./layout.ts";
import { rankThreats } from "./severity.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Where each threat's numbered pin sits: along the top right edge of its node,
// or just after its flow's label. Pins on one element line up worst first, so
// the most severe pin is always the one nearest the corner.

/** One pin on the canvas. */
export interface Pin {
  threat: Threat;
  x: number;
  y: number;
  number: string;
}

/** Spacing between pins that share an element. */
export const PIN_STEP = 22;

/** Pin positions for every threat whose element is on the canvas. */
export function placePins(threats: readonly Threat[], layout: MapLayout): Pin[] {
  const perElement = new Map<string, number>();
  const pins: Pin[] = [];
  for (const threat of rankThreats(threats)) {
    const slot = perElement.get(threat.element) ?? 0;
    const node = layout.nodes[threat.element];
    const label = layout.edges[threat.element]?.label;
    let x: number;
    let y: number;
    if (node) {
      x = node.x + node.width - 6 - slot * PIN_STEP;
      y = node.y - 2;
    } else if (label) {
      x = label.x + label.width + 12 + slot * PIN_STEP;
      y = label.y + label.height / 2;
    } else {
      continue;
    }
    perElement.set(threat.element, slot + 1);
    pins.push({ threat, x, y, number: threat.id.replace(/\D/g, "") || threat.id });
  }
  return pins;
}
