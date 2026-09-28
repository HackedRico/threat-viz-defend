import re

from app.domain.models import SystemMap, ThreatAnalysis
from app.domain.rules import (
    STRIDE,
    ai_exposure,
    code_ref_label,
    crosses_boundary,
    flow_label,
    label_of,
    node_index,
    severity_counts,
)

# =============================================================================
# Module Overview
# =============================================================================
# The Markdown export of a board. Model text is escaped by `_md` so it renders
# as plain text in any Markdown viewer: it cannot form links, images, HTML or
# headings, which keeps a poisoned upload from planting a phishing link in a
# report someone else opens.

_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+\-.!|<>~])")
# GitHub-flavored viewers turn a bare URL, a www. name or an email into a link after they read escapes, so no escape
# stops them. A word joiner, which renders as nothing, breaks each pattern: inside `://`, after a leading `www`, and
# before `@`.
_AUTOLINK = re.compile(r"(?<=:)(?=//)|(?<=\bwww)(?=\.)|(?=@)", re.IGNORECASE)
_JOINER = "\u2060"


def _md(text: str) -> str:
    """Escape Markdown and HTML syntax in untrusted text, break autolinks, and fold it onto one line."""
    return _SPECIAL.sub(r"\\\1", _AUTOLINK.sub(_JOINER, " ".join(text.split())))


def render_report(title: str, system: SystemMap, analysis: ThreatAnalysis | None, analyzed_by: str | None) -> str:
    """The board as a Markdown document: summary, components, flows, AI exposure and threats."""
    nodes = node_index(system)
    lines = [f"# Threat model: {_md(title)}", "", _md(system.summary), ""]
    if analysis is not None:
        counts = severity_counts(analysis)
        tally = ", ".join(f"{n} {level}" for level, n in counts.items() if n) or "none"
        lines += ["## Verdict", "", _md(analysis.verdict), "", f"Threats: {tally}.", ""]
        if analyzed_by:
            lines += [f"Analyzed by {_md(analyzed_by)}. Check every finding against the evidence.", ""]

    lines += ["## Components", "", "| Component | Kind | Tech | Zone | Marks | Evidence |", "|---|---|---|---|---|---|"]
    zones = {b.id: b.label for b in system.boundaries}
    for node in system.nodes:
        marks = ", ".join(m for m, on in (("AI", node.ai), ("sensitive data", node.sensitive)) if on)
        zone = zones.get(node.boundary or "", "outside")
        cells = [_md(node.label), node.kind, _md(node.tech or ""), _md(zone), marks, _md(node.evidence)]
        lines.append(f"| {' | '.join(cells)} |")

    detailed = [node for node in system.nodes if node.how or node.code]
    if detailed:
        lines += ["", "## How each component works", ""]
        for node in detailed:
            lines += [f"### {_md(node.label)}", "", *[f"- {_md(point)}" for point in node.how]]
            if node.code:
                lines.append(f"- In the code: {', '.join(_md(code_ref_label(ref)) for ref in node.code)}")
            lines.append("")
        lines.pop()

    lines += ["", "## Data flows", "", "| Flow | Carries | Crosses a trust boundary |", "|---|---|---|"]
    for flow in system.flows:
        crossing = "yes" if crosses_boundary(system, flow) else "no"
        lines.append(f"| {_md(flow_label(system, flow))} | {_md(flow.data or '')} | {crossing} |")

    lethal = [x for x in ai_exposure(system) if x.lethal]
    if lethal:
        lines += ["", "## Lethal trifecta", ""]
        for x in lethal:
            outs = ", ".join(_md(nodes[o].label) for o in x.outbound)
            name = _md(nodes[x.node].label)
            lines.append(
                f"- {name} reads sensitive data, takes in untrusted content and can send data out through {outs}."
            )

    if analysis is not None:
        lines += ["", "## Threats", ""]
        for threat in analysis.threats:
            lines += [
                f"### {threat.id}. {_md(threat.title)}",
                "",
                f"Severity {threat.severity}, {STRIDE[threat.stride].name.lower()}, at "
                f"{_md(label_of(system, analysis, threat.element))}.",
                "",
                _md(threat.statement),
                "",
                f"Impact: {_md(threat.impact)}",
                "",
                "Fixes:",
                *[f"- {_md(fix)}" for fix in threat.fixes],
                "",
                f"Evidence: {_md(threat.evidence)}",
            ]
            if threat.refs:
                lines.append(f"References: {', '.join(_md(r) for r in threat.refs)}")
            lines.append("")
        if analysis.paths:
            lines += ["## Attack paths", ""]
            for path in analysis.paths:
                steps = " then ".join(_md(label_of(system, analysis, s)) for s in path.steps)
                lines += [f"- {path.id}, {path.severity}: {_md(path.title)}. {steps}. {_md(path.story)}"]
    if system.assumptions:
        lines += ["", "## Assumptions", "", *[f"- {_md(a)}" for a in system.assumptions]]
    return "\n".join(lines) + "\n"
