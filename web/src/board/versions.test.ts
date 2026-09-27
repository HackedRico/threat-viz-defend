import { test } from "node:test";
import assert from "node:assert/strict";

import type { MapVersionSummary } from "../api/types.ts";
import { comparePair, threatChanges, versionBar, versionFacts, versionTitle } from "./versions.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks which version chips the canvas shows, which pair a click compares,
// and how threat counts and version names read.

const counts = (critical: number, high = 0) => ({ critical, high, medium: 0, low: 0 });

function version(number: number, overrides: Partial<MapVersionSummary> = {}): MapVersionSummary {
  return {
    number,
    source: "agent",
    label: `Claude Code: change ${number}`,
    created_at: "2026-09-27T10:00:00Z",
    nodes: 12,
    flows: 18,
    counts: null,
    ...overrides,
  };
}

const many = [3, 4, 5, 6, 7, 8].map((n) => version(n));

test("one map shows no bar, since there is nothing to compare", () => {
  assert.equal(versionBar([]), null);
  assert.equal(versionBar([version(1)]), null);
});

test("the bar shows the newest three and folds the rest away", () => {
  const bar = versionBar(many)!;
  assert.deepEqual(
    bar.chips.map((v) => v.number),
    [6, 7, 8],
  );
  assert.equal(bar.hidden, 3);
  assert.equal(bar.current, 8);
  assert.equal(versionBar(many.slice(0, 2))!.hidden, 0);
});

test("a past version compares with the current map, and the current one with the version before", () => {
  assert.deepEqual(comparePair(many, 4), { before: 4, after: 8 });
  assert.deepEqual(comparePair(many, 8), { before: 7, after: 8 });
  assert.deepEqual(comparePair(many, null), { before: 7, after: 8 });
  assert.deepEqual(comparePair(many, 99), { before: 7, after: 8 });
  assert.equal(comparePair([version(1)], 1), null);
});

test("threat changes list only the severities that moved, and nothing when threats are unknown", () => {
  assert.deepEqual(threatChanges(counts(1, 3), counts(2, 3)), [{ severity: "critical", before: 1, after: 2 }]);
  assert.deepEqual(threatChanges(counts(1), counts(1)), []);
  assert.equal(threatChanges(null, counts(1)), null);
});

test("titles and facts read in plain words", () => {
  assert.equal(versionTitle(version(8), 8), "v8 (current), Agent: Claude Code: change 8");
  assert.equal(versionTitle(version(4, { source: "edit", label: "Edited by hand" }), 8), "v4, Hand edit");
  assert.equal(versionTitle(version(1, { source: "example", label: "Built-in example" }), 8), "v1, Example");
  assert.equal(versionTitle(version(2, { source: "upload", label: "Added notes.md." }), 8), "v2, Upload: Added notes.md.");
  assert.equal(versionFacts(version(2)), "12 parts, 18 flows, threats not found yet");
  assert.equal(versionFacts(version(2, { nodes: 1, flows: 1, counts: counts(1, 2) })), "1 part, 1 flow, 3 threats");
});
