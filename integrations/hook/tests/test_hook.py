from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

HOOK_PATH = Path(__file__).resolve().parents[1] / "threatviz_hook.py"
BOARD = "board-1"
# A fake token for the local stub; it only has to look like a real one.
TOKEN = "tvd_" + "t" * 32
IDENTITY = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}
POLICY = {
    "secretNames": [".env", ".npmrc", "credentials", "id_rsa"],
    "secretExtensions": ["pem", "key", "tfvars"],
    "safeEnvSuffixes": ["example", "sample"],
    "ignoredDirs": ["node_modules", "dist", ".venv"],
    "lockfiles": ["package-lock.json", "uv.lock"],
    "binaryExtensions": ["png", "zip"],
    "maxFileBytes": 200_000,
    "maxUploadBytes": 1_500_000,
    "maxFiles": 400,
}
ROUTE_CHANGE = "import os\nimport requests\n\nPAYMENTS = requests.get(os.environ['PAYMENTS_URL'])\n"

# =============================================================================
# Module Overview
# =============================================================================
# Tests for `threatviz_hook.py` against real throwaway git repos and `StubApi`,
# a local `http.server` that records requests, so nothing touches the network.
# Most tests run the script as a subprocess, the way an agent would.


def _load_hook() -> ModuleType:
    """Import the hook script by path, since it is a standalone file rather than a package."""
    spec = importlib.util.spec_from_file_location("threatviz_hook", HOOK_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Dataclasses look their module up in `sys.modules` while the class body runs.
    sys.modules["threatviz_hook"] = module
    spec.loader.exec_module(module)
    return module


hook = _load_hook()


# =============================================================================
# Fixtures: a stub API and a throwaway repo
# =============================================================================


class StubApi:
    """What the stub answers, and every request it received."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.change_status = 202
        self.config_status = 200
        self.url = ""

    def posts(self) -> list[dict[str, Any]]:
        """The change posts received so far."""
        return [request for request in self.requests if request["method"] == "POST"]


class _Handler(BaseHTTPRequestHandler):
    """Answers the three routes the hook calls."""

    def _reply(self, status: int, body: object) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        stub: StubApi = self.server.stub  # type: ignore[attr-defined]
        stub.requests.append({"method": "GET", "path": self.path, "auth": self.headers.get("Authorization")})
        if self.path == "/api/config":
            self._reply(stub.config_status, {"app_name": "ThreatViz Defend", "file_policy": POLICY})
        elif self.path == "/api/agent/boards":
            if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                self._reply(401, {"error": {"code": "unauthorized", "message": "Bad token."}})
            else:
                self._reply(200, [{"id": BOARD, "title": "Shop", "status": "ready"}])
        else:
            self._reply(404, {"error": {"code": "not_found", "message": "No such route."}})

    def do_POST(self) -> None:
        stub: StubApi = self.server.stub  # type: ignore[attr-defined]
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        stub.requests.append(
            {"method": "POST", "path": self.path, "auth": self.headers.get("Authorization"), "body": body}
        )
        if stub.change_status == 202:
            self._reply(202, {"board_id": BOARD, "status": "mapping", "review_url": f"http://web/boards/{BOARD}"})
        else:
            self._reply(stub.change_status, {"error": {"code": "conflict", "message": "Board is busy."}})

    def log_message(self, format: str, *args: object) -> None:
        """Keep test output quiet."""


@pytest.fixture(autouse=True)
def isolated_git(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Keep the developer's git config, identity and ThreatViz env out of every test."""
    empty = tmp_path / "gitconfig"
    empty.write_text("")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("NO_PROXY", "*")
    for name in ("THREATVIZ_API_URL", "THREATVIZ_TOKEN", "THREATVIZ_BOARD_ID", hook.FOREGROUND_ENV):
        monkeypatch.delenv(name, raising=False)
    for name in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def api() -> Iterator[StubApi]:
    """A running stub API on a free local port."""
    stub = StubApi()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.stub = stub  # type: ignore[attr-defined]
    stub.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield stub
    server.shutdown()
    server.server_close()


def git(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    """Run git in `repo` and return stdout."""
    proc = subprocess.run(  # noqa: S603
        ["git", *args],  # noqa: S607
        cwd=repo,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", **(env or {})},
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout


def write(repo: Path, path: str, text: str) -> None:
    """Write a file inside the repo, creating folders."""
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repo with one commit holding an app, a readme and a committed secret file."""
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    write(root, "app.py", "print('hello')\n")
    write(root, "README.md", "# Shop\n")
    write(root, ".env.production", "DATABASE_HOST=committed-marker\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "init", env=IDENTITY)
    return root.resolve()


@pytest.fixture
def hook_env(api: StubApi) -> dict[str, str]:
    """Env that configures the hook for the stub API and keeps it in the foreground."""
    return {
        "THREATVIZ_API_URL": api.url,
        "THREATVIZ_TOKEN": TOKEN,
        "THREATVIZ_BOARD_ID": BOARD,
        hook.FOREGROUND_ENV: "1",
    }


def claude_payload(event: str, cwd: Path, prompt: str | None = None) -> dict[str, Any]:
    """A Claude Code hook payload."""
    payload: dict[str, Any] = {"hook_event_name": event, "cwd": str(cwd), "session_id": "s-1"}
    if prompt is not None:
        payload["prompt"] = prompt
    return payload


def cursor_payload(event: str, root: Path, prompt: str | None = None) -> dict[str, Any]:
    """A Cursor hook payload."""
    payload: dict[str, Any] = {
        "hook_event_name": event,
        "workspace_roots": [str(root)],
        "conversation_id": "c-1",
        "generation_id": "g-1",
    }
    if prompt is not None:
        payload["prompt"] = prompt
    return payload


def run_hook(payload: dict[str, Any], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[bytes]:
    """Run the script as an agent would, and check it exits 0 without writing to stdout."""
    proc = subprocess.run(  # noqa: S603
        [sys.executable, str(HOOK_PATH)],
        input=json.dumps(payload).encode(),
        cwd=cwd,
        env={**os.environ, **env},
        capture_output=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0
    assert proc.stdout == b""
    return proc


def ref(repo: Path, name: str) -> str | None:
    """The commit a ref points at, or `None`."""
    proc = subprocess.run(  # noqa: S603
        ["git", "rev-parse", "--verify", "--quiet", name],  # noqa: S607
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.stdout.strip() or None


def last_outcome(repo: Path) -> dict[str, str]:
    """The hook's record of its last run."""
    return json.loads((repo / ".git" / "threatviz" / "last.json").read_text())


# =============================================================================
# Payload parsing
# =============================================================================


def test_parses_claude_code_payloads(tmp_path: Path) -> None:
    prompt = hook.parse_event(claude_payload("UserPromptSubmit", tmp_path, "add a payments route"))
    stop = hook.parse_event(claude_payload("Stop", tmp_path))

    assert (prompt.kind, prompt.agent, prompt.cwd, prompt.prompt) == (
        "prompt",
        "Claude Code",
        tmp_path,
        "add a payments route",
    )
    assert (stop.kind, stop.agent, stop.session) == ("stop", "Claude Code", "s-1")


def test_parses_cursor_payloads(tmp_path: Path) -> None:
    prompt = hook.parse_event(cursor_payload("beforeSubmitPrompt", tmp_path, "add a queue"))
    stop = hook.parse_event(cursor_payload("stop", tmp_path))

    assert (prompt.kind, prompt.agent, prompt.cwd, prompt.prompt) == ("prompt", "Cursor", tmp_path, "add a queue")
    assert (stop.kind, stop.agent, stop.session) == ("stop", "Cursor", "c-1")


def test_cursor_running_claude_code_hooks_is_labelled_cursor(tmp_path: Path) -> None:
    payload = {**cursor_payload("stop", tmp_path), "hook_event_name": "Stop"}

    assert hook.parse_event(payload).agent == "Cursor"


@pytest.mark.parametrize(
    "payload",
    [None, [], "Stop", {}, {"hook_event_name": "PreToolUse", "cwd": "/"}, {"hook_event_name": 3}],
)
def test_ignores_other_events_and_malformed_payloads(payload: object) -> None:
    assert hook.parse_event(payload) is None


def test_refuses_plain_http_to_a_remote_host() -> None:
    with pytest.raises(ValueError, match="https"):
        hook.normalize_api_url("http://api.example.com")
    assert hook.normalize_api_url("https://api.example.com/") == "https://api.example.com"
    assert hook.normalize_api_url("http://localhost:8000") == "http://localhost:8000"


# =============================================================================
# Prompts
# =============================================================================


def test_prompts_are_bounded_and_masked(repo: Path, hook_env: dict[str, str], api: StubApi) -> None:
    for number in range(7):
        run_hook(claude_payload("UserPromptSubmit", repo, f"prompt {number}"), repo, hook_env)
    run_hook(cursor_payload("beforeSubmitPrompt", repo, "use api_key=abcd1234efgh5678 for the call"), repo, hook_env)

    stored = json.loads((repo / ".git" / "threatviz" / "prompts.json").read_text())

    assert [item["prompt"] for item in stored] == [
        "prompt 3",
        "prompt 4",
        "prompt 5",
        "prompt 6",
        "use api_key=[redacted] for the call",
    ]
    assert api.requests == []


# =============================================================================
# Snapshots and what gets posted
# =============================================================================


def test_snapshot_leaves_index_status_and_branch_alone(repo: Path, hook_env: dict[str, str], api: StubApi) -> None:
    write(repo, "app.py", "print('staged')\n")
    git(repo, "add", "app.py")
    write(repo, "app.py", ROUTE_CHANGE)
    write(repo, "worker.py", "import redis\n")
    status_before = git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    index = repo / ".git" / "index"
    index_before = hashlib.sha256(index.read_bytes()).hexdigest()
    head_before = ref(repo, "HEAD")

    run_hook(claude_payload("Stop", repo), repo, hook_env)

    assert hashlib.sha256(index.read_bytes()).hexdigest() == index_before
    assert git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all") == status_before
    assert ref(repo, "HEAD") == head_before
    assert git(repo, "symbolic-ref", "HEAD").strip() == "refs/heads/main"
    assert git(repo, "stash", "list") == ""
    assert ref(repo, hook.PENDING_REF) is not None
    assert len(api.posts()) == 1


def test_secret_files_never_leave_the_machine(repo: Path, hook_env: dict[str, str], api: StubApi) -> None:
    write(repo, ".env", "PAYMENTS_HOST=untracked-marker\n")
    write(repo, ".env.production", "DATABASE_HOST=changed-marker\n")
    write(repo, "certs/server.pem", "pem-marker\n")
    write(repo, "config/secrets.yaml", "db: yaml-marker\n")
    write(repo, "node_modules/lib/index.js", "vendored-marker\n")
    write(repo, "app.py", ROUTE_CHANGE + 'API_KEY = "inline-value-12345678"\n')

    run_hook(cursor_payload("stop", repo), repo, hook_env)

    [post] = api.posts()
    body = post["body"]
    posted = json.dumps(body)
    # Markers are plain values the masking regexes leave alone, so only the file filter keeps them out.
    for marker in ("committed-marker", "untracked-marker", "changed-marker", "pem-marker", "yaml-marker", "vendored"):
        assert marker not in posted
    assert "inline-value-12345678" not in posted
    assert body["files"] == ["app.py"]
    assert body["agent"] == "Cursor"
    assert post["auth"] == f"Bearer {TOKEN}"
    snapshot_files = git(repo, "ls-tree", "-r", "--name-only", hook.PENDING_REF).split()
    assert snapshot_files == ["README.md", "app.py"]


def test_diff_headers_ignore_user_diff_config(repo: Path, hook_env: dict[str, str], api: StubApi) -> None:
    git(repo, "config", "diff.noprefix", "true")
    git(repo, "config", "color.ui", "always")
    write(repo, "app.py", ROUTE_CHANGE)

    run_hook(claude_payload("Stop", repo), repo, hook_env)

    [post] = api.posts()
    assert post["body"]["diff"].startswith("diff --git a/app.py b/app.py\n")
    assert "\x1b[" not in post["body"]["diff"]


def test_falls_back_to_the_built_in_policy(repo: Path, hook_env: dict[str, str], api: StubApi) -> None:
    api.config_status = 500
    write(repo, ".env", "PAYMENTS_HOST=fallback-marker\n")
    write(repo, "app.py", ROUTE_CHANGE)

    run_hook(claude_payload("Stop", repo), repo, hook_env)

    [post] = api.posts()
    assert "fallback-marker" not in json.dumps(post["body"])
    assert "built in file policy" in last_outcome(repo)["detail"]


# =============================================================================
# When the base moves
# =============================================================================


@pytest.mark.parametrize("status", [409, 429, 500])
def test_base_only_advances_on_202(repo: Path, hook_env: dict[str, str], api: StubApi, status: int) -> None:
    run_hook(claude_payload("UserPromptSubmit", repo, "add a payments client"), repo, hook_env)
    write(repo, "app.py", ROUTE_CHANGE)
    api.change_status = status

    run_hook(claude_payload("Stop", repo), repo, hook_env)

    assert len(api.posts()) == 1
    assert ref(repo, hook.BASE_REF) is None
    assert last_outcome(repo)["outcome"] == "kept"

    api.change_status = 202
    write(repo, "jobs.py", "import celery\n")
    run_hook(claude_payload("Stop", repo), repo, hook_env)

    retry = api.posts()[1]["body"]
    assert retry["files"] == ["app.py", "jobs.py"]
    assert retry["summary"] == "add a payments client"
    assert ref(repo, hook.BASE_REF) == ref(repo, hook.PENDING_REF)
    assert json.loads((repo / ".git" / "threatviz" / "prompts.json").read_text()) == []

    run_hook(claude_payload("Stop", repo), repo, hook_env)

    assert len(api.posts()) == 2


def test_unreachable_api_keeps_the_base(repo: Path, hook_env: dict[str, str]) -> None:
    write(repo, "app.py", ROUTE_CHANGE)
    # Port 9 is discard; nothing listens there on a test machine, so the connection is refused.
    env = {**hook_env, "THREATVIZ_API_URL": "http://127.0.0.1:9"}

    run_hook(claude_payload("Stop", repo), repo, env)

    assert ref(repo, hook.BASE_REF) is None
    assert last_outcome(repo)["outcome"] == "error"


def test_non_architectural_changes_are_skipped(repo: Path, hook_env: dict[str, str], api: StubApi) -> None:
    write(repo, "README.md", "# Shop\n\nA small shop.\n")
    write(repo, "app.py", "print('hello there')\n")

    run_hook(claude_payload("Stop", repo), repo, hook_env)

    assert api.posts() == []
    assert last_outcome(repo)["outcome"] == "skipped"
    assert ref(repo, hook.BASE_REF) == ref(repo, hook.PENDING_REF)


def test_manifest_changes_count_as_architectural() -> None:
    assert hook.is_architectural(["web/package.json"], '+  "left-pad": "1.0.0"\n')
    assert hook.is_architectural(["deploy/Dockerfile"], "+RUN true\n")
    assert hook.is_architectural([".env.example"], "+FOO=\n")
    assert not hook.is_architectural(["src/view.css"], "+color: red;\n")


# =============================================================================
# Quiet by default
# =============================================================================


def test_missing_config_is_silent(repo: Path, api: StubApi) -> None:
    write(repo, "app.py", ROUTE_CHANGE)

    proc = run_hook(claude_payload("Stop", repo), repo, {hook.FOREGROUND_ENV: "1"})

    assert proc.stderr == b""
    assert api.requests == []
    assert ref(repo, hook.PENDING_REF) is None


def test_outside_a_repo_is_silent(tmp_path: Path, hook_env: dict[str, str], api: StubApi) -> None:
    proc = run_hook(claude_payload("Stop", tmp_path), tmp_path, hook_env)

    assert proc.stderr == b""
    assert api.requests == []


@pytest.mark.skipif(not hasattr(os, "fork"), reason="the hook only detaches on POSIX")
def test_stop_detaches_and_posts_in_the_background(repo: Path, hook_env: dict[str, str], api: StubApi) -> None:
    write(repo, "app.py", ROUTE_CHANGE)
    env = {key: value for key, value in hook_env.items() if key != hook.FOREGROUND_ENV}

    run_hook(claude_payload("Stop", repo), repo, env)
    deadline = time.monotonic() + 15
    while not api.posts() and time.monotonic() < deadline:
        time.sleep(0.05)

    assert len(api.posts()) == 1


# =============================================================================
# Commands for humans
# =============================================================================


def test_init_writes_config_and_takes_the_base(repo: Path, api: StubApi) -> None:
    write(repo, "app.py", ROUTE_CHANGE)
    env = {**os.environ, "THREATVIZ_TOKEN": TOKEN}

    proc = subprocess.run(  # noqa: S603
        [sys.executable, str(HOOK_PATH), "init", "--board", BOARD, "--api-url", api.url],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 0, proc.stderr
    assert json.loads((repo / hook.CONFIG_FILE).read_text()) == {"api_url": api.url, "board_id": BOARD}
    assert ref(repo, hook.BASE_REF) == ref(repo, hook.PENDING_REF)
    assert '"UserPromptSubmit"' in proc.stdout
    assert TOKEN not in (repo / hook.CONFIG_FILE).read_text()


def test_init_rejects_a_board_the_token_cannot_see(repo: Path, api: StubApi) -> None:
    proc = subprocess.run(  # noqa: S603
        [sys.executable, str(HOOK_PATH), "init", "--board", "other", "--api-url", api.url],
        cwd=repo,
        env={**os.environ, "THREATVIZ_TOKEN": TOKEN},
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode != 0
    assert "not one of yours" in proc.stderr
    assert not (repo / hook.CONFIG_FILE).exists()


def test_print_config_for_cursor(repo: Path) -> None:
    snippet = hook.settings_snippet(hook.find_repo(repo), "cursor")

    assert snippet["version"] == 1
    assert set(snippet["hooks"]) == {"beforeSubmitPrompt", "stop"}
