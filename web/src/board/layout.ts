import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

import type { Flow, MapNode, SystemMap } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Turns a `SystemMap` into an ELK graph and ELK's answer back into absolute
// boxes and routes the canvas can draw. `toElkGraph` sizes every node from its
// text, nests nodes inside their trust boundary, and asks for a layered left to
// right layout; `readLayout` flattens ELK's nested, relative coordinates and
// `placeLabels` then sets each flow label along its route, clear of nodes.

/** A point on the canvas. */
export interface Point {
  x: number;
  y: number;
}

/** An axis aligned box in canvas coordinates. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where one flow runs and where its label sits. */
export interface EdgeRoute {
  id: string;
  points: Point[];
  label: Box | null;
}

/** Everything the canvas needs to draw a map, in absolute coordinates. */
export interface MapLayout {
  width: number;
  height: number;
  nodes: Record<string, Box>;
  boundaries: Record<string, Box>;
  edges: Record<string, EdgeRoute>;
}

const ROOT = "root";
const BOUNDARY_PREFIX = "boundary:";

// Text widths are estimates for the canvas fonts: Caveat at 20px for node labels, IBM Plex
// Mono at 11.5px for tech, Caveat at 17px for flow labels. Measuring in the DOM would tie the
// layout to rendering and make it untestable; a few pixels of slack is invisible on a board.
const LABEL_CHAR = 8.8;
const TECH_CHAR = 7;
const FLOW_CHAR = 7.6;
const NODE_PAD_X = 36;
const MARKER_ROOM = 22;
const NODE_MIN_WIDTH = 124;
const NODE_MAX_WIDTH = 230;
const FLOW_LABEL_MAX = 28;

// ELK reads spacing from each nested graph, so boundaries repeat the root's spacing.
const SPACING: Record<string, string> = {
  "elk.spacing.nodeNode": "44",
  "elk.spacing.edgeNode": "18",
  "elk.spacing.edgeEdge": "12",
  // Wide gaps between layers are where `placeLabels` finds room for flow labels.
  "elk.layered.spacing.nodeNodeBetweenLayers": "90",
  "elk.layered.spacing.edgeNodeBetweenLayers": "22",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
};

/** Longest node tech text drawn before it is cut with an ellipsis. */
export const TECH_MAX = 30;

/** The size a node is drawn at, from its label, tech line and kind. */
export function nodeSize(node: Pick<MapNode, "label" | "tech" | "kind">): { width: number; height: number } {
  const tech = node.tech ? clip(node.tech, TECH_MAX) : "";
  const marker = node.kind === "external" ? MARKER_ROOM : 0;
  const text = Math.max(node.label.length * LABEL_CHAR, tech.length * TECH_CHAR);
  const width = clamp(Math.ceil(text + NODE_PAD_X + marker), NODE_MIN_WIDTH, NODE_MAX_WIDTH);
  const body = tech ? 60 : 46;
  // A store's cylinder spends its top on the lid ellipse, so it needs extra height for the same text.
  return { width, height: node.kind === "store" ? body + 12 : body };
}

/** The size of a flow's label chip. */
export function flowLabelSize(flow: Pick<Flow, "label">): { width: number; height: number } {
  return { width: Math.ceil(clip(flow.label, FLOW_LABEL_MAX).length * FLOW_CHAR + 14), height: 22 };
}

