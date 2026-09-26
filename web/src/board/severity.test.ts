import { test } from "node:test";
import assert from "node:assert/strict";

import type { Threat } from "../api/types.ts";
import { rankThreats, shapePoints, topSeverity, totalThreats } from "./severity.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks the worst-severity pick for sidebar badges and the ranking order the
// threat list shows.

test("picks the worst severity present", () => {
  assert.equal(topSeverity({ critical: 0, high: 2, medium: 1, low: 0 }), "high");
  assert.equal(topSeverity({ critical: 0, high: 0, medium: 0, low: 0 }), null);
  assert.equal(totalThreats({ critical: 1, high: 2, medium: 3, low: 4 }), 10);
});

test("ranks by severity then by id number", () => {
  const threat = (id: string, severity: Threat["severity"]): Threat => ({
    id, severity, element: "x", stride: "S", title: id, summary: "", statement: "", impact: "", fixes: [], refs: [], evidence: "",
  });
  const ranked = rankThreats([threat("T10", "high"), threat("T2", "low"), threat("T9", "high"), threat("T1", "critical")]);
  assert.deepEqual(ranked.map((t) => t.id), ["T1", "T9", "T10", "T2"]);
});

test("draws polygons for every shape but the circle", () => {
  assert.equal(shapePoints("circle", 8), null);
  assert.equal(shapePoints("triangle", 8)?.split(" ").length, 3);
  assert.equal(shapePoints("octagon", 8)?.split(" ").length, 8);
});
