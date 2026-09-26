import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

import type { Boundary, Flow, MapNode, SystemMap } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Turns a `SystemMap` into absolute boxes and routes the canvas can draw.
// `layOutMap` builds an ELK graph with `toElkGraph`, runs any `LayoutEngine`,
// gives each flow on a shared track its own lane, places flow and boundary
// labels clear of nodes and lines, and spreads the map out again while
// `layoutProblems` finds it cramped. `pickDirection` chooses the fit for a view.

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
  /** Distance from the middle of a track shared with flows between the same two nodes, toward the route's right hand side; 0 when alone. */
  lane: number;
}

/** Which way the layers run: `DOWN` puts the entry points on top, `RIGHT` on the left. */
export type Direction = "DOWN" | "RIGHT";

/** Both layout directions, top to bottom first. */
export const DIRECTIONS: readonly Direction[] = ["DOWN", "RIGHT"];

/** Everything the canvas needs to draw a map, in absolute coordinates. */
export interface MapLayout {
  direction: Direction;
  width: number;
  height: number;
  nodes: Record<string, Box>;
  boundaries: Record<string, Box>;
  /** Where each boundary's name block sits: inside its top edge, clear of flows where there is room. */
  boundaryLabels: Record<string, Box>;
  edges: Record<string, EdgeRoute>;
}

/** One map laid out in each direction, so a view can show whichever fits it. */
export type MapLayouts = Record<Direction, MapLayout>;

/** The part of ELK a layout needs; `useMapLayout.ts` passes the real engine so ELK stays out of the first bundle. */
export interface LayoutEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
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
const LABEL_LINES = 2;
const SIZE_STEP = 20;
const NODE_MAX_WIDTH = 220;

// One size per kind on a 10px grid, so a row of nodes lines up and reads as a set of like
// shapes; a node only grows, in 20px steps, when its name or tech needs the room.
const NODE_BASE: Record<MapNode["kind"], { width: number; height: number }> = {
  external: { width: 160, height: 60 },
  process: { width: 180, height: 70 },
  // A store's cylinder spends its top on the lid ellipse, so it needs extra height for the same text.
  store: { width: 160, height: 80 },
};

/** Height added to a node for each extra line its wrapped name takes. */
export const LINE_HEIGHT = 22;

/** Longest flow label drawn before it is cut with an ellipsis. */
export const FLOW_LABEL_MAX = 28;

/** Nearest two nodes may sit before a layout counts as cramped. */
export const MIN_CLEARANCE = 40;

// ELK's defaults suit dense engineering graphs; a map a person reviews needs about three
// times the room. The gaps between layers are where `placeLabels` finds space for labels.
const SPACING = {
  "elk.spacing.nodeNode": 60,
  "elk.spacing.edgeNode": 20,
  "elk.spacing.edgeEdge": 16,
  "elk.spacing.componentComponent": 60,
  "elk.layered.spacing.nodeNodeBetweenLayers": 100,
  "elk.layered.spacing.edgeNodeBetweenLayers": 24,
  "elk.layered.spacing.edgeEdgeBetweenLayers": 16,
} as const;

// Room at the top for the boundary's handwritten name and the "trust boundary" line under it.
const BOUNDARY_PADDING = "[top=46,left=28,bottom=28,right=28]";

// Each retry spreads every gap a quarter wider, which gives crowded nodes and labels more room;
// the least cramped attempt is kept if none comes out clean.
const SPREAD = [1, 1.25, 1.5625];

/** Distance between the lanes of flows that share a track. */
export const LANE_GAP = 10;

// =============================================================================
// Node text and size
// =============================================================================

/** The lines a node is drawn with: its name wrapped onto at most two lines, and its tech cut to fit. */
export function nodeText(node: Pick<MapNode, "label" | "tech" | "kind">): { label: string[]; tech: string | null } {
  const room = NODE_MAX_WIDTH - NODE_PAD_X - (node.kind === "external" ? MARKER_ROOM : 0);
  return {
    label: wrap(node.label, Math.floor(room / LABEL_CHAR), LABEL_LINES),
    tech: node.tech ? clip(node.tech, Math.floor(room / TECH_CHAR)) : null,
  };
}

