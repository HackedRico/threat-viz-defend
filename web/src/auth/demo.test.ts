import { test } from "node:test";
import assert from "node:assert/strict";

import { arrowHead, DEMO_STAGES, nextStage } from "./demo.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks that the home page demo loops through its steps and that arrowheads
// land on the end of their flow.

test("plays every step in order, then starts over", () => {
  const seen = [0];
  for (let i = 0; i < DEMO_STAGES.length; i += 1) seen.push(nextStage(seen[seen.length - 1]!));
  assert.deepEqual(seen, [0, 1, 2, 3, 0]);
  assert.ok(DEMO_STAGES.every((stage) => stage.ms > 0));
});

test("puts the arrowhead's tip on the end of the flow, behind it", () => {
  const d = arrowHead(0, 0, 100, 0);
  assert.match(d, / L100,0 L/);
  const xs = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  assert.ok(xs.every((x) => x <= 100));
});
