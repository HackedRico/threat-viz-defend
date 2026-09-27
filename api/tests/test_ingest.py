from datetime import UTC, datetime

from app.boards.ingest import SourceItem, build_material, number_lines

# =============================================================================
# Module Overview
# =============================================================================
# How uploads become material for the map prompt: code gets line numbers the
# map can cite, and prose and pasted text stay as they were written.

NOW = datetime(2026, 9, 26, tzinfo=UTC)


def test_number_lines_counts_from_one() -> None:
    assert number_lines("import os\n\nmain()") == "1| import os\n2| \n3| main()"


def test_code_files_are_numbered_and_prose_is_not() -> None:
    material = build_material(
        [
            SourceItem(name="worker/sync.py", kind="code", text="def poll_inbox():\n    pass"),
            SourceItem(name="README.md", kind="code", text="# Sync\nPolls Gmail."),
            SourceItem(name="notes", kind="text", text="The worker polls Gmail."),
        ],
        NOW,
    )
    assert "1| def poll_inbox():\n2|     pass" in material.text
    assert "# Sync\nPolls Gmail." in material.text
    assert "The worker polls Gmail." in material.text
    assert "1| # Sync" not in material.text


def test_numbers_come_after_masking_so_line_anchored_secrets_are_still_masked() -> None:
    material = build_material(
        [SourceItem(name="app/settings.py", kind="code", text='API_KEY = "sk-live-1234567890abcdef"')], NOW
    )
    assert "sk-live-1234567890abcdef" not in material.text
    assert material.text.count("1| ") == 1
