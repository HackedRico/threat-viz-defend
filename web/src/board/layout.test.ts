import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";

import type { SystemMap } from "../api/types.ts";
import {
  clip,
  DIRECTIONS,
  LANE_GAP,
  layoutKey,
  layOutMap,
  layoutProblems,
  LINE_HEIGHT,
  midpoint,
  MIN_CLEARANCE,
  nodeSize,
  nodeText,
  pickDirection,
  roundedPath,
  toElkGraph,
  trimEnd,
  type Box,
  type Direction,
  type LayoutEngine,
  type MapLayout,
  type Point,
} from "./layout.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Runs real ELK on the example board in both directions and checks what keeps
// the canvas readable: nodes inside their boundaries and 40px apart, flows that
// start and end on their nodes, two way flows on one track, labels clear of
// nodes, lines and each other, and a fake engine for the spread and retry loop.

const example = JSON.parse(readFileSync(new URL("../../../api/app/examples/inbox_helper/board.json", import.meta.url), "utf8")) as { map: SystemMap };
const map = example.map;
const elk = new ELK();

const layOut = (system: SystemMap, direction: Direction) => layOutMap(elk, system, direction);

const inside = (inner: Box, outer: Box, slack = 0.5) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const crosses = (start: Point, end: Point, box: Box) =>
  Math.min(start.x, end.x) < box.x + box.width &&
  Math.max(start.x, end.x) > box.x &&
  Math.min(start.y, end.y) < box.y + box.height &&
  Math.max(start.y, end.y) > box.y;

const segments = (points: readonly Point[]) => points.slice(1).map((end, i) => ({ start: points[i]!, end }));

// The widest stretch of a boundary's name band, inside its side insets, that no flow passes through.
function widestGap(layout: MapLayout, zone: Box, name: Box): number {
  const band = { x: zone.x + 18, y: name.y - 4, width: zone.width - 36, height: name.height + 8 };
  const blocked = Object.values(layout.edges)
    .flatMap((route) => segments(route.points))
    .filter(({ start, end }) => crosses(start, end, band))
    .map(({ start, end }) => [Math.min(start.x, end.x) - 4, Math.max(start.x, end.x) + 4] as const)
    .sort((a, b) => a[0] - b[0]);
  let widest = 0;
  let from = band.x;
  for (const [left, right] of blocked) {
    widest = Math.max(widest, left - from);
    from = Math.max(from, right);
  }
  return Math.max(widest, band.x + band.width - from);
}

