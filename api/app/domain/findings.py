from dataclasses import dataclass
from datetime import datetime

from app.domain.models import SystemMap, ThreatAnalysis
from app.domain.rules import crosses_boundary, node_index

# =============================================================================
# Module Overview
# =============================================================================
# Flattens a board's threats into rows for the Snowflake export: the threat's title
# plus the labels worth grouping by (STRIDE letter, severity, element kind, boundary
# and AI flags, catalog refs). Summaries, fixes and evidence stay out of the rows.


@dataclass(frozen=True)
class Finding:
    """One threat on one board, reduced to its title and labels."""

    board_id: str
    threat_id: str
    title: str
    stride: str
    severity: str
    element_kind: str
    crosses_boundary: bool
    touches_ai: bool
    touches_sensitive: bool
    refs: str
    analyzed_at: datetime


def findings(board_id: str, system: SystemMap, analysis: ThreatAnalysis, analyzed_at: datetime) -> list[Finding]:
    """Reduce every threat in `analysis` to a `Finding` row."""
    nodes = node_index(system)
    flows = {flow.id: flow for flow in system.flows}
    rows: list[Finding] = []
    for threat in analysis.threats:
        kind: str
        node = nodes.get(threat.element)
        flow = flows.get(threat.element)
        if node is not None:
            kind, crossing, ends = node.kind, False, [node]
        elif flow is not None:
            ends = [n for n in (nodes.get(flow.source), nodes.get(flow.target)) if n is not None]
            kind, crossing = "flow", crosses_boundary(system, flow)
        else:
            continue
        rows.append(
            Finding(
                board_id=board_id,
                threat_id=threat.id,
                title=threat.title,
                stride=threat.stride,
                severity=threat.severity,
                element_kind=kind,
                crosses_boundary=crossing,
                touches_ai=any(end.ai for end in ends),
                touches_sensitive=any(end.sensitive for end in ends),
                refs=",".join(threat.refs),
                analyzed_at=analyzed_at,
            )
        )
    return rows
