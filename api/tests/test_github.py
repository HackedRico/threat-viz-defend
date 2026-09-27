import io
import tarfile
from datetime import UTC, datetime

import httpx
import pytest

from app.boards.github import RepoRef, fetch_repo, parse_repo_url
from app.errors import AppError

# =============================================================================
# Module Overview
# =============================================================================
# The GitHub importer against a recorded archive host: the URL forms people
# paste, telling a branch from a folder in `/tree/...`, and reading code
# rather than a repository's docs.

NOW = datetime(2026, 9, 27, tzinfo=UTC)


@pytest.mark.parametrize(
    ("url", "ref"),
    [
        ("https://github.com/pallets/flask", RepoRef("pallets", "flask", None)),
        ("https://github.com/pallets/flask.git", RepoRef("pallets", "flask", None)),
        ("https://github.com/pallets/flask/", RepoRef("pallets", "flask", None)),
        ("https://www.GitHub.com/pallets/flask?tab=readme-ov-file#readme", RepoRef("pallets", "flask", None)),
        ("https://github.com/pallets/flask/tree/main/", RepoRef("pallets", "flask", "main")),
        (
            "https://github.com/pallets/flask/tree/main/examples/tutorial",
            RepoRef("pallets", "flask", "main/examples/tutorial"),
        ),
        ("https://github.com/pallets/flask/blob/main/src/flask/app.py", RepoRef("pallets", "flask", "main")),
    ],
)
def test_the_url_forms_people_paste_are_read(url: str, ref: RepoRef) -> None:
    assert parse_repo_url(url) == ref


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/pallets/flask",
        "https://gitlab.com/a/b",
        "https://github.com/pallets",
        "https://github.com/a/../b",
    ],
)
def test_anything_else_is_refused(url: str) -> None:
    with pytest.raises(AppError):
        parse_repo_url(url)


def archive(files: dict[str, str]) -> bytes:
    """A tarball shaped like GitHub's: every path under one `<repo>-<sha>/` folder."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for path, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(f"flask-abc123/{path}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def github(refs: dict[str, bytes], asked: list[str]) -> httpx.Client:
    """An archive host that knows only `refs`, recording each ref asked for."""

    def handle(request: httpx.Request) -> httpx.Response:
        ref = request.url.path.split("/tar.gz/", 1)[1]
        asked.append(ref)
        return httpx.Response(200, content=refs[ref]) if ref in refs else httpx.Response(404)

    return httpx.Client(transport=httpx.MockTransport(handle))


def test_a_tree_url_reads_only_its_folder_after_finding_the_branch() -> None:
    files = {"README.md": "# Flask", "examples/tutorial/app.py": "app = 1", "src/flask/app.py": "class Flask: ..."}
    asked: list[str] = []
    ref = parse_repo_url("https://github.com/pallets/flask/tree/release/3.1/examples/tutorial")
    material = fetch_repo(ref, NOW, github({"release/3.1": archive(files)}, asked))
    assert asked == ["release", "release/3.1"]
    assert "examples/tutorial/app.py" in material.text
    assert "src/flask/app.py" not in material.text


def test_code_is_read_before_a_pile_of_docs() -> None:
    docs = {f"docs/page{i}.md": "Words about the project. " * 400 for i in range(60)}
    files = {**docs, "pyproject.toml": "[project]\nname = 'flask'", "src/flask/app.py": "class Flask: ..."}
    material = fetch_repo(parse_repo_url("https://github.com/pallets/flask"), NOW, github({"HEAD": archive(files)}, []))
    assert "src/flask/app.py" in material.text
    assert "pyproject.toml" in material.text


def test_an_unknown_repository_says_so() -> None:
    with pytest.raises(ValueError, match="no public repository"):
        fetch_repo(parse_repo_url("https://github.com/pallets/nope"), NOW, github({}, []))
