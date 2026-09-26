import type { AttackPath, Flow, MapNode, SystemMap, Threat, ThreatAnalysis } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Looks up anything an id can name on a board, a node, flow, threat or attack
// path, and says it in words. `labelOf` matches the server's wording, so the
// voice coach and the quiz name elements the same way. `expandHighlight` turns
// a mixed list of ids into the map elements to light up.

/** What an id names on a board. */
export type Element =
  | { type: "node"; node: MapNode }
  | { type: "flow"; flow: Flow }
  | { type: "threat"; threat: Threat }
  | { type: "path"; path: AttackPath };

/** Find the node, flow, threat or path an id names, or `null`. */
export function findElement(id: string, map: SystemMap | null, analysis: ThreatAnalysis | null): Element | null {
  const node = map?.nodes.find((n) => n.id === id);
  if (node) return { type: "node", node };
  const flow = map?.flows.find((f) => f.id === id);
  if (flow) return { type: "flow", flow };
  const threat = analysis?.threats.find((t) => t.id === id);
  if (threat) return { type: "threat", threat };
  const path = analysis?.paths.find((p) => p.id === id);
  if (path) return { type: "path", path };
  return null;
}

/** Name a flow by its ends and label, as in `Browser to API: sign in`. */
export function flowLabel(map: SystemMap, flow: Flow): string {
  const name = (id: string) => map.nodes.find((n) => n.id === id)?.label ?? id;
  return `${name(flow.source)} to ${name(flow.target)}: ${flow.label}`;
}

/** Human label for any id on the board, falling back to the id itself. */
export function labelOf(id: string, map: SystemMap | null, analysis: ThreatAnalysis | null): string {
  const element = findElement(id, map, analysis);
  if (element === null) return id;
  switch (element.type) {
    case "node":
      return element.node.label;
    case "flow":
      return map ? flowLabel(map, element.flow) : element.flow.label;
    case "threat":
      return `${element.threat.id} ${element.threat.title}`;
    case "path":
      return `${element.path.id} ${element.path.title}`;
  }
}

/** The flow ids that carry an attack path from each step to the next. */
export function pathFlows(path: Pick<AttackPath, "steps">, map: SystemMap): string[] {
  const flows: string[] = [];
  for (let i = 0; i + 1 < path.steps.length; i += 1) {
    const from = path.steps[i];
    const to = path.steps[i + 1];
    const hop = map.flows.find((f) => f.source === from && f.target === to);
    if (hop) flows.push(hop.id);
  }
  return flows;
}

/** Map element ids to light up for a mixed list of node, flow, threat and path ids. */
export function expandHighlight(ids: readonly string[], map: SystemMap | null, analysis: ThreatAnalysis | null): string[] {
  const lit = new Set<string>();
  for (const id of ids) {
    const element = findElement(id, map, analysis);
    if (element === null) continue;
    if (element.type === "node" || element.type === "flow") lit.add(id);
    // A threat lights its pin and the element it sits on.
    if (element.type === "threat") {
      lit.add(id);
      lit.add(element.threat.element);
    }
    if (element.type === "path" && map) {
      element.path.steps.forEach((step) => lit.add(step));
      pathFlows(element.path, map).forEach((flow) => lit.add(flow));
      element.path.threats.forEach((threat) => lit.add(threat));
    }
  }
  return [...lit];
}

/** Split a spoken or typed id list such as `db, f3 and T1` into ids. */
export function splitIds(text: string): string[] {
  return text
    .split(/[\s,;]+|\band\b/i)
    .map((part) => part.trim())
    .filter((part) => part !== "" && part.toLowerCase() !== "and");
}