/** The size a node is drawn at: its kind's size, widened in 20px steps to fit its text, and a line taller when its name wraps. */
export function nodeSize(node: Pick<MapNode, "label" | "tech" | "kind">): { width: number; height: number } {
  const text = nodeText(node);
  const base = NODE_BASE[node.kind];
  const widest = Math.max(...text.label.map((line) => line.length * LABEL_CHAR), (text.tech?.length ?? 0) * TECH_CHAR);
  const needed = widest + NODE_PAD_X + (node.kind === "external" ? MARKER_ROOM : 0);
  const width = clamp(Math.ceil(needed / SIZE_STEP) * SIZE_STEP, base.width, NODE_MAX_WIDTH);
  return { width, height: base.height + (text.label.length - 1) * LINE_HEIGHT };
}

/** The size of a flow's label chip. */
export function flowLabelSize(flow: Pick<Flow, "label">): { width: number; height: number } {
  return { width: Math.ceil(clip(flow.label, FLOW_LABEL_MAX).length * FLOW_CHAR + 14), height: 22 };
}

/** Cut `text` to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Break `text` into lines of at most `perLine` characters at spaces; the last kept line takes the rest and is cut at a word. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    const joined = line === "" ? word : `${line} ${word}`;
    if (joined.length <= perLine || line === "") {
      line = joined;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  const kept = lines.slice(0, maxLines);
  if (lines.length > maxLines) kept[maxLines - 1] = lines.slice(maxLines - 1).join(" ");
  return kept.map((row) => clipAtWord(row, perLine));
}

// Cut before the last whole word that fits, so a name never ends mid-word, unless that would
// throw away more than half the line; one long word is cut where it has to be.
function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const space = text.slice(0, max - 1).lastIndexOf(" ");
  return space > max / 2 ? `${text.slice(0, space)}…` : clip(text, max);
}

// =============================================================================
// Tracks: every flow between the same two nodes shares one route
// =============================================================================

/** The flows between one pair of nodes, drawn as parallel lanes of one route that runs from `lead.source` to `lead.target`. */
interface Track {
  lead: Flow;
  flows: Flow[];
}

/** The flows that can be drawn, grouped into tracks, each led by a flow pointing away from where data enters the map. */
function tracksOf(map: SystemMap): Track[] {
  const nodeIds = new Set(map.nodes.map((node) => node.id));
  const seen = new Set<string>();
  const byPair = new Map<string, Flow[]>();
  for (const flow of map.flows) {
    // A flow to a missing node, or a repeated id, cannot be drawn; the inspector still lists it.
    if (seen.has(flow.id) || !nodeIds.has(flow.source) || !nodeIds.has(flow.target)) continue;
    seen.add(flow.id);
    const key = [flow.source, flow.target].sort().join(" ");
    byPair.set(key, [...(byPair.get(key) ?? []), flow]);
  }
  const groups = [...byPair.values()];
  const depth = entryDepths(map, groups);
  const far = (id: string) => depth.get(id) ?? Number.POSITIVE_INFINITY;
  return groups.map((flows) => ({ lead: flows.find((flow) => far(flow.source) < far(flow.target)) ?? flows[0]!, flows }));
}

// Two opposite flows form a cycle, and ELK draws the one it reverses as a loop around the whole
// map. A track hands ELK one edge instead, pointed downstream: away from the outside parties that
// only send data in, counting hops through one way flows forward and two way tracks either way.
function entryDepths(map: SystemMap, groups: readonly Flow[][]): Map<string, number> {
  const twoWay = (flows: readonly Flow[]) => new Set(flows.map((flow) => flow.source)).size > 1;
  const fed = new Set(
    groups.filter((flows) => !twoWay(flows)).flatMap((flows) => flows.filter((f) => f.source !== f.target).map((f) => f.target)),
  );
  const open = map.nodes.filter((node) => !fed.has(node.id));
  // Failing an outside party that only sends, anything nothing feeds that is not a store, since
  // data rests in a store rather than entering there; a map of nothing but cycles starts at its first node.
  const candidates = [open.filter((node) => node.kind === "external"), open.filter((node) => node.kind !== "store"), open, map.nodes.slice(0, 1)];
  const start = (candidates.find((nodes) => nodes.length > 0) ?? []).map((node) => node.id);

  const next = new Map<string, string[]>();
  const link = (from: string, to: string) => next.set(from, [...(next.get(from) ?? []), to]);
  for (const flows of groups) {
    const { source, target } = flows[0]!;
    link(source, target);
    if (twoWay(flows)) link(target, source);
  }
  const depth = new Map(start.map((id) => [id, 0]));
  const queue = [...start];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    for (const to of next.get(id) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, depth.get(id)! + 1);
      queue.push(to);
    }
  }
  return depth;
}

