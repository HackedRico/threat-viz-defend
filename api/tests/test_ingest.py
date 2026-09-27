import os
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.boards.ingest import SourceItem, agent_material, build_material, number_lines
from app.db import utcnow

# =============================================================================
# Module Overview
# =============================================================================
# How uploads and agent changes become material for the map prompt: code gets
# line numbers the map can cite, prose stays as written, and an agent's diff
# loses sections for secret files, whatever git did to their names, and any
# section it cannot name.

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
        # A plain `git diff` during an unresolved merge.
        "diff --cc .env\nindex 1,2..3\n--- a/.env\n+++ b/.env\n@@@ -1,1 -1,1 +1,5 @@@\n++STRIPE=hunter2hunter2\n",
        # A second file inside one section, without its own `diff --git` line.
        "diff --git a/lib.py b/lib.py\n--- a/lib.py\n+++ b/lib.py\n@@ -1 +1 @@\n+x = 1\n"
        "--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+STRIPE=hunter2hunter2\n",
        # Windows line endings.
        'diff --git "a/.env" "b/.env"\r\n--- "a/.env"\r\n+++ "b/.env"\r\n@@ -0,0 +1 @@\r\n+STRIPE=hunter2hunter2\r\n',
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


def test_a_plain_diff_before_any_git_header_is_filtered_too() -> None:
    plain = "--- .env\n+++ .env\n@@ -0,0 +1 @@\n+STRIPE=hunter2hunter2\n"
    assert "hunter2" not in material_text(plain + APP)


def test_a_removed_line_starting_with_dashes_is_not_a_file_name() -> None:
    sql = "diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1 @@\n--- see .env for keys\n select 1\n"
    assert "select 1" in material_text(sql)


def test_real_git_diffs_keep_their_ordinary_sections(tmp_path: Path) -> None:
    def git(*args: str) -> str:
        env = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "PATH": os.environ["PATH"]}
        run = subprocess.run(["git", *args], cwd=tmp_path, env=env, capture_output=True, text=True, check=True)  # noqa: S603, S607
        return run.stdout

    git("init", "-q")
    (tmp_path / "gone.py").write_text("print(1)\n")
    (tmp_path / "old name.py").write_text("x = 1\n" * 20)
    (tmp_path / "tool.sh").write_text("echo hi\n")
    git("add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    (tmp_path / "gone.py").unlink()
    (tmp_path / "old name.py").rename(tmp_path / "new name.py")
    (tmp_path / "tool.sh").chmod(0o755)
    (tmp_path / "logo.bin").write_bytes(bytes(range(256)))
    (tmp_path / "api.py").write_text("import requests\n")
    git("add", "-A")
    for extra in ([], ["--no-prefix"], ["-M"]):
        text = material_text(git("diff", "--cached", *extra))
        assert "could not be read" not in text or extra == ["--no-prefix"]
        assert "+import requests" in text
