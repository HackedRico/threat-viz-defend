import type { Flow, MapNode, SystemMap } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Compares the map before and after its latest update so review can mark what
// was added, changed or removed. Only fields a reviewer sees count as change;
// evidence wording alone does not.

/** An element that is gone from the new map, kept so review can still name it. */
export interface Removed {
  id: string;
  label: string;
  type: "node" | "flow";
}

/** What changed between two maps. */
export interface MapDiff {
  added: string[];
  changed: string[];
  removed: Removed[];
}

const NODE_FIELDS = ["label", "kind", "tech", "boundary", "ai", "sensitive"] as const satisfies readonly (keyof MapNode)[];
const FLOW_FIELDS = ["source", "target", "label", "data"] as const satisfies readonly (keyof Flow)[];

/** Diff `next` against `previous`; with no previous map nothing counts as changed. */
export function diffMaps(previous: SystemMap | null, next: SystemMap): MapDiff {
  if (previous === null) return { added: [], changed: [], removed: [] };
  const added: string[] = [];
  const changed: string[] = [];
  const removed: Removed[] = [];

  const oldNodes = new Map(previous.nodes.map((n) => [n.id, n]));
  const newNodes = new Map(next.nodes.map((n) => [n.id, n]));
  for (const node of next.nodes) {
    const before = oldNodes.get(node.id);
    if (before === undefined) added.push(node.id);
    else if (NODE_FIELDS.some((field) => before[field] !== node[field])) changed.push(node.id);
  }
  for (const node of previous.nodes) {
    if (!newNodes.has(node.id)) removed.push({ id: node.id, label: node.label, type: "node" });
  }

  const oldFlows = new Map(previous.flows.map((f) => [f.id, f]));
  const newFlows = new Map(next.flows.map((f) => [f.id, f]));
  for (const flow of next.flows) {
    const before = oldFlows.get(flow.id);
    if (before === undefined) added.push(flow.id);
    else if (FLOW_FIELDS.some((field) => before[field] !== flow[field])) changed.push(flow.id);
  }
  for (const flow of previous.flows) {
    if (!newFlows.has(flow.id)) removed.push({ id: flow.id, label: flow.label, type: "flow" });
  }
  return { added, changed, removed };
}

/** True when the diff has anything to show. */
export function hasChanges(diff: MapDiff): boolean {
  return diff.added.length + diff.changed.length + diff.removed.length > 0;
}