// =============================================================================
// ELK graph in, absolute layout out
// =============================================================================

/** Build the ELK graph for a map: boundaries become compound nodes and each track one root edge; `spread` scales every gap. */
export function toElkGraph(map: SystemMap, direction: Direction = "DOWN", spread = 1): ElkNode {
  const boundaryIds = new Set(map.boundaries.map((boundary) => boundary.id));
  const gaps = Object.fromEntries(Object.entries(SPACING).map(([key, value]) => [key, String(Math.round(value * spread))]));
  const leaf = (node: MapNode): ElkNode => ({ id: node.id, ...nodeSize(node) });

  const boundaries: ElkNode[] = map.boundaries
    .map((boundary) => {
      const width = Math.ceil(boundaryLabelSize(boundary).width + BOUNDARY_INSET * 2);
      return {
        id: BOUNDARY_PREFIX + boundary.id,
        layoutOptions: {
          ...gaps,
          "elk.padding": BOUNDARY_PADDING,
          // Never narrower than its own name, which would otherwise spill over the dashed edge. With
          // hierarchy handling, ELK applies a compound node's minimum before it turns a top to bottom
          // layout upright, so that direction takes the vector with its axes swapped.
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
          "elk.nodeSize.minimum": direction === "DOWN" ? `(0, ${width})` : `(${width}, 0)`,
        },
        children: map.nodes.filter((node) => node.boundary === boundary.id).map(leaf),
      };
    })
    // An empty compound node draws as a lonely dashed box; skip it.
    .filter((boundary) => boundary.children.length > 0);

  // A node whose boundary id is not on the map sits outside every boundary rather than vanishing.
  const loose = map.nodes.filter((node) => node.boundary === null || !boundaryIds.has(node.boundary)).map(leaf);

  // Labels stay out of ELK: layered layout turns each labeled edge into two, which doubles
  // the layer count and makes the example board four times wider than tall.
  const edges: ElkExtendedEdge[] = tracksOf(map).map(({ lead, flows }) => ({
    id: lead.id,
    sources: [lead.source],
    targets: [lead.target],
    // ELK keeps other lines clear of the whole track, so its lanes never crowd a neighbor.
    ...(flows.length > 1 ? { layoutOptions: { "elk.edge.thickness": String((flows.length - 1) * LANE_GAP + 2) } } : {}),
  }));

  return {
    id: ROOT,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=32,left=32,bottom=32,right=32]",
      ...gaps,
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      // Follow the map's own order when choices tie, so small edits do not reshuffle the board.
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "false",
      // A pinned seed draws the same map the same way every time, so two versions differ only where the map did.
      "elk.randomSeed": "1",
    },
    children: [...boundaries, ...loose],
    edges,
  };
}

/** Lay out `map` in `direction` with `engine`, spreading it out and trying again while `layoutProblems` finds it cramped. */
export async function layOutMap(engine: LayoutEngine, map: SystemMap, direction: Direction): Promise<MapLayout> {
  let best: { layout: MapLayout; problems: number } | null = null;
  for (const spread of SPREAD) {
    const flat = readLayout(await engine.layout(toElkGraph(map, direction, spread)), direction);
    const layout = placeBoundaryLabels(placeLabels(splitTracks(flat, map), map.flows), map.boundaries);
    const problems = layoutProblems(layout).length;
    if (problems === 0) return layout;
    if (best === null || problems < best.problems) best = { layout, problems };
  }
  // `SPREAD` is never empty, so the loop always sets `best`.
  return best!.layout;
}

/** Flatten ELK's laid out graph into absolute boxes for nodes and boundaries and one route per track, labels unset. */
function readLayout(result: ElkNode, direction: Direction): MapLayout {
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
    edges[edge.id] = { id: edge.id, points, label: null, lane: 0 };
  }

  return { direction, width: result.width ?? 0, height: result.height ?? 0, nodes, boundaries, boundaryLabels: {}, edges };
}

