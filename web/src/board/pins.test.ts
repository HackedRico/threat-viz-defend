import { test } from "node:test";
import assert from "node:assert/strict";

import type { Threat } from "../api/types.ts";
import type { MapLayout } from "./layout.ts";
import { PIN_STEP, placePins } from "./pins.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks pins line up worst first on a node, follow a flow's label, and skip
// threats pinned to elements that are not drawn.

const layout: MapLayout = {
  width: 500,
  height: 300,
  nodes: { db: { x: 100, y: 50, width: 120, height: 60 } },
  boundaries: {},
  edges: { f1: { id: "f1", points: [], label: { x: 300, y: 200, width: 80, height: 22 } } },
};

const threat = (id: string, element: string, severity: Threat["severity"]): Threat => ({
  id, element, severity, stride: "I", title: id, summary: "", statement: "", impact: "", fixes: [], refs: [], evidence: "",
});

test("places pins worst first along a node and after a flow label", () => {
  const pins = placePins([threat("T4", "db", "low"), threat("T2", "db", "critical"), threat("T3", "f1", "high"), threat("T9", "ghost", "high")], layout);
  assert.deepEqual(pins.map((p) => p.number), ["2", "3", "4"]);
  const [worst, flow, second] = pins;
  assert.equal(worst!.x, 214);
  assert.equal(second!.x, 214 - PIN_STEP);
  assert.deepEqual([flow!.x, flow!.y], [392, 211]);
});