for (const direction of DIRECTIONS) {
  test(`nests every bounded node inside its boundary, ${direction}`, async () => {
    const layout = await layOut(map, direction);
    assert.equal(layout.direction, direction);
    assert.equal(Object.keys(layout.nodes).length, map.nodes.length);
    assert.deepEqual(Object.keys(layout.boundaries).sort(), ["backend", "browser"]);
    for (const node of map.nodes) {
      const box = layout.nodes[node.id]!;
      if (node.boundary) assert.ok(inside(box, layout.boundaries[node.boundary]!), `${node.id} escapes ${node.boundary}`);
      else for (const [id, zone] of Object.entries(layout.boundaries)) assert.ok(!inside(box, zone), `${node.id} is inside ${id}`);
    }
  });

  test(`routes every flow from its source to its target in absolute coordinates, ${direction}`, async () => {
    const layout = await layOut(map, direction);
    const near = (p: Point, box: Box) => p.x >= box.x - 2 && p.x <= box.x + box.width + 2 && p.y >= box.y - 2 && p.y <= box.y + box.height + 2;
    for (const flow of map.flows) {
      const route = layout.edges[flow.id]!;
      assert.ok(route.points.length >= 2, `${flow.id} has no route`);
      assert.ok(near(route.points[0]!, layout.nodes[flow.source]!), `${flow.id} does not start on ${flow.source}`);
      assert.ok(near(route.points.at(-1)!, layout.nodes[flow.target]!), `${flow.id} does not end on ${flow.target}`);
      assert.ok(route.label, `${flow.id} has no label box`);
    }
  });

  test(`keeps nodes the guide's clearance apart and labels off nodes and each other, ${direction}`, async () => {
    const layout = await layOut(map, direction);
    assert.deepEqual(layoutProblems(layout), []);
  });

  test(`leaves every node's top right corner free for its threat pins, ${direction}`, async () => {
    const layout = await layOut(map, direction);
    for (const [id, node] of Object.entries(layout.nodes)) {
      // The worst pin sits just inside the corner; a critical one's halo reaches 16px from its center.
      const pin = { x: node.x + node.width - 4, y: node.y };
      for (const route of Object.values(layout.edges)) {
        const label = route.label!;
        const dx = Math.max(label.x - pin.x, 0, pin.x - (label.x + label.width));
        const dy = Math.max(label.y - pin.y, 0, pin.y - (label.y + label.height));
        assert.ok(Math.hypot(dx, dy) > 16, `the label of ${route.id} covers the pin corner of ${id}`);
      }
    }
  });

  test(`runs both flows of a two way pair along one track, each on its own right hand side, ${direction}`, async () => {
    const layout = await layOut(map, direction);
    // Each pair in the example: the API and the web app, and three processes reading and writing Postgres.
    for (const [there, back] of [["f4", "f18"], ["f6", "f17"], ["f8", "f7"], ["f11", "f13"]] as const) {
      const out = layout.edges[there]!;
      const home = layout.edges[back]!;
      assert.equal(out.points.length, home.points.length, `${there} and ${back} do not share a track`);
      assert.equal(out.lane, LANE_GAP / 2);
      assert.equal(home.lane, LANE_GAP / 2);
      // Where one flow starts, its partner ends a lane gap away, to its left: each keeps to its right.
      const start = out.points[0]!;
      const next = out.points[1]!;
      const partner = home.points.at(-1)!;
      assert.ok(Math.abs(Math.hypot(partner.x - start.x, partner.y - start.y) - LANE_GAP) < 0.01, `${there} and ${back} are not one lane apart`);
      const right = { x: -(next.y - start.y), y: next.x - start.x };
      assert.ok((partner.x - start.x) * right.x + (partner.y - start.y) * right.y < 0, `${back} is not on the left of ${there}`);
    }
  });

  test(`places each boundary name inside its box, clear of flow labels and of lines where its band has room, ${direction}`, async () => {
    const layout = await layOut(map, direction);
    for (const boundary of map.boundaries) {
      const zone = layout.boundaries[boundary.id]!;
      const name = layout.boundaryLabels[boundary.id]!;
      assert.ok(inside(name, zone), `the name of ${boundary.id} leaves its box`);
      for (const route of Object.values(layout.edges)) {
        assert.ok(!overlaps(route.label!, name), `the label of ${route.id} covers the name of ${boundary.id}`);
      }
      // Where flows entering from above leave no gap as wide as the name, it may sit across a
      // line; the canvas draws a halo so that line breaks around the text instead.
      if (widestGap(layout, zone, name) < name.width) continue;
      for (const route of Object.values(layout.edges)) {
        for (const { start, end } of segments(route.points)) assert.ok(!crosses(start, end, name), `${route.id} crosses the name of ${boundary.id}`);
      }
    }
  });

  test(`keeps a boundary at least as wide as its name, ${direction}`, async () => {
    const long = { ...map, boundaries: map.boundaries.map((b) => (b.id === "browser" ? { ...b, label: "The user's own browser tab and extensions" } : b)) };
    const layout = await layOut(long, direction);
    const zone = layout.boundaries.browser!;
    const name = layout.boundaryLabels.browser!;
    assert.ok(name.x + name.width <= zone.x + zone.width, `a ${Math.round(name.width)}px name spills out of a ${Math.round(zone.width)}px boundary`);
  });

  test(`stays clean when a coding agent adds a cache both sides read and write, ${direction}`, async () => {
    const updated: SystemMap = {
      ...map,
      nodes: [...map.nodes, { id: "cache", label: "Session cache", kind: "store", tech: "Redis", boundary: "backend", ai: false, sensitive: true, evidence: "inferred: sessions" }],
      flows: [
        ...map.flows,
        { id: "f19", source: "api", target: "cache", label: "save session", data: "Session ids", evidence: null },
        { id: "f20", source: "cache", target: "api", label: "read session", data: "Session ids", evidence: null },
      ],
    };
    assert.deepEqual(layoutProblems(await layOut(updated, direction)), []);
  });
}

