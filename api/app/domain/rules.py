import re
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Literal

from app.domain.models import (
    AttackPath,
    Boundary,
    CodeRef,
    ElementKind,
    Flow,
    Node,
    Severity,
    Stride,
    SystemMap,
    Threat,
    ThreatAnalysis,
)

# =============================================================================
# Module Overview
# =============================================================================
# Deterministic security rules that run around every model call. `coverage_checklist`
# applies STRIDE per element and flags trust boundary crossings, `ai_exposure` finds
# the lethal trifecta around AI components, and `sanitize_map` and `sanitize_analysis`
# repair or drop anything the model returns that does not fit the map.

SEVERITIES: tuple[Severity, ...] = ("critical", "high", "medium", "low")

# Caps keep a map readable on one screen and bound what one board stores.
MAX_NODES = 30
MAX_FLOWS = 60
MAX_BOUNDARIES = 10
MAX_THREATS = 10
MAX_PATHS = 5
MAX_TEXT = 600
MAX_LABEL = 80
MAX_DETAILS = 4
MAX_PATH = 200
# An answer or a grade's feedback: a few sentences, with room to spare.
MAX_REPLY = 1500


@dataclass(frozen=True)
class StrideCategory:
    """One STRIDE category: its name, the property it violates and the question it asks."""

    name: str
    property: str
    question: str


STRIDE: dict[Stride, StrideCategory] = {
    "S": StrideCategory("Spoofing", "authentication", "How do we know who or what is on the other end?"),
    "T": StrideCategory("Tampering", "integrity", "Who can change this, and would we notice?"),
    "R": StrideCategory("Repudiation", "accountability", "Could we prove who did it?"),
    "I": StrideCategory("Information disclosure", "confidentiality", "Who can read this who should not?"),
    "D": StrideCategory("Denial of service", "availability", "What happens when this is flooded or starved?"),
    "E": StrideCategory("Elevation of privilege", "authorization", "Can someone gain powers they should not have?"),
}

# STRIDE per element, from the Microsoft SDL. A store also earns R when it holds audit logs,
# which a drawn map cannot tell, so that call is left to the model.
_PER_ELEMENT: dict[ElementKind, tuple[Stride, ...]] = {
    "external": ("S", "R"),
    "process": ("S", "T", "R", "I", "D", "E"),
    "store": ("T", "I", "D"),
}

_ID_UNSAFE = re.compile(r"[^a-z0-9_.:-]+")


# =============================================================================
# Lookups
# =============================================================================


def severity_rank(severity: Severity) -> int:
    """Rank a severity so `critical` sorts first."""
    return SEVERITIES.index(severity)


def node_index(system: SystemMap) -> dict[str, Node]:
    """Index a map's nodes by id."""
    return {node.id: node for node in system.nodes}


def crosses_boundary(system: SystemMap, flow: Flow) -> bool:
    """True when a flow's two ends sit in different trust zones."""
    nodes = node_index(system)
    source = nodes.get(flow.source)
    target = nodes.get(flow.target)
    return (source.boundary if source else None) != (target.boundary if target else None)


def element_ids(system: SystemMap) -> set[str]:
    """Every node and flow id: the places a threat can be pinned."""
    return {node.id for node in system.nodes} | {flow.id for flow in system.flows}


def known_ids(system: SystemMap, analysis: ThreatAnalysis | None) -> set[str]:
    """Every id a highlight may name: nodes, flows and threats."""
    threat_ids = {threat.id for threat in analysis.threats} if analysis else set()
    return element_ids(system) | threat_ids


def only_known(ids: Iterable[str], known: set[str]) -> list[str]:
    """Keep the ids found in `known`, once each, in their original order."""
    # A model may repeat an id; keep the first so highlight order stays stable.
    seen: set[str] = set()
    kept: list[str] = []
    for item in ids:
        if item in known and item not in seen:
            seen.add(item)
            kept.append(item)
    return kept


def label_of(system: SystemMap, analysis: ThreatAnalysis | None, item_id: str) -> str:
    """Human label for a node, flow or threat id, falling back to the id itself."""
    nodes = node_index(system)
    if item_id in nodes:
        return nodes[item_id].label
    for flow in system.flows:
        if flow.id == item_id:
            return flow_label(system, flow)
    for threat in analysis.threats if analysis else []:
        if threat.id == item_id:
            return f"{threat.id} {threat.title}"
    return item_id


def flow_label(system: SystemMap, flow: Flow) -> str:
    """Name a flow by its ends and label, as in `Browser to API: sign in`."""
    nodes = node_index(system)
    source = nodes[flow.source].label if flow.source in nodes else flow.source
    target = nodes[flow.target].label if flow.target in nodes else flow.target
    return f"{source} to {target}: {flow.label}"


