import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { SystemMap, ThreatAnalysis } from "../api/types.ts";
import { codeLocation, codeSpans, expandHighlight, flowLabel, labelOf, pathFlows, splitIds } from "./elements.ts";
import { diffMaps, hasChanges } from "./mapDiff.ts";
import { flowsTouching, mapProblem, removeElement, updateFlow, updateNode } from "./mapEdit.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks the map helpers against the example board: naming ids as the server
// does, lighting up attack paths hop by hop, diffing two maps, and hand edits
// that keep the map drawable.

const example = JSON.parse(readFileSync(new URL("../../../api/app/examples/inbox_helper/board.json", import.meta.url), "utf8")) as {
  map: SystemMap;
  analysis: ThreatAnalysis;
};
const { map, analysis } = example;

test("names nodes, flows and threats like the server", () => {
  assert.equal(labelOf("db", map, analysis), "Postgres");
  assert.equal(labelOf("f15", map, analysis), "Triage agent to Any website: fetch_url");
  assert.equal(labelOf("T2", map, analysis), "T2 fetch_url carries mail out in a link");
  assert.equal(labelOf("nope", map, analysis), "nope");
  assert.equal(flowLabel(map, map.flows[0]!), "Email senders to Gmail API: send email");
});

test("lights an attack path's steps, hops and threats", () => {
  const p1 = analysis.paths[0]!;
  assert.deepEqual(pathFlows(p1, map), ["f1", "f2", "f8", "f11", "f14"]);
  const lit = expandHighlight(["P1"], map, analysis);
  for (const id of ["senders", "agent", "f14", "T1"]) assert.ok(lit.includes(id), id);
});

test("lights a threat together with its element", () => {
  assert.deepEqual(expandHighlight(["T3", "ghost"], map, analysis).sort(), ["T3", "f16"]);
});

test("splits spoken id lists", () => {
  assert.deepEqual(splitIds("db, f3 and T1"), ["db", "f3", "T1"]);
  assert.deepEqual(splitIds("  agent;f15  "), ["agent", "f15"]);
});

test("diffs added, changed and removed elements", () => {
  const next = updateNode(removeElement(map, "logs"), "db", { sensitive: false });
  const withNew = { ...next, nodes: [...next.nodes, { ...map.nodes[0]!, id: "admin", label: "Admin" }] };
  const diff = diffMaps(map, withNew);
  assert.deepEqual(diff.added, ["admin"]);
  assert.deepEqual(diff.changed, ["db"]);
  assert.deepEqual(diff.removed.map((r) => r.id), ["logs", "f16"]);
  assert.equal(hasChanges(diffMaps(null, map)), false);
  assert.equal(hasChanges(diffMaps(map, { ...map, nodes: map.nodes.map((n) => ({ ...n, evidence: "new" })) })), false);
});

test("deleting a node deletes its flows and leaves the old map alone", () => {
  assert.deepEqual(flowsTouching(map, "queue"), ["f9", "f10"]);
  const edited = removeElement(map, "queue");
  assert.equal(edited.nodes.some((n) => n.id === "queue"), false);
  assert.equal(edited.flows.some((f) => f.id === "f9" || f.id === "f10"), false);
  assert.equal(map.nodes.some((n) => n.id === "queue"), true);
  assert.equal(removeElement(map, "f1").flows.length, map.flows.length - 1);
});

test("refuses blank names", () => {
  assert.equal(mapProblem(map), null);
  assert.match(mapProblem(updateNode(map, "db", { label: " " })) ?? "", /db/);
  assert.match(mapProblem(updateFlow(map, "f1", { label: "" })) ?? "", /f1/);
});

test("a code reference reads as path:line, or the path when there is no line", () => {
  assert.equal(codeLocation({ path: "worker/sync.py", line: 42, symbol: "poll_inbox" }), "worker/sync.py:42");
  assert.equal(codeLocation({ path: "worker/sync.py", line: null, symbol: null }), "worker/sync.py");
});

test("backticks mark code runs, and an unmatched one stays literal", () => {
  assert.deepEqual(codeSpans("runs `poll_inbox` every `120` seconds"), [
    { text: "runs ", code: false },
    { text: "poll_inbox", code: true },
    { text: " every ", code: false },
    { text: "120", code: true },
    { text: " seconds", code: false },
  ]);
  assert.deepEqual(codeSpans("a stray ` tick"), [{ text: "a stray ` tick", code: false }]);
  assert.deepEqual(codeSpans("`send_email`"), [{ text: "send_email", code: true }]);
});