// Every flow gets a route of its own: a lane beside the middle of its track. Flows against the
// lead run back along the same track, and each direction keeps to its own right hand side, as
// traffic does, so the two directions of an exchange always sit the same way round.
function splitTracks(layout: MapLayout, map: SystemMap): MapLayout {
  const edges: Record<string, EdgeRoute> = {};
  for (const { lead, flows } of tracksOf(map)) {
    const route = layout.edges[lead.id];
    if (route === undefined) continue;
    const twoWay = flows.some((flow) => flow.source !== lead.source);
    const along = flows.filter((flow) => flow.source === lead.source);
    const against = flows.filter((flow) => flow.source !== lead.source);
    const lanes = new Map<string, number>();
    if (twoWay) {
      along.forEach((flow, i) => lanes.set(flow.id, (i + 0.5) * LANE_GAP));
      against.forEach((flow, i) => lanes.set(flow.id, -(i + 0.5) * LANE_GAP));
    } else {
      along.forEach((flow, i) => lanes.set(flow.id, (i - (along.length - 1) / 2) * LANE_GAP));
    }
    for (const flow of flows) {
      const lane = lanes.get(flow.id) ?? 0;
      const points = offsetLine(route.points, lane);
      const reversed = flow.source !== lead.source;
      // Seen from a flow running back along the track, the lead's right hand side is its left.
      edges[flow.id] = { id: flow.id, points: reversed ? points.reverse() : points, label: null, lane: reversed ? -lane : lane };
    }
  }
  return { ...layout, edges };
}

