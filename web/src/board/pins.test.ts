import { test } from "node:test";
import assert from "node:assert/strict";

import type { Threat } from "../api/types.ts";
import type { MapLayout } from "./layout.ts";
import { LABEL_GAP, PIN_STEP, pinState, placePins } from "./pins.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks pins line up worst first on a node's top right corner, follow a
// flow's label on whichever side is clear, keep the threat list's order, skip
// threats pinned to elements that are not drawn, and stay bright while their
// threat or their element is lit.

const layout: MapLayout = {
  direction: "DOWN",
  width: 600,
  height: 300,
  nodes: { db: { x: 100, y: 50, width: 120, height: 60 } },
  boundaries: {},
  boundaryLabels: {},
  edges: { f1: { id: "f1", points: [], label: { x: 300, y: 200, width: 80, height: 22 }, lane: 0 } },
};

const threat = (id: string, element: string, severity: Threat["severity"]): Threat => ({
  id, element, severity, stride: "I", title: id, summary: "", statement: "", impact: "", fixes: [], refs: [], evidence: "",
});

test("places pins worst first along a node's top edge and after a flow label", () => {
  const pins = placePins([threat("T4", "db", "low"), threat("T2", "db", "critical"), threat("T3", "f1", "high"), threat("T9", "ghost", "high")], layout);
  assert.deepEqual(pins.map((p) => p.number), ["2", "3", "4"]);
  const [worst, flow, second] = pins;
  assert.deepEqual([worst!.x, worst!.y], [216, 50]);
  assert.equal(second!.x, 216 - PIN_STEP);
  assert.deepEqual([flow!.x, flow!.y], [380 + LABEL_GAP, 211]);
});

test("moves a flow's pins before its label when a node sits right after it", () => {
  const crowded: MapLayout = { ...layout, nodes: { ...layout.nodes, api: { x: 392, y: 190, width: 120, height: 60 } } };
  const pins = placePins([threat("T1", "f1", "critical"), threat("T5", "f1", "medium")], crowded);
  assert.deepEqual(pins.map((p) => p.x), [300 - LABEL_GAP, 300 - LABEL_GAP - PIN_STEP]);
});

test("a pin stays bright while its threat or its element is lit, and fades for anything else", () => {
  const onAgent = threat("T1", "agent", "critical");
  assert.equal(pinState(onAgent, null), "");
  // A quiz result, an answer or the voice coach lights the element alone.
  assert.equal(pinState(onAgent, new Set(["agent", "db"])), "lit");
  // Opening the threat lights its pin and its element.
  assert.equal(pinState(onAgent, new Set(["T1", "agent"])), "lit");
  assert.equal(pinState(onAgent, new Set(["T1"])), "lit");
  assert.equal(pinState(onAgent, new Set(["db", "T6"])), "dim");
});
