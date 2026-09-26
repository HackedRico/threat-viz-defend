from app.domain.models import SystemMap, ThreatAnalysis
from app.domain.rules import STRIDE, ai_exposure, crosses_boundary, flow_label, label_of, node_index, severity_counts

# =============================================================================
# Module Overview
# =============================================================================
# Plain-text walkthroughs of a board for listeners who cannot see it: the voice
# coach reads `brief` aloud, and coding agents get it from the MCP tools. Short
# sentences, no tables and no ids a listener would have to look up.


def brief(system: SystemMap, analysis: ThreatAnalysis | None, *, max_threats: int = 3) -> str:
    """Describe the system, its trust boundaries, its riskiest AI components and its top threats."""
    nodes = node_index(system)
    lines = [f"{system.name}: {system.summary}"]

    zones = [b.label for b in system.boundaries]
    crossing = [f for f in system.flows if crosses_boundary(system, f)]
    lines.append(
        f"The map has {len(system.nodes)} parts in {len(zones)} trust zones"
        + (f" ({', '.join(zones)})" if zones else "")
        + f", and data crosses a trust boundary in {len(crossing)} places."
    )

    sensitive = [n.label for n in system.nodes if n.sensitive]
    if sensitive:
        lines.append(f"Sensitive data rests in {', '.join(sensitive)}.")

    for exposure in ai_exposure(system):
        node = nodes[exposure.node]
        if exposure.lethal:
            outs = ", ".join(nodes[o].label for o in exposure.outbound)
            lines.append(
                f"{node.label} has the lethal trifecta: it reads sensitive data, takes in untrusted content, "
                f"and can send data out through {outs}."
            )
        elif exposure.untrusted:
            lines.append(f"{node.label} is an AI component that takes in untrusted content.")

    if analysis is None:
        lines.append("Threats have not been found yet: the map is waiting to be confirmed.")
        return "\n".join(lines)

    counts = severity_counts(analysis)
    tally = ", ".join(f"{count} {level}" for level, count in counts.items() if count)
    lines.append(f"There are {len(analysis.threats)} threats: {tally or 'none'}.")
    for threat in analysis.threats[:max_threats]:
        where = label_of(system, analysis, threat.element)
        lines.append(
            f"{threat.id}, {threat.severity}, {STRIDE[threat.stride].name.lower()} at {where}: {threat.summary}"
        )
    lines.append(f"What to fix first: {analysis.verdict}")
    return "\n".join(lines)


def describe_element(system: SystemMap, analysis: ThreatAnalysis | None, item_id: str) -> str:
    """Describe one node or flow and the threats pinned to it, or say the id is not on the map."""
    nodes = node_index(system)
    threats = [t for t in (analysis.threats if analysis else []) if t.element == item_id]
    if item_id in nodes:
        node = nodes[item_id]
        traits: list[str] = [node.kind]
        if node.tech:
            traits.append(node.tech)
        if node.ai:
            traits.append("AI component")
        if node.sensitive:
            traits.append("holds sensitive data")
        text = f"{node.label} ({', '.join(traits)}). Evidence: {node.evidence}"
    else:
        flow = next((f for f in system.flows if f.id == item_id), None)
        if flow is None:
            return f"There is no node or flow with id {item_id} on this map."
        carries = f" It carries {flow.data}." if flow.data else ""
        crossing = " It crosses a trust boundary." if crosses_boundary(system, flow) else ""
        text = f"{flow_label(system, flow)}.{carries}{crossing}"
    for threat in threats:
        text += f"\n{threat.id} ({threat.severity}): {threat.title}. Fix: {'; '.join(threat.fixes)}"
    return text