def severity_counts(analysis: ThreatAnalysis | None) -> dict[Severity, int]:
    """Count threats per severity, with every level present."""
    counts: dict[Severity, int] = {severity: 0 for severity in SEVERITIES}
    for threat in analysis.threats if analysis else []:
        counts[threat.severity] += 1
    return counts


# =============================================================================
# AI exposure: the lethal trifecta
# =============================================================================


@dataclass(frozen=True)
class AiExposure:
    """What reaches one AI component and where its output can go."""

    node: str
    private_data: tuple[str, ...]
    untrusted: tuple[str, ...]
    outbound: tuple[str, ...]
    lethal: bool


def ai_exposure(system: SystemMap) -> list[AiExposure]:
    """Report, for every AI node, which legs of the lethal trifecta it has."""
    nodes = node_index(system)
    exposures: list[AiExposure] = []
    for node in system.nodes:
        if not node.ai:
            continue
        upstream = [nodes[i] for i in _reachable(system, node.id, "up")]
        downstream = [nodes[i] for i in _reachable(system, node.id, "down")]
        private_data = tuple(n.id for n in upstream if n.sensitive)
        # An external AI node is the model provider itself: it answers the component
        # rather than feeding it third party content or carrying data away.
        untrusted = tuple(n.id for n in upstream if n.kind == "external" and not n.ai)
        outbound = tuple(n.id for n in downstream if n.kind == "external" and not n.ai)
        # The trifecta needs a third party: content from one party that can steer data to
        # another. A user who is both the only input and the only output is not one.
        lethal = bool(private_data) and any(u != o for u in untrusted for o in outbound)
        exposures.append(AiExposure(node.id, private_data, untrusted, outbound, lethal))
    return exposures


def _reachable(system: SystemMap, start: str, direction: Literal["up", "down"]) -> list[str]:
    """Node ids reachable from `start` along flows, stopping at external entities."""
    nodes = node_index(system)
    seen: set[str] = set()
    order: list[str] = []
    queue: deque[str] = deque([start])
    while queue:
        current = queue.popleft()
        for flow in system.flows:
            here, there = (flow.target, flow.source) if direction == "up" else (flow.source, flow.target)
            if here != current or there == start or there in seen or there not in nodes:
                continue
            seen.add(there)
            order.append(there)
            # Whatever sits beyond an external entity is outside what this map can speak for.
            if nodes[there].kind != "external":
                queue.append(there)
    return order


# =============================================================================
# Coverage checklist handed to the model
# =============================================================================


@dataclass(frozen=True)
class Check:
    """STRIDE categories to consider on one element, and why."""

    element: str
    letters: tuple[Stride, ...]
    why: str


def coverage_checklist(system: SystemMap) -> list[Check]:
    """Decide in code what every element must be checked for, so coverage never depends on the model."""
    checks: list[Check] = []
    for node in system.nodes:
        notes: list[str] = [node.kind]
        if node.sensitive:
            notes.append("holds sensitive data")
        if node.ai:
            notes.append("AI component")
        checks.append(Check(node.id, _PER_ELEMENT[node.kind], ", ".join(notes)))
    for flow in system.flows:
        if crosses_boundary(system, flow):
            why = f"crosses a trust boundary ({flow_label(system, flow)}); check how the receiver knows the sender"
            checks.append(Check(flow.id, ("S", "T", "I", "D"), why))
        else:
            checks.append(Check(flow.id, ("T", "I", "D"), "internal flow"))
    for exposure in ai_exposure(system):
        notes = ["AI component: check OWASP LLM10:2025 unbounded consumption"]
        if exposure.untrusted:
            notes.append("untrusted content reaches it: check OWASP LLM01:2025 prompt injection")
        if exposure.private_data:
            notes.append("it reads sensitive data: check OWASP LLM02:2025 sensitive information disclosure")
        if exposure.outbound:
            notes.append("it can send data out: check OWASP LLM06:2025 excessive agency")
        if exposure.lethal:
            notes.append("LETHAL TRIFECTA: sensitive data, untrusted content and a way out meet here")
        checks.append(Check(exposure.node, ("T", "I", "E"), "; ".join(notes)))
    return checks


def checklist_text(system: SystemMap) -> str:
    """Render the checklist as prompt text, one line per check."""
    return "\n".join(f"- {c.element}: {''.join(c.letters)} ({c.why})" for c in coverage_checklist(system))


# =============================================================================
# Sanitizers: keep every reference consistent with the map
# =============================================================================


def slug_id(raw: str, fallback: str) -> str:
    """Normalize an id to lowercase characters that are safe in URLs, DOM ids and prompts."""
    cleaned = _ID_UNSAFE.sub("-", raw.strip().lower()).strip("-")[:40]
    return cleaned or fallback