/** Cut `text` to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Build the ELK graph for a map: boundaries become compound nodes, flows become root edges. */
export function toElkGraph(map: SystemMap): ElkNode {
  const nodeIds = new Set(map.nodes.map((node) => node.id));
  const boundaryIds = new Set(map.boundaries.map((boundary) => boundary.id));
  const leaf = (node: MapNode): ElkNode => ({ id: node.id, ...nodeSize(node) });

  const boundaries: ElkNode[] = map.boundaries
    .map((boundary) => ({
      id: BOUNDARY_PREFIX + boundary.id,
      layoutOptions: {
        ...SPACING,
        // Room at the top for the boundary's handwritten label.
        "elk.padding": "[top=46,left=26,bottom=26,right=26]",
      },
      children: map.nodes.filter((node) => node.boundary === boundary.id).map(leaf),
    }))
    // An empty compound node draws as a lonely dashed box; skip it.
    .filter((boundary) => boundary.children.length > 0);

  // A node whose boundary id is not on the map sits outside every boundary rather than vanishing.
  const loose = map.nodes.filter((node) => node.boundary === null || !boundaryIds.has(node.boundary)).map(leaf);

  const seen = new Set<string>();
  const edges: ElkExtendedEdge[] = [];
  for (const flow of map.flows) {
    // A flow to a missing node, or a repeated id, cannot be drawn; the inspector still lists it.
    if (seen.has(flow.id) || !nodeIds.has(flow.source) || !nodeIds.has(flow.target)) continue;
    seen.add(flow.id);
    // Labels stay out of ELK: layered layout turns each labeled edge into two, which doubles
    // the layer count and makes the example board four times wider than tall.
    edges.push({ id: flow.id, sources: [flow.source], targets: [flow.target] });
  }

  return {
    id: ROOT,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=32,left=32,bottom=32,right=32]",
      ...SPACING,
      "elk.spacing.componentComponent": "48",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      // Follow the map's own order when choices tie, so small edits do not reshuffle the board.
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "false",
    },
    children: [...boundaries, ...loose],
    edges,
  };
}

/** Flatten ELK's laid out graph into absolute boxes for nodes, boundaries and flow routes, labels unset. */
export function readLayout(result: ElkNode): MapLayout {
  const nodes: Record<string, Box> = {};
  const boundaries: Record<string, Box> = {};
  const origins: Record<string, Point> = { [ROOT]: { x: 0, y: 0 } };
  const edges: Record<string, EdgeRoute> = {};
  const pendingEdges: Array<{ edge: ElkExtendedEdge; owner: string }> = [];

  const walk = (node: ElkNode, offset: Point, owner: string): void => {
    for (const edge of node.edges ?? []) pendingEdges.push({ edge, owner });
    for (const child of node.children ?? []) {
      const box = { x: offset.x + (child.x ?? 0), y: offset.y + (child.y ?? 0), width: child.width ?? 0, height: child.height ?? 0 };
      origins[child.id] = { x: box.x, y: box.y };
      if (child.id.startsWith(BOUNDARY_PREFIX)) {
        boundaries[child.id.slice(BOUNDARY_PREFIX.length)] = box;
        walk(child, box, child.id);
      } else {
        nodes[child.id] = box;
      }
    }
  };
  walk(result, { x: 0, y: 0 }, ROOT);

  for (const { edge, owner } of pendingEdges) {
    // ELK reports edge points relative to the edge's container; with hierarchy handling that
    // can differ from the node the edge was declared in, and `container` names it when it does.
    const origin = origins[edge.container ?? owner] ?? origins[owner] ?? { x: 0, y: 0 };
    const shift = (p: Point): Point => ({ x: origin.x + p.x, y: origin.y + p.y });
    const points = (edge.sections ?? []).flatMap((section, index) => [
      ...(index === 0 ? [shift(section.startPoint)] : []),
      ...(section.bendPoints ?? []).map(shift),
      shift(section.endPoint),
    ]);
    edges[edge.id] = { id: edge.id, points, label: null };
  }

  return { width: result.width ?? 0, height: result.height ?? 0, nodes, boundaries, edges };
}

// -----------------------------------------------------------------
// Flow label placement
// -----------------------------------------------------------------

const ALONG = [0.5, 0.3, 0.7, 0.15, 0.85];
const ACROSS = [0, -14, 14, -26, 26, -40, 40];
const NODE_MARGIN = 4;
const LABEL_MARGIN = 3;

/** Return `layout` with a label box for every flow, set along its route where it covers no node or earlier label. */
export function placeLabels(layout: MapLayout, flows: readonly Pick<Flow, "id" | "label">[]): MapLayout {
  const obstacles = Object.values(layout.nodes).map((box) => grow(box, NODE_MARGIN));
  const placed: Box[] = [];
  const edges: Record<string, EdgeRoute> = { ...layout.edges };
  // Short routes have the fewest free spots, so they choose first; long runs find room later.
  const ordered = [...flows].sort((a, b) => routeLength(edges[a.id]) - routeLength(edges[b.id]));
  for (const flow of ordered) {
    const route = edges[flow.id];
    if (route === undefined || route.points.length < 2) continue;
    const size = flowLabelSize(flow);
    let best: { box: Box; cost: number } | null = null;
    for (const center of labelCandidates(route.points)) {
      const box = { x: center.x - size.width / 2, y: center.y - size.height / 2, ...size };
      const cost =
        obstacles.reduce((sum, node) => sum + overlapArea(box, node) * 4, 0) +
        placed.reduce((sum, other) => sum + overlapArea(grow(box, LABEL_MARGIN), other), 0);
      if (best === null || cost < best.cost) best = { box, cost };
      if (cost === 0) break;
    }
    if (best !== null) {
      placed.push(best.box);
      edges[flow.id] = { ...route, label: best.box };
    }
  }
  return { ...layout, edges };
}

