import json
import re
from pathlib import Path

import pytest

from app.analysis.analyst import DemoAnalyst
from app.boards.service import read_map
from app.domain.briefing import brief, describe_element
from app.domain.report import render_report
from app.domain.rules import known_ids
from app.examples import EXAMPLES_DIR, find_example, load_examples
from app.tables import BoardRow
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


def test_demo_mode_answers_every_recorded_question_with_ids_on_the_map() -> None:
    # The ask bar's starter questions on the example are recorded answers, so a first run without a key gets replies.
    demo = DemoAnalyst()
    for example in load_examples():
        known = known_ids(example.map, example.analysis)
        for question, recorded in example.answers.items():
            assert set(recorded.highlight) <= known, question
            assert demo.answer(example.map, example.analysis, question, None) == recorded


def test_brief_reads_the_board_aloud() -> None:
    text = brief(inbox().map, inbox().analysis)
    assert "Triage agent has the lethal trifecta" in text
    assert "T1, critical" in text
    assert "What to fix first" in text


def test_describe_element_names_its_threats() -> None:
    text = describe_element(inbox().map, inbox().analysis, "agent")
    assert text is not None
    assert text.startswith("Triage agent (process")
    assert "T1 (critical)" in text
    assert describe_element(inbox().map, None, "ghost") is None


def test_describe_element_says_how_it_works_and_where_the_code_is() -> None:
    text = describe_element(inbox().map, None, "sync")
    assert text is not None
    assert "How it works: `poll_inbox` runs on an APScheduler interval" in text
    assert "In the code: worker/sync.py:38 (poll_inbox)" in text


def test_the_report_explains_each_component() -> None:
    report = render_report("Inbox", inbox().map, None, None)
    assert "## How each component works" in report
    assert "- In the code: worker/sync\\.py:38 \\(poll\\_inbox\\)" in report


def test_an_example_board_saved_before_details_existed_shows_them() -> None:
    old = inbox().map.model_dump(mode="json", exclude={"nodes": {"__all__": {"how", "code"}}})
    shown = read_map(BoardRow(id="b1", example=True, map=old))
    assert shown == inbox().map
    # A board the user drew keeps what is stored, even when it shares the example's name.
    assert read_map(BoardRow(id="b2", example=False, map=old)) != inbox().map
