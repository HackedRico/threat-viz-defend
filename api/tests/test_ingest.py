import time

import pytest

from app.boards.ingest import agent_material
from app.db import utcnow

# =============================================================================
# Module Overview
# =============================================================================
# How `agent_material` filters a coding agent's diff: sections for secret files
# go, whatever git did to their names, and so does any section it cannot name.

APP = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n+import redis\n"


def material_text(diff: str, files: list[str] | None = None) -> str:
    return agent_material("Claude Code", "Added a cache", diff, files or [], utcnow()).text


@pytest.mark.parametrize(
    "section",
    [
        # Git leaves a path with spaces unquoted.
        "diff --git a/deploy/prod env/.env b/deploy/prod env/.env\n--- a/deploy/prod env/.env\n"
        "+++ b/deploy/prod env/.env\n@@ -0,0 +1 @@\n+STRIPE=hunter2hunter2\n",
        # And quotes a non-ASCII path with octal escapes.
        'diff --git "a/caf\\303\\251/.env" "b/caf\\303\\251/.env"\n--- "a/caf\\303\\251/.env"\n'
        '+++ "b/caf\\303\\251/.env"\n@@ -0,0 +1 @@\n+STRIPE=hunter2hunter2\n',
        # A rename into a secret file names it only on the `rename to` line.
        "diff --git a/old notes b/prod/.env\nsimilarity index 90%\nrename from old notes\nrename to prod/.env\n"
        "@@ -1 +1 @@\n+STRIPE=hunter2hunter2\n",
        # A header nothing can read is dropped rather than trusted.
        "diff --git ???\n+STRIPE=hunter2hunter2\n",
    ],
)
def test_secret_sections_are_dropped_however_git_names_them(section: str) -> None:
    text = material_text(APP + section)
    assert "hunter2" not in text
    assert "+import redis" in text
    assert "[left out:" in text


def test_ordinary_sections_with_spaces_are_kept() -> None:
    section = (
        "diff --git a/src/new file.py b/src/new file.py\nnew file mode 100644\n--- /dev/null\n"
        "+++ b/src/new file.py\n@@ -0,0 +1 @@\n+print('ok')\n"
    )
    assert "+print('ok')" in material_text(section)


def test_long_file_lists_are_clipped() -> None:
    files = [f"src/{'x' * 400}_{n}.py" for n in range(500)]
    assert len(material_text(APP, files)) < 40_000


def test_diff_filtering_stays_fast_on_hostile_input() -> None:
    hostile = 'diff --git "a/' + "\\" * 200_000 + "\n" + "diff --git a/ b/\n" * 20_000
    started = time.monotonic()
    material_text(hostile)
    assert time.monotonic() - started < 2
