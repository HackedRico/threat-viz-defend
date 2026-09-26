from app.domain.models import AttackPath, Boundary
from app.domain.rules import (
    ai_exposure,
    checklist_text,
    coverage_checklist,
    crosses_boundary,
    remove_element,
    sanitize_analysis,
    sanitize_map,
    severity_counts,
)
from tests.factories import analysis, flow, inbox, node, system, threat, trifecta_map


def test_flow_between_zones_crosses_a_boundary() -> None:
    example = inbox().map
    flows = {f.id: f for f in example.flows}
    assert crosses_boundary(example, flows["f4"])  # browser to backend
    assert not crosses_boundary(example, flows["f11"])  # Postgres to agent, both backend


def test_inbox_agent_has_the_lethal_trifecta() -> None:
    exposure = next(x for x in ai_exposure(inbox().map) if x.node == "agent")
    assert exposure.lethal
    assert exposure.private_data == ("db",)
    assert set(exposure.outbound) == {"google", "websites", "logs"}
    # The model provider answers the agent; it is neither untrusted input nor a way out.
    assert "openai" not in exposure.untrusted + exposure.outbound


def test_a_user_who_is_the_only_input_and_output_is_not_a_trifecta() -> None:
    chat = system(
        [node("user", "external"), node("bot", ai=True), node("notes", "store", sensitive=True)],
        [flow("f1", "user", "bot"), flow("f2", "notes", "bot"), flow("f3", "bot", "user")],
    )
    exposure = ai_exposure(chat)[0]
    assert exposure.private_data == ("notes",)
    assert exposure.untrusted == ("user",)
    assert exposure.outbound == ("user",)
    assert not exposure.lethal


def test_checklist_covers_every_element_and_flags_the_trifecta() -> None:
    example = inbox().map
    checked = {c.element for c in coverage_checklist(example)}
    assert checked == {n.id for n in example.nodes} | {f.id for f in example.flows}
    assert "LETHAL TRIFECTA" in checklist_text(example)


def test_sanitize_map_repairs_ids_and_drops_broken_references() -> None:
    messy = system(
        [
            node("Web App", boundary="Cloud"),
            node("web app"),  # same id once normalized
            node("db", "store", boundary="nowhere"),
        ],
        [
            flow("F 1", "Web App", "db"),
            flow("f2", "Web App", "ghost"),
            flow("f3", "db", "db"),
        ],
        boundaries=("Cloud", "empty"),
    )
    clean = sanitize_map(messy)
    assert [n.id for n in clean.nodes] == ["web-app", "db"]
    assert clean.nodes[0].boundary == "cloud"
    assert clean.nodes[1].boundary is None
    assert [(f.id, f.source, f.target) for f in clean.flows] == [("f-1", "web-app", "db")]
    assert [b.id for b in clean.boundaries] == ["cloud"]


def test_sanitize_map_keeps_a_clean_map_unchanged() -> None:
    example = inbox().map
    assert sanitize_map(example) == example


def test_sanitize_analysis_drops_unknown_targets_sorts_and_renumbers() -> None:
    small = trifecta_map()
    raw = analysis(
        [threat("T1", "f3", "medium"), threat("T2", "ghost", "critical"), threat("T3", "agent", "critical")],
        [
            AttackPath(
                id="P9",
                title="t",
                severity="high",
                steps=["attacker", "agent", "mail"],
                threats=["T3", "T2"],
                story="s",
            ),
            AttackPath(id="P8", title="t", severity="low", steps=["ghost"], threats=[], story="s"),
        ],
    )
    clean = sanitize_analysis(small, raw)
    assert [(t.id, t.element) for t in clean.threats] == [("T1", "agent"), ("T2", "f3")]
    assert len(clean.paths) == 1
    assert clean.paths[0].id == "P1"
    assert clean.paths[0].threats == ["T1"]


def test_remove_element_drops_flows_that_lose_an_end() -> None:
    trimmed = remove_element(trifecta_map(), "agent")
    assert all("agent" not in (f.source, f.target) for f in trimmed.flows)
    assert trimmed.flows == []


def test_remove_element_drops_empty_boundaries() -> None:
    small = system([node("a", boundary="one"), node("b", boundary="two")], [], boundaries=("one", "two"))
    assert remove_element(small, "b").boundaries == [Boundary(id="one", label="One")]


def test_severity_counts_lists_every_level() -> None:
    assert severity_counts(inbox().analysis) == {"critical": 1, "high": 3, "medium": 3, "low": 0}
    assert severity_counts(None) == {"critical": 0, "high": 0, "medium": 0, "low": 0}