/** Label centers to try along a route: long horizontal runs first, since text reads best along them. */
function labelCandidates(points: readonly Point[]): Point[] {
  const segments = points.slice(1).map((end, i) => {
    const start = points[i]!;
    const horizontal = Math.abs(end.y - start.y) < 1;
    const length = dist(start, end);
    return { start, end, horizontal, rank: length * (horizontal ? 1.6 : 1) };
  });
  segments.sort((a, b) => b.rank - a.rank);
  const candidates: Point[] = [];
  for (const across of ACROSS) {
    for (const segment of segments) {
      for (const t of ALONG) {
        const x = segment.start.x + (segment.end.x - segment.start.x) * t;
        const y = segment.start.y + (segment.end.y - segment.start.y) * t;
        // Nudge across the line: up and down on horizontal runs, sideways on vertical ones.
        candidates.push(segment.horizontal ? { x, y: y + across } : { x: x + across * 2.5, y });
      }
    }
  }
  return candidates;
}

function routeLength(route: EdgeRoute | undefined): number {
  if (route === undefined) return 0;
  return route.points.slice(1).reduce((sum, p, i) => sum + dist(route.points[i]!, p), 0);
}

function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function grow(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, width: box.width + by * 2, height: box.height + by * 2 };
}

/** A stable key for the parts of a map that change its layout, so edits to flags reuse the old layout. */
export function layoutKey(map: SystemMap): string {
  return JSON.stringify([
    map.boundaries.map((b) => b.id),
    map.nodes.map((n) => [n.id, n.label, n.tech, n.kind, n.boundary]),
    map.flows.map((f) => [f.id, f.source, f.target, f.label]),
  ]);
}

/** The point halfway along a polyline, measured by length. */
export function midpoint(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let i = 0; i < lengths.length; i += 1) {
    const length = lengths[i]!;
    if (remaining <= length && length > 0) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const t = remaining / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= length;
  }
  return points.at(-1)!;
}

/** The polyline shortened by `by` at its end, so a line drawn over an arrow stops before the arrowhead. */
export function trimEnd(points: readonly Point[], by: number): Point[] {
  const kept = [...points];
  let remaining = by;
  while (kept.length >= 2 && remaining > 0) {
    const end = kept[kept.length - 1]!;
    const before = kept[kept.length - 2]!;
    const length = dist(before, end);
    if (length > remaining) {
      kept[kept.length - 1] = toward(end, before, remaining);
      return kept;
    }
    remaining -= length;
    kept.pop();
  }
  return kept;
}

/** An SVG path through `points` with corners rounded by up to `radius`. */
export function roundedPath(points: readonly Point[], radius = 10): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  let d = `M${fmt(first.x)},${fmt(first.y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const here = points[i]!;
    const next = points[i + 1];
    if (next === undefined) {
      d += ` L${fmt(here.x)},${fmt(here.y)}`;
      break;
    }
    const prev = points[i - 1]!;
    const r = Math.min(radius, dist(prev, here) / 2, dist(here, next) / 2);
    const inPoint = toward(here, prev, r);
    const outPoint = toward(here, next, r);
    d += ` L${fmt(inPoint.x)},${fmt(inPoint.y)} Q${fmt(here.x)},${fmt(here.y)} ${fmt(outPoint.x)},${fmt(outPoint.y)}`;
  }
  return d;
}

function toward(from: Point, to: Point, distance: number): Point {
  const length = dist(from, to);
  if (length === 0) return from;
  return { x: from.x + ((to.x - from.x) * distance) / length, y: from.y + ((to.y - from.y) * distance) / length };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