def code_ref_label(ref: CodeRef) -> str:
    """A code reference as `path:line (symbol)`, leaving out the parts the model did not give."""
    where = f"{ref.path}:{ref.line}" if ref.line is not None else ref.path
    return f"{where} ({ref.symbol})" if ref.symbol else where


def _sanitize_code(refs: list[CodeRef]) -> list[CodeRef]:
    """Fold code references onto one line, drop empty paths and duplicates, and keep only positive line numbers."""
    kept: list[CodeRef] = []
    seen: set[tuple[str, int | None, str | None]] = set()
    for ref in refs:
        path = "".join(ref.path.split()).strip("`'\"")[:MAX_PATH]
        line = ref.line if ref.line is not None and ref.line > 0 else None
        clean = CodeRef(path=path, line=line, symbol=_one_line_optional(ref.symbol, MAX_LABEL))
        key = (clean.path, clean.line, clean.symbol)
        if not path or key in seen:
            continue
        seen.add(key)
        kept.append(clean)
    return kept[:MAX_DETAILS]


def _resolver(ids: dict[str, str], labels: Iterable[tuple[str, str]]) -> Callable[[str | None], str | None]:
    """Find what a model's reference names: the exact id, the id in another case or spacing, else a label."""
    # Without this, a map whose flows name nodes by label, or ids in title case, loses every flow.
    aliases: dict[str, str] = {}
    for raw, new in ids.items():
        aliases.setdefault(slug_id(raw, ""), new)
    for label, new in labels:
        aliases.setdefault(slug_id(label, ""), new)
    aliases.pop("", None)

    def resolve(ref: str | None) -> str | None:
        if ref is None:
            return None
        return ids.get(ref) or aliases.get(slug_id(ref, ""))

    return resolve


def _free_id(wanted: str, taken: set[str], prefix: str) -> str:
    """`wanted` when free, else the next `<prefix>N` nobody holds, so a repeated id renames rather than drops."""
    if wanted not in taken:
        return wanted
    number = len(taken) + 1
    while f"{prefix}{number}" in taken:
        number += 1
    return f"{prefix}{number}"


def sanitize_map(system: SystemMap) -> SystemMap:
    """Normalize ids, resolve loose references, drop broken ones and duplicates, fold text and cap sizes."""
    boundaries: list[Boundary] = []
    boundary_ids: dict[str, str] = {}
    boundary_labels: list[tuple[str, str]] = []
    for index, boundary in enumerate(system.boundaries[:MAX_BOUNDARIES]):
        new_id = slug_id(boundary.id, f"zone-{index + 1}")
        if new_id in boundary_ids.values():
            continue
        boundary_ids[boundary.id] = new_id
        boundary_labels.append((boundary.label, new_id))
        boundaries.append(Boundary(id=new_id, label=_one_line(boundary.label, MAX_LABEL)))
    zone_of = _resolver(boundary_ids, boundary_labels)

    # Nodes and flows share one id space, because threats and highlights point at either kind.
    taken: set[str] = set()
    node_ids: dict[str, str] = {}
    node_labels: list[tuple[str, str]] = []
    nodes: list[Node] = []
    for index, node in enumerate(system.nodes[:MAX_NODES]):
        new_id = slug_id(node.id, f"n{index + 1}")
        if new_id in taken:
            continue
        taken.add(new_id)
        node_ids[node.id] = new_id
        node_labels.append((node.label, new_id))
        zone = zone_of(node.boundary)
        nodes.append(
            node.model_copy(
                update={
                    "id": new_id,
                    "label": _one_line(node.label, MAX_LABEL),
                    "tech": _one_line_optional(node.tech, MAX_LABEL),
                    "boundary": zone,
                    "evidence": _one_line(node.evidence, MAX_TEXT),
                    "how": [_one_line(b, MAX_TEXT) for b in node.how if b.strip()][:MAX_DETAILS],
                    "code": _sanitize_code(node.code),
                }
            )
        )

    node_of = _resolver(node_ids, node_labels)
    flows: list[Flow] = []
    for index, flow in enumerate(system.flows):
        if len(flows) >= MAX_FLOWS:
            break
        source = node_of(flow.source)
        target = node_of(flow.target)
        if source is None or target is None or source == target:
            continue
        new_id = _free_id(slug_id(flow.id, f"f{index + 1}"), taken, "f")
        taken.add(new_id)
        flows.append(
            flow.model_copy(
                update={
                    "id": new_id,
                    "source": source,
                    "target": target,
                    "label": _one_line(flow.label, MAX_LABEL),
                    "data": _one_line_optional(flow.data, MAX_TEXT),
                    "evidence": _one_line_optional(flow.evidence, MAX_TEXT),
                }
            )
        )

    # A boundary with no members would draw as an empty box.
    used = {node.boundary for node in nodes if node.boundary is not None}
    return SystemMap(
        name=_one_line(system.name, MAX_LABEL),
        summary=_one_line(system.summary, MAX_TEXT),
        boundaries=[b for b in boundaries if b.id in used],
        nodes=nodes,
        flows=flows,
        assumptions=[_one_line(a, MAX_TEXT) for a in system.assumptions[:8]],
    )


