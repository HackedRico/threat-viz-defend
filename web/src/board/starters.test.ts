import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { ExposureOut, SystemMap, ThreatAnalysis } from "../api/types.ts";
import { starterQuestions } from "./starters.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks that the ask bar's starter questions name parts of the board they
// sit on, on the example and on a board with no AI part or no store.

const example = JSON.parse(
  readFileSync(new URL("../../../api/app/examples/inbox_helper/board.json", import.meta.url), "utf8"),
) as { map: SystemMap; analysis: ThreatAnalysis; questions: Record<string, unknown> };

const lethalAgent: ExposureOut = { node: "agent", lethal: true, untrusted: ["f1"], private_data: ["db"], outbound: ["f9"] };

test("the example asks about its triage agent and its sensitive store", () => {
  assert.deepEqual(starterQuestions(example.map, example.analysis, [lethalAgent]), [
    "What should I fix first, and why?",
    "What can untrusted input make Triage agent do?",
    "What happens if Postgres leaks?",
  ]);
});

test("demo mode has a recorded answer for every starter question on the example", () => {
  // Without a model the server answers only the example's recorded questions, and the starters are what people try first.
  for (const question of starterQuestions(example.map, example.analysis, [lethalAgent])) {
    assert.ok(question in example.questions, `record an answer to "${question}" in the example's board.json`);
  }
});

test("a board with no AI part asks about the part its worst threat sits on", () => {
  const map: SystemMap = {
    ...example.map,
    nodes: example.map.nodes.map((n) => ({ ...n, ai: false })),
  };
  const analysis: ThreatAnalysis = {
    ...example.analysis,
    threats: example.analysis.threats.map((t) => (t.id === "T1" ? { ...t, element: "api" } : t)),
  };
  assert.equal(starterQuestions(map, analysis, [])[1], "How could an attacker get into API?");
});

test("a board with no store and no threats keeps only the first question", () => {
  const map: SystemMap = { ...example.map, nodes: example.map.nodes.filter((n) => n.kind !== "store" && !n.ai) };
  assert.deepEqual(starterQuestions(map, { ...example.analysis, threats: [] }, []), ["What should I fix first, and why?"]);
});