test("keeps flow labels off the lines of other tracks when laid out top to bottom", async () => {
  // Left to right, labels on level runs share the narrow gaps between layers with the upright
  // runs that cross them, so there the placement can only choose the least crossed spot.
  const layout = await layOut(map, "DOWN");
  const track = (id: string) => {
    const flow = map.flows.find((f) => f.id === id)!;
    return [flow.source, flow.target].sort().join(" ");
  };
  for (const route of Object.values(layout.edges)) {
    for (const other of Object.values(layout.edges)) {
      if (track(other.id) === track(route.id)) continue;
      for (const { start, end } of segments(other.points)) {
        assert.ok(!crosses(start, end, route.label!), `the label of ${route.id} sits on ${other.id}`);
      }
    }
  }
});

test("puts the entry points first and the outside services last, as the story of the data reads", async () => {
  const down = await layOut(map, "DOWN");
  const right = await layOut(map, "RIGHT");
  const firstRow = Math.min(...Object.values(down.nodes).map((box) => box.y));
  const lastRow = Math.max(...Object.values(down.nodes).map((box) => box.y));
  for (const id of ["user", "senders"]) assert.equal(down.nodes[id]!.y, firstRow, `${id} is not in the top row`);
  for (const id of ["openai", "websites", "logs"]) assert.equal(down.nodes[id]!.y, lastRow, `${id} is not in the bottom row`);
  // Two way pairs point downstream: the API writes to Postgres from above it, not from beside or below.
  assert.ok(down.nodes.api!.y < down.nodes.db!.y);
  assert.ok(right.nodes.api!.x < right.nodes.db!.x);
  const lastColumn = Math.max(...Object.values(right.nodes).map((box) => box.x));
  for (const id of ["openai", "websites", "logs"]) assert.equal(right.nodes[id]!.x, lastColumn, `${id} is not in the last column`);
});

test("lays the example out tall one way and wide the other, within a few screens", async () => {
  const down = await layOut(map, "DOWN");
  const right = await layOut(map, "RIGHT");
  assert.ok(down.height > down.width && down.height < 1300, `top to bottom is ${Math.round(down.width)} by ${Math.round(down.height)}`);
  assert.ok(right.width > right.height && right.width < 2000, `left to right is ${Math.round(right.width)} by ${Math.round(right.height)}`);
});

test("picks the direction that shows the map larger, top to bottom on a near tie", () => {
  const shaped = (direction: Direction, width: number, height: number): MapLayout => ({
    direction, width, height, nodes: {}, boundaries: {}, boundaryLabels: {}, edges: {},
  });
  const layouts = { DOWN: shaped("DOWN", 700, 1200), RIGHT: shaped("RIGHT", 1800, 500) };
  assert.equal(pickDirection(layouts, 1300, 470), "RIGHT");
  assert.equal(pickDirection(layouts, 900, 830), "DOWN");
  // Left to right showing 3% larger is too close to give up reading down the page; 10% is not.
  const square = shaped("DOWN", 1000, 1000);
  assert.equal(pickDirection({ DOWN: square, RIGHT: shaped("RIGHT", 1000 / 1.03, 1000 / 1.03) }, 1000, 1000), "DOWN");
  assert.equal(pickDirection({ DOWN: square, RIGHT: shaped("RIGHT", 1000 / 1.1, 1000 / 1.1) }, 1000, 1000), "RIGHT");
});