def sanitize_analysis(system: SystemMap, analysis: ThreatAnalysis) -> ThreatAnalysis:
    """Resolve loose references, drop threats and path steps the map lacks, sort, renumber and fold text."""
    place_of = _resolver(
        {place: place for place in element_ids(system)},
        [(node.label, node.id) for node in system.nodes],
    )
    seen: set[tuple[str, str, str]] = set()
    kept: list[Threat] = []
    for threat in analysis.threats:
        element = place_of(threat.element)
        # The same threat twice is dropped; two threats that only share an id are both kept and renumbered.
        key = (threat.id, element or "", threat.title)
        if element is None or key in seen:
            continue
        seen.add(key)
        kept.append(threat.model_copy(update={"element": element}))
    # A stable sort keeps the model's own order among threats of equal severity.
    kept.sort(key=lambda t: severity_rank(t.severity))
    kept = kept[:MAX_THREATS]

    # Path threat lists name the model's ids; with a repeated id they follow its first threat.
    renumbered: dict[str, str] = {}
    for index, threat in enumerate(kept):
        renumbered.setdefault(threat.id, f"T{index + 1}")
    threats = [
        threat.model_copy(
            update={
                "id": f"T{index + 1}",
                "title": _one_line(threat.title, MAX_LABEL),
                "summary": _one_line(threat.summary, MAX_TEXT),
                "statement": _one_line(threat.statement, MAX_TEXT),
                "impact": _one_line(threat.impact, MAX_TEXT),
                "fixes": [_one_line(fix, MAX_TEXT) for fix in threat.fixes[:3]],
                "refs": [_one_line(ref, 40) for ref in threat.refs[:6]],
                "evidence": _one_line(threat.evidence, MAX_TEXT),
            }
        )
        for index, threat in enumerate(kept)
    ]

    step_of = _resolver({node.id: node.id for node in system.nodes}, [(node.label, node.id) for node in system.nodes])
    paths: list[AttackPath] = []
    path_keys: set[tuple[str, ...]] = set()
    for path in sorted(analysis.paths, key=lambda p: severity_rank(p.severity)):
        steps = [found for found in (step_of(step) for step in path.steps) if found is not None]
        path_key = (path.id, *steps)
        if len(steps) < 2 or path_key in path_keys:
            continue
        path_keys.add(path_key)
        along = only_known((renumbered.get(t, "") for t in path.threats), set(renumbered.values()))
        paths.append(
            path.model_copy(
                update={
                    "id": f"P{len(paths) + 1}",
                    "title": _one_line(path.title, MAX_LABEL),
                    "steps": steps,
                    "threats": along,
                    "story": _one_line(path.story, MAX_TEXT),
                }
            )
        )
        if len(paths) >= MAX_PATHS:
            break

    return ThreatAnalysis(verdict=_one_line(analysis.verdict, MAX_TEXT), threats=threats, paths=paths)


def remove_element(system: SystemMap, item_id: str) -> SystemMap:
    """Remove one node or flow, along with flows that lose an end."""
    trimmed = system.model_copy(
        update={
            "nodes": [n for n in system.nodes if n.id != item_id],
            "flows": [f for f in system.flows if f.id != item_id and item_id not in (f.source, f.target)],
        }
    )
    used = {node.boundary for node in trimmed.nodes if node.boundary is not None}
    return trimmed.model_copy(update={"boundaries": [b for b in trimmed.boundaries if b.id in used]})


def clip(text: str, limit: int) -> str:
    """`text` cut to `limit` characters, marking the cut, for model text that keeps its line breaks."""
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _one_line(text: str, limit: int) -> str:
    """Fold every run of whitespace, line breaks included, into one space and cut to `limit`, marking the cut."""
    # Agents read map and threat text line by line in `get_board` and `describe_element`, where a line
    # break could pose as another id or threat. `str.split()` also breaks on `\r`, `\x85` and U+2028.
    folded = " ".join(text.split())
    return folded if len(folded) <= limit else folded[: limit - 1].rstrip() + "…"


def _one_line_optional(text: str | None, limit: int) -> str | None:
    """`_one_line` for nullable fields, turning blank text into `None`."""
    if text is None or not text.strip():
        return None
    return _one_line(text, limit)
