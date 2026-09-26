import type { Flow, MapNode, SystemMap } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Hand edits to a draft map during review, each returning a new map and never
// touching the old one. Deleting a node also deletes the flows that touch it,
// since a flow with a missing end cannot be drawn or analyzed.

/** Fields of a node a reviewer may change. */
export type NodePatch = Partial<Pick<MapNode, "label" | "kind" | "tech" | "ai" | "sensitive" | "boundary">>;
/** Fields of a flow a reviewer may change. */
export type FlowPatch = Partial<Pick<Flow, "label" | "data">>;

/** Return `map` with node `id` changed by `patch`. */
export function updateNode(map: SystemMap, id: string, patch: NodePatch): SystemMap {
  return { ...map, nodes: map.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)) };
}

/** Return `map` with flow `id` changed by `patch`. */
export function updateFlow(map: SystemMap, id: string, patch: FlowPatch): SystemMap {
  return { ...map, flows: map.flows.map((flow) => (flow.id === id ? { ...flow, ...patch } : flow)) };
}

/** Return `map` without node or flow `id`; a node takes its flows with it. */
export function removeElement(map: SystemMap, id: string): SystemMap {
  if (map.nodes.some((node) => node.id === id)) {
    return {
      ...map,
      nodes: map.nodes.filter((node) => node.id !== id),
      flows: map.flows.filter((flow) => flow.source !== id && flow.target !== id),
    };
  }
  return { ...map, flows: map.flows.filter((flow) => flow.id !== id) };
}

/** The ids of flows that touch node `id`. */
export function flowsTouching(map: SystemMap, id: string): string[] {
  return map.flows.filter((flow) => flow.source === id || flow.target === id).map((flow) => flow.id);
}

/** A problem that stops a map from saving, or `null` when it is fine. */
export function mapProblem(map: SystemMap): string | null {
  const blank = map.nodes.find((node) => node.label.trim() === "");
  if (blank) return `Give node "${blank.id}" a name before saving.`;
  const blankFlow = map.flows.find((flow) => flow.label.trim() === "");
  if (blankFlow) return `Give flow "${blankFlow.id}" a label before saving.`;
  if (map.nodes.length === 0) return "A map needs at least one node.";
  return null;
}
