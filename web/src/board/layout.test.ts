import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ELK from "elkjs/lib/elk.bundled.js";

import type { SystemMap } from "../api/types.ts";
import { clip, layoutKey, midpoint, nodeSize, placeLabels, readLayout, roundedPath, toElkGraph, trimEnd } from "./layout.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Runs real ELK on the example board and checks that every node lands inside
// its trust boundary, every flow gets a route that starts and ends on its two
// nodes, and labels do not collide with nodes. This is what keeps the canvas
// readable at the example's 12 nodes and 18 flows.

const example = JSON.parse(readFileSync(new URL("../../../api/app/examples/inbox_helper/board.json", import.meta.url), "utf8")) as { map: SystemMap };
const map = example.map;

async function layOut(system: SystemMap) {
  const elk = new ELK();
  return placeLabels(readLayout(await elk.layout(toElkGraph(system))), system.flows);
}

const inside = (inner: { x: number; y: number; width: number; height: number }, outer: typeof inner, slack = 0.5) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;

test("nests every bounded node inside its boundary", async () => {
  const layout = await layOut(map);
  assert.equal(Object.keys(layout.nodes).length, map.nodes.length);
  assert.deepEqual(Object.keys(layout.boundaries).sort(), ["backend", "browser"]);
  for (const node of map.nodes) {
    const box = layout.nodes[node.id]!;
    if (node.boundary) assert.ok(inside(box, layout.boundaries[node.boundary]!), `${node.id} escapes ${node.boundary}`);
    else for (const [id, zone] of Object.entries(layout.boundaries)) assert.ok(!inside(box, zone), `${node.id} is inside ${id}`);
  }
});

test("routes every flow from its source to its target in absolute coordinates", async () => {
  const layout = await layOut(map);
  const near = (p: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }) =>
    p.x >= box.x - 2 && p.x <= box.x + box.width + 2 && p.y >= box.y - 2 && p.y <= box.y + box.height + 2;
  for (const flow of map.flows) {
    const route = layout.edges[flow.id]!;
    assert.ok(route.points.length >= 2, `${flow.id} has no route`);
    assert.ok(near(route.points[0]!, layout.nodes[flow.source]!), `${flow.id} does not start on ${flow.source}`);
    assert.ok(near(route.points.at(-1)!, layout.nodes[flow.target]!), `${flow.id} does not end on ${flow.target}`);
    assert.ok(route.label, `${flow.id} has no label box`);
  }
});

test("keeps flow labels off the nodes and off each other", async () => {
  const layout = await layOut(map);
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const routes = Object.values(layout.edges);
  for (const route of routes) {
    for (const [id, box] of Object.entries(layout.nodes)) {
      assert.ok(!overlaps(route.label!, box), `label of ${route.id} covers ${id}`);
    }
    for (const other of routes) {
      if (other.id !== route.id) assert.ok(!overlaps(route.label!, other.label!), `${route.id} and ${other.id} labels collide`);
    }
  }
});

test("stays wide rather than tall but no wider than a few screens", async () => {
  const layout = await layOut(map);
  assert.ok(layout.width < 1900, `example is ${layout.width} wide`);
  assert.ok(layout.height < layout.width);
});

test("skips flows to missing nodes and empty boundaries", () => {
  const broken: SystemMap = {
    ...map,
    boundaries: [...map.boundaries, { id: "ghost", label: "Nothing here" }],
    flows: [...map.flows, { id: "f99", source: "user", target: "nowhere", label: "lost", data: null, evidence: null }],
  };
  const graph = toElkGraph(broken);
  assert.equal(graph.edges?.some((edge) => edge.id === "f99"), false);
  assert.equal(graph.children?.some((child) => child.id === "boundary:ghost"), false);
});

test("sizes nodes from their text within bounds", () => {
  const small = nodeSize({ label: "DB", tech: null, kind: "process" });
  const store = nodeSize({ label: "DB", tech: null, kind: "store" });
  const long = nodeSize({ label: "A very long component name here", tech: "Something", kind: "external" });
  assert.equal(small.width, 124);
  assert.ok(store.height > small.height);
  assert.equal(long.width, 230);
  assert.equal(clip("abcdef", 4), "abc…");
});

test("keys layout on structure, not on flags", () => {
  const flagged = { ...map, nodes: map.nodes.map((n) => ({ ...n, sensitive: !n.sensitive, evidence: "x" })) };
  assert.equal(layoutKey(flagged), layoutKey(map));
  const renamed = { ...map, nodes: map.nodes.map((n, i) => (i === 0 ? { ...n, label: "Someone" } : n)) };
  assert.notEqual(layoutKey(renamed), layoutKey(map));
});

test("finds the midpoint and rounds corners", () => {
  assert.deepEqual(midpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), { x: 10, y: 0 });
  assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 20, y: 0 }]), "M0,0 L20,0");
  assert.match(roundedPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], 5), /Q20,0/);
});

test("trims a polyline from its end", () => {
  assert.deepEqual(trimEnd([{ x: 0, y: 0 }, { x: 20, y: 0 }], 5), [{ x: 0, y: 0 }, { x: 15, y: 0 }]);
  assert.deepEqual(trimEnd([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 3 }], 5), [{ x: 0, y: 0 }, { x: 8, y: 0 }]);
});
