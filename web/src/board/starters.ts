import type { ExposureOut, MapNode, SystemMap, ThreatAnalysis } from "../api/types.ts";
import { rankThreats } from "./severity.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The starter questions under the ask bar, built from the board so each one
// names a part of this system. A fixed list would ask about an AI part or a
// database that a board may not have.

/** Up to three questions a reader can ask about this board, naming its own parts. */
export function starterQuestions(
  map: SystemMap,
  analysis: ThreatAnalysis,
  exposure: readonly ExposureOut[],
): string[] {
  const starters = ["What should I fix first, and why?"];
  const entry = aiPart(map, exposure);
  const target = entry ?? worstNode(map, analysis);
  if (target) {
    starters.push(
      entry ? `What can untrusted input make ${target.label} do?` : `How could an attacker get into ${target.label}?`,
    );
  }
  const store = dataStore(map, target);
  if (store) starters.push(`What happens if ${store.label} leaks?`);
  return starters;
}

// The AI part with the most at stake: the lethal trifecta first, then one that reads untrusted input.
function aiPart(map: SystemMap, exposure: readonly ExposureOut[]): MapNode | null {
  const ranked = [...exposure].sort((a, b) => score(b) - score(a));
  const id = ranked[0]?.node ?? map.nodes.find((n) => n.ai && n.kind === "process")?.id;
  return map.nodes.find((n) => n.id === id) ?? null;
}

function score(x: ExposureOut): number {
  return (x.lethal ? 2 : 0) + (x.untrusted.length > 0 ? 1 : 0);
}

function worstNode(map: SystemMap, analysis: ThreatAnalysis): MapNode | null {
  for (const threat of rankThreats(analysis.threats)) {
    const node = map.nodes.find((n) => n.id === threat.element);
    if (node) return node;
  }
  return null;
}

// A store holding sensitive data says the most about a leak; any store will do otherwise.
function dataStore(map: SystemMap, skip: MapNode | null): MapNode | null {
  const stores = map.nodes.filter((n) => n.kind === "store" && n.id !== skip?.id);
  return stores.find((n) => n.sensitive) ?? stores[0] ?? null;
}
