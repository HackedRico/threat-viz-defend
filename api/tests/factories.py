from app.domain.models import AttackPath, Boundary, Flow, Node, SystemMap, Threat, ThreatAnalysis
from app.examples import Example, load_examples

# =============================================================================
# Module Overview
# =============================================================================
# Builders for test maps and threats. `inbox` returns the built-in example by
# name, and `node`, `flow` and `threat` fill every required field so a test only
# spells out what it is about.


def inbox() -> Example:
    """The built-in Inbox Helper example."""
    return next(example for example in load_examples() if example.key == "inbox_helper")


def node(
    node_id: str,
    kind: str = "process",
    *,
    boundary: str | None = "cloud",
    ai: bool = False,
    sensitive: bool = False,
    label: str | None = None,
) -> Node:
    """A node with evidence filled in."""
    return Node.model_validate(
        {
            "id": node_id,
            "label": label or node_id.title(),
            "kind": kind,
            "tech": None,
            "boundary": None if kind == "external" else boundary,
            "ai": ai,
            "sensitive": sensitive,
            "evidence": f"inferred: {node_id} is in the test",
        }
    )


def flow(flow_id: str, source: str, target: str, label: str = "data") -> Flow:
    """A flow with evidence filled in."""
    return Flow(id=flow_id, source=source, target=target, label=label, data=None, evidence=f"test flow {flow_id}")


def system(nodes: list[Node], flows: list[Flow], boundaries: tuple[str, ...] = ("cloud",)) -> SystemMap:
    """A map named Test holding `nodes` and `flows`."""
    return SystemMap(
        name="Test",
        summary="A system for tests.",
        boundaries=[Boundary(id=b, label=b.title()) for b in boundaries],
        nodes=nodes,
        flows=flows,
        assumptions=[],
    )


def threat(threat_id: str, element: str, severity: str = "high", stride: str = "I") -> Threat:
    """A threat pinned to `element`."""
    return Threat.model_validate(
        {
            "id": threat_id,
            "element": element,
            "stride": stride,
            "severity": severity,
            "title": f"Threat {threat_id}",
            "summary": f"Summary of {threat_id}.",
            "statement": "A tester can test, which leads to tests, resulting in reduced boredom of testers.",
            "impact": "None.",
            "fixes": [f"Fix {threat_id}"],
            "refs": [],
            "evidence": "inferred: test",
        }
    )


def analysis(threats: list[Threat], paths: list[AttackPath] | None = None) -> ThreatAnalysis:
    """An analysis with a fixed verdict."""
    return ThreatAnalysis(verdict="Fix things.", threats=threats, paths=paths or [])


def trifecta_map() -> SystemMap:
    """A small agent with the lethal trifecta where one flow carries all its private data."""
    return system(
        [
            node("attacker", "external", label="Web page"),
            node("agent", ai=True, label="Agent"),
            node("vault", "store", sensitive=True, label="Vault"),
            node("mail", "external", label="Mail API"),
        ],
        [
            flow("f1", "attacker", "agent", "page text"),
            flow("f2", "vault", "agent", "secrets"),
            flow("f3", "agent", "mail", "send"),
        ],
    )