// The polyline moved `by` toward the right hand side of travel, which on a y-down canvas is the
// normal (-dy, dx); corners take the mitered point so each run stays parallel to the original.
function offsetLine(points: readonly Point[], by: number): Point[] {
  const kept = points.filter((p, i) => i === 0 || dist(points[i - 1]!, p) > 0.01);
  if (by === 0 || kept.length < 2) return [...kept];
  const normals = kept.slice(1).map((end, i) => {
    const start = kept[i]!;
    const length = dist(start, end);
    return { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
  });
  return kept.map((p, i) => {
    const before = normals[i - 1] ?? normals[i]!;
    const after = normals[i] ?? normals[i - 1]!;
    const mx = before.x + after.x;
    const my = before.y + after.y;
    const length = Math.hypot(mx, my);
    // A route that doubles back on itself has no miter; shifting along one side keeps it drawable.
    if (length < 1e-6) return { x: p.x + after.x * by, y: p.y + after.y * by };
    const cos = (mx * after.x + my * after.y) / length;
    const reach = by / Math.max(cos, 0.3);
    return { x: p.x + (mx / length) * reach, y: p.y + (my / length) * reach };
  });
}

// -----------------------------------------------------------------
// Flow label placement
// -----------------------------------------------------------------

const ALONG = [0.5, 0.35, 0.65, 0.2, 0.8];
// How far past the edge of its own line a label may move, in steps, before it tries elsewhere.
const BESIDE = [4, 16, 30];
const NODE_MARGIN = 4;
const LABEL_MARGIN = 3;
// Threat pins land on a node's top right corner after layout, the second one a step to its
// left, so labels keep clear of that much of every corner whether or not a threat comes.
const PIN_CORNER = { left: 48, right: 14, up: 16, down: 17 };
// A label on someone else's line reads as naming it, which is worse than sitting a little
// further from its own; covering a node is worse still. A label astride a dashed boundary
// leaves the reader unsure which side its flow is on, a smaller but real cost.
const NODE_COST = 4;
const LINE_COST = 400;
const EDGE_COST = 100;

/** Return `layout` with a label box for every flow, set along its route where it covers no node, other line or earlier label. */
export function placeLabels(layout: MapLayout, flows: readonly Pick<Flow, "id" | "label">[]): MapLayout {
  const obstacles = Object.values(layout.nodes).flatMap((box) => [
    grow(box, NODE_MARGIN),
    {
      x: box.x + box.width - PIN_CORNER.left,
      y: box.y - PIN_CORNER.up,
      width: PIN_CORNER.left + PIN_CORNER.right,
      height: PIN_CORNER.up + PIN_CORNER.down,
    },
  ]);
  const placed: Box[] = [];
  const edges: Record<string, EdgeRoute> = { ...layout.edges };
  const lines = Object.values(layout.edges).flatMap((route) => segmentsOf(route.points).map((segment) => ({ id: route.id, ...segment })));
  const zoneEdges = Object.values(layout.boundaries).flatMap(sidesOf);
  // Short routes have the fewest free spots, so they choose first; long runs find room later.
  const ordered = [...flows].sort((a, b) => routeLength(edges[a.id]) - routeLength(edges[b.id]));
  for (const flow of ordered) {
    const route = edges[flow.id];
    if (route === undefined || route.points.length < 2) continue;
    const size = flowLabelSize(flow);
    const others = lines.filter((line) => line.id !== route.id);
    let best: { box: Box; cost: number } | null = null;
    for (const center of labelCandidates(route.points, size, route.lane)) {
      const box = { x: center.x - size.width / 2, y: center.y - size.height / 2, ...size };
      const cost =
        obstacles.reduce((sum, node) => sum + overlapArea(box, node) * NODE_COST, 0) +
        placed.reduce((sum, other) => sum + overlapArea(grow(box, LABEL_MARGIN), other), 0) +
        others.reduce((sum, line) => sum + (crossesBox(line, grow(box, 1)) ? LINE_COST : 0), 0) +
        zoneEdges.reduce((sum, side) => sum + (crossesBox(side, box) ? EDGE_COST : 0), 0);
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

// Label centers to try: long horizontal runs first, since text reads best along them. A lone
// flow tries its line first, where the chip breaks the line like a caption. A flow sharing a
// track keeps its label on its own outer side, and only then tries its line or the far side,
// past its partners' lanes, as the least bad choices in a tight spot.
function labelCandidates(points: readonly Point[], size: { width: number; height: number }, lane: number): Point[] {
  const side = Math.sign(lane);
  // The far side of a track starts beyond the partner lanes, which sit twice the lane offset away.
  const partners = Math.abs(lane) * 2;
  const segments = segmentsOf(points)
    .filter(({ start, end }) => dist(start, end) > 0)
    .map(({ start, end }) => {
      const length = dist(start, end);
      const horizontal = Math.abs(end.y - start.y) < 1;
      const normal = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
      // How far the label reaches across the line: half its height on a level run, half its width on an upright one.
      const reach = Math.abs(normal.x) * (size.width / 2) + Math.abs(normal.y) * (size.height / 2);
      return { start, end, normal, reach, rank: length * (horizontal ? 1.6 : 1) };
    })
    .sort((a, b) => b.rank - a.rank);
  const shifts = (reach: number): number[] => {
    const beside = BESIDE.map((gap) => reach + gap);
    if (side === 0) return [0, ...beside.flatMap((shift) => [-shift, shift])];
    return [...beside.map((shift) => shift * side), 0, ...beside.map((shift) => -(shift + partners) * side)];
  };
  const candidates: Point[] = [];
  const rounds = shifts(0).length;
  for (let round = 0; round < rounds; round += 1) {
    for (const segment of segments) {
      const across = shifts(segment.reach)[round]!;
      for (const t of ALONG) {
        candidates.push({
          x: segment.start.x + (segment.end.x - segment.start.x) * t + segment.normal.x * across,
          y: segment.start.y + (segment.end.y - segment.start.y) * t + segment.normal.y * across,
        });
      }
    }
  }
  return candidates;
}

// -----------------------------------------------------------------
// Boundary label placement
// -----------------------------------------------------------------

// Caveat at 21px bold for the name, and "TRUST BOUNDARY" in 9.5px mono capitals under it.
const BOUNDARY_CHAR = 9.4;
const BOUNDARY_KIND_WIDTH = 96;
const BOUNDARY_LABEL_HEIGHT = 34;
const BOUNDARY_INSET = 18;
const BOUNDARY_TOP = 10;
const BOUNDARY_STEP = 10;

/** The size of a boundary's name block: its name over the "trust boundary" line. */
function boundaryLabelSize(boundary: Pick<Boundary, "label">): { width: number; height: number } {
  return { width: Math.max(Math.ceil(boundary.label.length * BOUNDARY_CHAR), BOUNDARY_KIND_WIDTH), height: BOUNDARY_LABEL_HEIGHT };
}

// A boundary's name sits in the band its top padding keeps free of nodes. Flows entering from
// above cross that band, so the name slides right from the corner to the first spot no line
// or flow label touches, and keeps the least crossed spot when every one is taken.
function placeBoundaryLabels(layout: MapLayout, boundaries: readonly Boundary[]): MapLayout {
  const lines = Object.values(layout.edges).flatMap((route) => segmentsOf(route.points));
  const chips = Object.values(layout.edges).flatMap((route) => (route.label ? [route.label] : []));
  const boundaryLabels: Record<string, Box> = {};
  for (const boundary of boundaries) {
    const zone = layout.boundaries[boundary.id];
    if (zone === undefined) continue;
    const size = boundaryLabelSize(boundary);
    const last = Math.max(zone.x + BOUNDARY_INSET, zone.x + zone.width - BOUNDARY_INSET - size.width);
    let best: { box: Box; cost: number } | null = null;
    for (let x = zone.x + BOUNDARY_INSET; x <= last; x += BOUNDARY_STEP) {
      const box = { x, y: zone.y + BOUNDARY_TOP, ...size };
      const cost =
        lines.filter((line) => crossesBox(line, grow(box, 4))).length +
        chips.reduce((sum, chip) => sum + (overlapArea(grow(box, 4), chip) > 0 ? 1 : 0), 0);
      if (best === null || cost < best.cost) best = { box, cost };
      if (cost === 0) break;
    }
    if (best !== null) boundaryLabels[boundary.id] = best.box;
  }
  return { ...layout, boundaryLabels };
}

// =============================================================================
// Judging a layout
// =============================================================================

/** What makes `layout` read as cramped: nodes nearer than `MIN_CLEARANCE`, or flow labels covering a node or each other; empty when clean. */
export function layoutProblems(layout: MapLayout): string[] {
  const problems: string[] = [];
  const nodes = Object.entries(layout.nodes);
  nodes.forEach(([id, box], i) => {
    for (const [otherId, other] of nodes.slice(i + 1)) {
      const gap = boxGap(box, other);
      if (gap < MIN_CLEARANCE) problems.push(`${id} and ${otherId} are ${Math.round(gap)}px apart`);
    }
  });
  const labels = Object.values(layout.edges).flatMap((route) => (route.label ? [{ id: route.id, box: route.label }] : []));
  labels.forEach(({ id, box }, i) => {
    for (const [nodeId, node] of nodes) if (overlapArea(box, node) > 0) problems.push(`the label of ${id} covers ${nodeId}`);
    for (const other of labels.slice(i + 1)) if (overlapArea(box, other.box) > 0) problems.push(`the labels of ${id} and ${other.id} collide`);
  });
  return problems;
}

/** The direction whose layout shows larger fitted into a `width` by `height` view; top to bottom wins a near tie, as it reads like a page. */
export function pickDirection(layouts: MapLayouts, width: number, height: number): Direction {
  const scale = (layout: MapLayout) => Math.min(width / Math.max(layout.width, 1), height / Math.max(layout.height, 1));
  return scale(layouts.RIGHT) > scale(layouts.DOWN) * 1.05 ? "RIGHT" : "DOWN";
}

/** A stable key for the parts of a map that change its layout, so edits to flags reuse the old layout. */
export function layoutKey(map: SystemMap): string {
  return JSON.stringify([
    map.boundaries.map((b) => [b.id, b.label]),
    map.nodes.map((n) => [n.id, n.label, n.tech, n.kind, n.boundary]),
    map.flows.map((f) => [f.id, f.source, f.target, f.label]),
  ]);
}

// =============================================================================
// Geometry
// =============================================================================

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

function segmentsOf(points: readonly Point[]): Array<{ start: Point; end: Point }> {
  return points.slice(1).map((end, i) => ({ start: points[i]!, end }));
}

function sidesOf(box: Box): Array<{ start: Point; end: Point }> {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  return segmentsOf([
    { x: box.x, y: box.y },
    { x: right, y: box.y },
    { x: right, y: bottom },
    { x: box.x, y: bottom },
    { x: box.x, y: box.y },
  ]);
}

// True when the segment passes through the box. Routes are orthogonal, so checking the
// segment's own bounding box against the box is exact for them.
function crossesBox({ start, end }: { start: Point; end: Point }, box: Box): boolean {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  return left <= box.x + box.width && right >= box.x && top <= box.y + box.height && bottom >= box.y;
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

function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.hypot(dx, dy);
}

function grow(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, width: box.width + by * 2, height: box.height + by * 2 };
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
