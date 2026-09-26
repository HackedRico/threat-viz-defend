import json
import re
from pathlib import Path

import pytest

from app.domain.briefing import brief, describe_element
from app.examples import EXAMPLES_DIR, find_example, load_examples
from tests.factories import inbox


def test_every_example_loads() -> None:
    examples = load_examples()
    assert [e.key for e in examples] == ["inbox_helper"]
    assert inbox().title == "Example: Inbox Helper"


def test_find_example_matches_pasted_material() -> None:
    material = f"  \n{inbox().material}\n\n"
    assert find_example(material) is inbox()
    assert find_example("A to-do app with a Postgres database.") is None


def test_a_broken_example_stops_loading(tmp_path: Path) -> None:
    folder = tmp_path / "broken"
    folder.mkdir()
    board = json.loads((EXAMPLES_DIR / "inbox_helper" / "board.json").read_text())
    board["analysis"]["threats"][0]["element"] = "ghost"
    (folder / "board.json").write_text(json.dumps(board))
    (folder / "material.md").write_text("notes")
    with pytest.raises(ValueError, match="broken"):
        load_examples.__wrapped__(tmp_path)


def test_every_example_reads_in_the_style_the_prompt_asks_for() -> None:
    # The threat prompt copies the example's verdict, so it has to follow the prompt's own rules.
    for example in load_examples():
        assert re.match(r"Fix .+ first: ", example.analysis.verdict)
        assert not re.search(r"\bT\d+\b", example.analysis.verdict)


def test_brief_reads_the_board_aloud() -> None:
    text = brief(inbox().map, inbox().analysis)
    assert "Triage agent has the lethal trifecta" in text
    assert "T1, critical" in text
    assert "What to fix first" in text


def test_describe_element_names_its_threats() -> None:
    text = describe_element(inbox().map, inbox().analysis, "agent")
    assert text.startswith("Triage agent (process")
    assert "T1 (critical)" in text
    assert "no node or flow" in describe_element(inbox().map, None, "ghost")