test("spreads a cramped layout out and lays it out again", async () => {
  const system: SystemMap = { ...map, boundaries: [], flows: [], nodes: map.nodes.slice(0, 3).map((n) => ({ ...n, boundary: null })) };
  const seen: number[] = [];
  // A stand in for ELK that sets nodes in a row, 30px closer than the spacing it is asked for.
  const engine = (shrink: number): LayoutEngine => ({
    layout: async (graph: ElkNode) => {
      const gap = Number(graph.layoutOptions?.["elk.spacing.nodeNode"]) - shrink;
      seen.push(gap);
      let x = 0;
      const children = (graph.children ?? []).map((child) => {
        const placed = { ...child, x, y: 0 };
        x += (child.width ?? 0) + gap;
        return placed;
      });
      return { ...graph, width: x, height: 100, children };
    },
  });
  const clean = await layOutMap(engine(30), system, "RIGHT");
  assert.deepEqual(seen, [30, 45]);
  assert.deepEqual(layoutProblems(clean), []);

  seen.length = 0;
  const cramped = await layOutMap(engine(90), system, "RIGHT");
  assert.equal(seen.length, 3, "gives up after three tries");
  // Every try leaves both neighbors under the clearance, so the first, least spread one is kept.
  assert.ok(seen.every((gap) => gap < MIN_CLEARANCE));
  assert.equal(layoutProblems(cramped).length, 2);
  const [first, second] = [cramped.nodes.user!, cramped.nodes.senders!];
  assert.equal(second.x - (first.x + first.width), seen[0]);
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

test("hands ELK one edge per pair of nodes, however many flows run between them", () => {
  const graph = toElkGraph(map);
  const pairs = new Set(map.flows.map((flow) => [flow.source, flow.target].sort().join(" ")));
  assert.equal(graph.edges?.length, pairs.size);
  assert.ok(pairs.size < map.flows.length);
});

test("sizes nodes by kind on a 10px grid, growing in 20px steps to fit the text", () => {
  assert.deepEqual(nodeSize({ label: "DB", tech: null, kind: "process" }), { width: 180, height: 70 });
  assert.deepEqual(nodeSize({ label: "DB", tech: null, kind: "store" }), { width: 160, height: 80 });
  assert.deepEqual(nodeSize({ label: "User", tech: null, kind: "external" }), { width: 160, height: 60 });
  const tech = nodeSize({ label: "Gmail API", tech: "Google OAuth and Gmail", kind: "external" });
  assert.equal(tech.width, 220);
  for (const node of map.nodes) {
    const { width, height } = nodeSize(node);
    assert.equal(width % 20, 0, `${node.id} is ${width} wide`);
    assert.ok([60, 70, 80].includes(height), `${node.id} is ${height} tall`);
  }
});

test("wraps a long name onto a second line and cuts what still does not fit", () => {
  const long = { label: "A very long component name here", tech: "Something", kind: "external" as const };
  // An outside party keeps room for its person glyph, so it takes 18 characters a line.
  assert.deepEqual(nodeText(long).label, ["A very long", "component name…"]);
  assert.deepEqual(nodeSize(long), { width: 200, height: 60 + LINE_HEIGHT });
  assert.deepEqual(nodeText({ ...long, label: "Payment webhook receiver" }).label, ["Payment webhook", "receiver"]);
  const endless = nodeText({ label: "Customer relationship management platform integration layer", tech: null, kind: "process" });
  assert.equal(endless.label.length, 2);
  assert.ok(endless.label[1]!.endsWith("…"));
  const tech = nodeText({ label: "API", tech: "A framework name that is far too long to fit", kind: "process" }).tech!;
  assert.ok(tech.length <= 26 && tech.endsWith("…"), `tech line is ${tech}`);
  assert.equal(clip("abcdef", 4), "abc…");
});

test("keys layout on structure, not on flags", () => {
  const flagged = { ...map, nodes: map.nodes.map((n) => ({ ...n, sensitive: !n.sensitive, evidence: "x" })) };
  assert.equal(layoutKey(flagged), layoutKey(map));
  const renamed = { ...map, nodes: map.nodes.map((n, i) => (i === 0 ? { ...n, label: "Someone" } : n)) };
  assert.notEqual(layoutKey(renamed), layoutKey(map));
  const zone = { ...map, boundaries: map.boundaries.map((b, i) => (i === 0 ? { ...b, label: "Their laptop" } : b)) };
  assert.notEqual(layoutKey(zone), layoutKey(map));
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
