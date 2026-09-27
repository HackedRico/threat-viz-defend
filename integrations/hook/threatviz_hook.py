#!/usr/bin/env python3
"""Keep a ThreatViz Defend board current from a coding agent's turns, as a Claude Code or Cursor hook."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

AGENT_CLAUDE = "Claude Code"
AGENT_CURSOR = "Cursor"
# Per-worktree refs (git 2.25+): shared ones would let one worktree's snapshot become another's base.
BASE_REF = "refs/worktree/threatviz/base"
PENDING_REF = "refs/worktree/threatviz/pending"
CONFIG_FILE = ".threatviz.json"
# Lives in the hook's folder under the git dir, so it is never committed and a pull request cannot change it.
ORIGIN_FILE = "config.json"
MAX_PROMPTS = 5
# Five prompts at this length plus separators stay under the API's 4000 character summary cap.
MAX_PROMPT_CHARS = 750
MAX_SUMMARY_CHARS = 4_000
MAX_DIFF_CHARS = 180_000
MAX_FILES = 500
POLICY_TIMEOUT_SECS = 3.0
API_TIMEOUT_SECS = 30.0
LOCK_STALE_SECS = 300
USER_AGENT = "threatviz-hook/1"
TRUNCATED = "\n[diff truncated]\n"
FOREGROUND_ENV = "THREATVIZ_HOOK_FOREGROUND"

# =============================================================================
# Module Overview
# =============================================================================
# One standard library file that Claude Code or Cursor runs on every prompt and
# every stop. `run_hook` saves prompts, then on stop `report_turn` snapshots the
# worktree into a private ref, diffs it against the last reported `BASE_REF`,
# and posts architectural changes to the board. `init`, `status` and
# `print-config` are for humans setting it up.

# Commits made by the hook must not depend on the user's git identity or signing setup.
_IDENTITY = {
    "GIT_AUTHOR_NAME": "ThreatViz hook",
    "GIT_AUTHOR_EMAIL": "hook@threatviz.invalid",
    "GIT_COMMITTER_NAME": "ThreatViz hook",
    "GIT_COMMITTER_EMAIL": "hook@threatviz.invalid",
}
_PROMPT_EVENTS = {"UserPromptSubmit": AGENT_CLAUDE, "beforeSubmitPrompt": AGENT_CURSOR}
_STOP_EVENTS = {"Stop": AGENT_CLAUDE, "stop": AGENT_CURSOR}
# Cursor can also run hooks written for Claude Code; these keys only appear in Cursor's payloads.
_CURSOR_KEYS = ("conversation_id", "workspace_roots", "cursor_version")
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


# =============================================================================
# File policy: which files never leave the machine
# =============================================================================


@dataclass(frozen=True)
class FilePolicy:
    """The skip lists from the API's `file_policy`, with lowercase names and extensions."""

    secret_names: frozenset[str]
    secret_extensions: frozenset[str]
    safe_env_suffixes: frozenset[str]
    ignored_dirs: frozenset[str]
    lockfiles: frozenset[str]
    binary_extensions: frozenset[str]
    max_file_bytes: int

    @classmethod
    def from_api(cls, data: object) -> FilePolicy:
        """Build a policy from the `file_policy` object of `GET /api/config`."""
        if not isinstance(data, dict):
            raise ValueError("file_policy must be an object")

        def names(key: str) -> frozenset[str]:
            value = data.get(key)
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                raise ValueError(f"file_policy.{key} must be a list of strings")
            return frozenset(item.lower() for item in value)

        max_bytes = data.get("maxFileBytes")
        if not isinstance(max_bytes, int) or max_bytes <= 0:
            raise ValueError("file_policy.maxFileBytes must be a positive integer")
        return cls(
            secret_names=names("secretNames"),
            secret_extensions=names("secretExtensions"),
            safe_env_suffixes=names("safeEnvSuffixes"),
            ignored_dirs=names("ignoredDirs"),
            lockfiles=names("lockfiles"),
            binary_extensions=names("binaryExtensions"),
            max_file_bytes=max_bytes,
        )

    def merged(self, other: FilePolicy) -> FilePolicy:
        """Skip everything either policy skips, with the smaller size cap."""
        return FilePolicy(
            secret_names=self.secret_names | other.secret_names,
            secret_extensions=self.secret_extensions | other.secret_extensions,
            safe_env_suffixes=self.safe_env_suffixes & other.safe_env_suffixes,
            ignored_dirs=self.ignored_dirs | other.ignored_dirs,
            lockfiles=self.lockfiles | other.lockfiles,
            binary_extensions=self.binary_extensions | other.binary_extensions,
            max_file_bytes=min(self.max_file_bytes, other.max_file_bytes),
        )


# A small copy of the server's lists, used as a floor and when the API cannot be reached. The secret
# lists go further than the server's (`.envrc`, `kubeconfig`, `ppk`, `gpg`, `asc`), since the hook
# decides what leaves the developer's machine.
BUILTIN_POLICY = FilePolicy(
    secret_names=frozenset(
        {".env", ".envrc", ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".htpasswd", ".pgpass", ".dockercfg",
         "credentials", "kubeconfig", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"}
    ),
    secret_extensions=frozenset(
        {"pem", "key", "p12", "pfx", "jks", "keystore", "tfstate", "tfvars", "ovpn", "kdbx", "ppk", "gpg", "asc"}
    ),
    safe_env_suffixes=frozenset({"example", "sample", "template", "dist", "defaults"}),
    ignored_dirs=frozenset(
        {".git", "node_modules", "vendor", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".terraform"}
    ),
    lockfiles=frozenset(
        {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "poetry.lock", "uv.lock", "cargo.lock",
         "go.sum", "composer.lock", "gemfile.lock", "pipfile.lock"}
    ),
    binary_extensions=frozenset(
        {"png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tar", "jar", "exe", "dll", "so", "dylib",
         "pyc", "wasm", "sqlite", "db", "woff", "woff2", "mp3", "mp4", "lock"}
    ),
    max_file_bytes=200_000,
)  # fmt: skip

# The server also treats config files named like secrets as credential stores. Its `file_policy` publishes the same
# lists (`secretWordsPattern`, `configExtensions`, `secretPaths`), but the hook keeps its own copies, so a change to
# them in `api/app/domain/masking.py` must be made here too.
_SECRET_WORDS = re.compile(r"secret|credential|service-?account")
_CONFIG_EXTENSIONS = frozenset({"json", "yaml", "yml", "toml", "txt", "ini", "xml", "cfg", "conf"})
# Credential stores whose file name is too generic to skip on its own, keyed by their parent folder.
_SECRET_PATHS = frozenset({(".kube", "config"), (".docker", "config.json")})


def skip_reason(path: str, policy: FilePolicy) -> str | None:
    """Say why a repo path is never sent, or return `None` when it may be sent."""
    parts = [part for part in PurePosixPath(path.replace("\\", "/")).parts if part not in ("", "/", ".")]
    if not parts:
        return "empty path"
    name = parts[-1].lower()
    if any(part.lower() in policy.ignored_dirs for part in parts[:-1]):
        return "vendored or generated folder"
    if is_secret_file(name, policy) or tuple(part.lower() for part in parts[-2:]) in _SECRET_PATHS:
        return "may hold credentials"
    if name in policy.lockfiles:
        return "dependency lockfile"
    if _extension(name) in policy.binary_extensions or name.endswith(".min.js"):
        return "binary or generated file"
    return None


def is_secret_file(name: str, policy: FilePolicy) -> bool:
    """True for file names that usually hold credentials: env files, private keys, credential stores."""
    name = name.lower()
    if name == ".env" or (name.startswith(".env.") and name[5:] not in policy.safe_env_suffixes):
        return True
    if name in policy.secret_names or _extension(name) in policy.secret_extensions:
        return True
    return bool(_SECRET_WORDS.search(name)) and _extension(name) in _CONFIG_EXTENSIONS


def _extension(name: str) -> str:
    """The lowercase extension of a file name, or `''` when it has none."""
    return name.rsplit(".", 1)[-1].lower() if "." in name.strip(".") else ""


# =============================================================================
# Masking credential-shaped values before anything is posted
# =============================================================================

# The server masks again on arrival; masking here too keeps values off the wire, so the hook
# masks at least what the server does. Every pattern is linear: no nested quantifiers, and
# repeats before more pattern are bounded.
_PRIVATE_KEY_BEGIN = re.compile(r"-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----")
_PRIVATE_KEY_END = re.compile(r"-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----")
_END_PREFIX = "-----END "
# How far past a BEGIN marker its END may be; a 4096 bit RSA key is about 3300 characters.
PRIVATE_KEY_SPAN = 12_000
PRIVATE_KEY_REMOVED = "[private key removed]"
# Matches names like `DB_PASSWORD` or `apiToken` that hold a credential.
_CREDENTIAL_NAME = (
    r"[A-Za-z0-9_.-]{0,40}?(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|credential)"
    r"[A-Za-z0-9_.-]{0,40}"
)
_ASSIGNMENT = re.compile(
    r"\b(" + _CREDENTIAL_NAME + r")([\"']?\s{0,3}[:=]\s{0,3}[\"']?)(?!\[)([^\s\"'`,;#]{8,})",
    re.IGNORECASE,
)
# Quoted values can hold spaces or be short, which `_ASSIGNMENT` leaves alone: `DB_PASSWORD="Summer 2024!"`.
_QUOTED_ASSIGNMENT = re.compile(
    r"\b(" + _CREDENTIAL_NAME + r"[\"']?\s{0,3}[:=]\s{0,3})(?:\"[^\"\n]{1,200}\"|'[^'\n]{1,200}')",
    re.IGNORECASE,
)
_URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@]{1,64}:)([^\s@/]{1,256})(@)", re.IGNORECASE)
_BEARER = re.compile(r"\b(Bearer\s{1,3})([A-Za-z0-9._~+/=-]{16,})")
# Labels that always precede a base64 credential: basic auth headers, kubeconfig client
# certificates and keys, Docker registry logins and Azure storage keys.
_LABELLED_BASE64 = re.compile(
    r"(\bAuthorization[\"'\]\s,:=]{1,8}Basic\s{1,3}"
    r"|\bclient-(?:key|certificate)-data\s{0,3}:\s{0,3}[\"']?"
    r"|\"auth\"\s{0,3}:\s{0,3}\""
    r"|\bAccountKey\s{0,3}=\s{0,3})"
    r"[A-Za-z0-9+/]{8,}={0,2}",
    re.IGNORECASE,
)
_WEBHOOK = re.compile(r"(hooks\.slack\.com/services/|discord(?:app)?\.com/api/webhooks/)[A-Za-z0-9/_-]{16,}")
_KNOWN_KEYS = re.compile(
    r"\b(?:"
    r"sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}"
    r"|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}"
    r"|sk_[A-Za-z0-9]{32,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|AIza[0-9A-Za-z_-]{35}"
    r"|gh[pousr]_[A-Za-z0-9]{36,}"
    r"|github_pat_[A-Za-z0-9_]{40,}"
    r"|glpat-[A-Za-z0-9_-]{20,}"
    r"|npm_[A-Za-z0-9]{36,}"
    r"|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|SG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,}"
    r"|tvd_[A-Za-z0-9_-]{20,}"
    r"|eyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,20000}\.[A-Za-z0-9_-]{10,}"
    r")"
)
REDACTED = "[redacted]"


def mask_secrets(text: str) -> str:
    """Replace private keys, credential assignments, URL passwords, auth headers, webhooks and known key formats."""
    out = remove_private_keys(text)
    out = _QUOTED_ASSIGNMENT.sub(rf'\1"{REDACTED}"', out)
    out = _ASSIGNMENT.sub(rf"\1\2{REDACTED}", out)
    out = _URL_PASSWORD.sub(rf"\1{REDACTED}\3", out)
    out = _BEARER.sub(rf"\1{REDACTED}", out)
    out = _LABELLED_BASE64.sub(rf"\1{REDACTED}", out)
    out = _WEBHOOK.sub(rf"\1{REDACTED}", out)
    return _KNOWN_KEYS.sub(REDACTED, out)


def remove_private_keys(text: str) -> str:
    """Replace each private key block, or a BEGIN line with no END in range, with `PRIVATE_KEY_REMOVED`."""
    pieces: list[str] = []
    copied = 0
    # The next END marker and line break are found once and reused until a BEGIN passes them. Both
    # lookups only move forward, so text full of BEGIN markers costs one pass instead of one per marker.
    end: re.Match[str] | None = None
    no_more_ends = False
    line_end = -1
    for begin in _PRIVATE_KEY_BEGIN.finditer(text):
        if begin.start() < copied:
            # Inside a block or line that was already removed.
            continue
        if not no_more_ends and (end is None or end.start() < begin.end()):
            end = _next_private_key_end(text, begin.end())
            no_more_ends = end is None
        if end is not None and end.start() - begin.end() <= PRIVATE_KEY_SPAN:
            stop = end.end()
        else:
            if line_end < begin.end():
                newline = text.find("\n", begin.end())
                line_end = newline if newline >= 0 else len(text)
            stop = line_end
        pieces += [text[copied : begin.start()], PRIVATE_KEY_REMOVED]
        copied = stop
    pieces.append(text[copied:])
    return "".join(pieces)


def _next_private_key_end(text: str, start: int) -> re.Match[str] | None:
    """The first private key END marker at or after `start`, skipping other END lines such as certificates."""
    at = text.find(_END_PREFIX, start)
    while at >= 0:
        match = _PRIVATE_KEY_END.match(text, at)
        if match:
            return match
        at = text.find(_END_PREFIX, at + 1)
    return None


# =============================================================================
# Is this change worth redrawing the map for
# =============================================================================

# Deliberately generous: a false positive costs one redraw, a false negative leaves the map stale.
_ARCH_PATH = re.compile(
    r"(?:^|/)(?:"
    r"dockerfile[^/]*|[^/]*\.dockerfile|(?:docker-)?compose[^/]*\.ya?ml|procfile"
    r"|package\.json|pyproject\.toml|requirements[^/]*\.(?:txt|in)|pipfile|setup\.(?:py|cfg)|go\.mod|cargo\.toml"
    r"|gemfile|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|[^/]*\.csproj|mix\.exs|deno\.jsonc?"
    r"|[^/]*\.(?:tf|hcl|bicep|proto|graphql|prisma)|serverless\.ya?ml|chart\.yaml|values[^/]*\.ya?ml"
    r"|(?:[^/]*\.)?env\.(?:example|sample|template|dist|defaults)|\.env\.(?:example|sample|template|dist|defaults)"
    r"|fly\.toml|vercel\.json|netlify\.toml|wrangler\.toml|app\.ya?ml|nginx[^/]*\.conf|openapi[^/]*|swagger[^/]*"
    r")$"
    r"|(?:^|/)(?:\.github/workflows|k8s|kubernetes|helm|terraform|infra|deploy|migrations)/",
    re.IGNORECASE,
)
_ARCH_WORDS = re.compile(
    r"fetch\(|axios|\brequests\.|httpx|urllib|aiohttp|http\.client|httpclient|net/http|\bgrpc|websocket|graphql"
    r"|webhook|@app\.|@router\.|\b(?:app|router|server)\.(?:get|post|put|patch|delete|use|route)\(|apirouter"
    r"|fastapi|flask|express\(|django|urlpatterns|@(?:get|post|put|delete|request)mapping"
    r"|process\.env|os\.environ|getenv\(|import\.meta\.env|\benv\[|\bENV\["
    r"|postgres|mysql|sqlite|mongo|redis|dynamodb|firestore|supabase|prisma|sqlalchemy|sequelize|typeorm|knex"
    r"|drizzle|psycopg|create\s+table"
    r"|kafka|rabbitmq|amqp|\bsqs\b|\bsns\b|pubsub|celery|bullmq|\bnats\b"
    r"|openai|anthropic|gemini|langchain|llamaindex|ollama|bedrock|huggingface|mistral|cohere|elevenlabs"
    r"|auth|jwt|oauth|saml|session|cookie|passw|bcrypt|argon2|csrf|cors|api[_-]?key|secret|token"
    r"|\bs3\b|bucket|subprocess|\bexec\(|\beval\(|upload",
    re.IGNORECASE,
)


def is_architectural(files: Sequence[str], diff: str) -> bool:
    """True when the change touches a manifest, infra file or env example, or adds lines naming a boundary."""
    if any(_ARCH_PATH.search(path) for path in files):
        return True
    added = (line for line in diff.splitlines() if line.startswith("+") and not line.startswith("+++"))
    return any(_ARCH_WORDS.search(line) for line in added)


# =============================================================================
# Hook payloads from Claude Code and Cursor
# =============================================================================


@dataclass(frozen=True)
class HookEvent:
    """One hook call: a prompt being submitted, or the agent stopping at the end of a turn."""

    kind: str  # "prompt" or "stop"
    agent: str
    cwd: Path
    prompt: str
    session: str


def parse_event(payload: object, fallback_cwd: Path | None = None) -> HookEvent | None:
    """Read a Claude Code or Cursor hook payload, or return `None` for events this hook ignores."""
    if not isinstance(payload, dict):
        return None
    name = payload.get("hook_event_name")
    if not isinstance(name, str):
        return None
    if name in _PROMPT_EVENTS:
        kind, agent = "prompt", _PROMPT_EVENTS[name]
    elif name in _STOP_EVENTS:
        kind, agent = "stop", _STOP_EVENTS[name]
    else:
        return None
    if any(key in payload for key in _CURSOR_KEYS):
        agent = AGENT_CURSOR
    roots = payload.get("workspace_roots")
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = roots[0] if isinstance(roots, list) and roots and isinstance(roots[0], str) else None
    prompt = payload.get("prompt")
    session = payload.get("session_id") or payload.get("conversation_id")
    return HookEvent(
        kind=kind,
        agent=agent,
        cwd=Path(cwd) if cwd else (fallback_cwd or Path.cwd()),
        prompt=prompt if isinstance(prompt, str) else "",
        session=session if isinstance(session, str) else "",
    )


# =============================================================================
# Configuration
# =============================================================================


@dataclass(frozen=True)
class Config:
    """Where to post and as whom. The token only comes from the environment, the origin never from a committed file."""

    api_url: str
    token: str
    board_id: str


class UntrustedOriginError(ValueError):
    """`.threatviz.json` names an API origin other than the trusted one, so nothing is sent anywhere."""


def normalize_api_url(url: str) -> str:
    """Return the API origin without a trailing slash, refusing plain http to anything but this machine."""
    parsed = urllib.parse.urlsplit(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"API url must look like https://api.example.com, got {url!r}")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("API url must not carry credentials, a query or a fragment")
    host = parsed.hostname.lower()
    if parsed.scheme == "http" and host not in _LOCAL_HOSTS and not host.endswith(".localhost"):
        raise ValueError("API url must use https, since the token travels with every request")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def read_config_file(root: Path) -> dict[str, str]:
    """The string values of `.threatviz.json` in the repo root, or `{}` when it is missing or unreadable."""
    try:
        data = json.loads((root / CONFIG_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {key: value for key, value in data.items() if isinstance(value, str)}


def trusted_api_url(repo: Repo, env: Mapping[str, str]) -> str:
    """`THREATVIZ_API_URL`, else the origin `init` verified and kept under the git dir, else `''`."""
    recorded = _read_json(repo.state_dir / ORIGIN_FILE)
    kept = recorded.get("api_url") if isinstance(recorded, dict) else None
    return env.get("THREATVIZ_API_URL") or (kept if isinstance(kept, str) else "")


def check_committed_origin(committed: Mapping[str, str], origin: str) -> None:
    """Raise `UntrustedOriginError` when `.threatviz.json` names an `api_url` other than the trusted `origin`."""
    claimed = committed.get("api_url")
    if claimed is None:
        return
    try:
        same = normalize_api_url(claimed) == origin
    except ValueError:
        same = False
    if not same:
        # Anyone can change a committed file in a pull request; a different origin there means the token would leak.
        raise UntrustedOriginError(
            f"{CONFIG_FILE} names api_url {claimed[:200]!r}, not the trusted {origin}; refusing to post. "
            f"Remove `api_url` from {CONFIG_FILE}."
        )


def load_config(repo: Repo, env: Mapping[str, str]) -> Config | None:
    """Build the config from the environment, the kept origin and the board in `.threatviz.json`, or `None`."""
    committed = read_config_file(repo.root)
    api_url = trusted_api_url(repo, env)
    board_id = env.get("THREATVIZ_BOARD_ID") or committed.get("board_id", "")
    token = env.get("THREATVIZ_TOKEN", "")
    if not (api_url and board_id and token):
        return None
    origin = normalize_api_url(api_url)
    check_committed_origin(committed, origin)
    return Config(api_url=origin, token=token, board_id=board_id)


# =============================================================================
# Git plumbing: every call leaves the user's index, branch and worktree alone
# =============================================================================


class GitError(RuntimeError):
    """A git command failed."""


@dataclass(frozen=True)
class Repo:
    """A worktree root and its own git dir, where the hook keeps prompts, the lock and the last outcome."""

    root: Path
    git_dir: Path

    @property
    def state_dir(self) -> Path:
        """The hook's private folder inside the git dir."""
        return self.git_dir / "threatviz"


def _git(args: Sequence[str], cwd: Path, *, env: Mapping[str, str] | None = None, stdin: bytes | None = None) -> bytes:
    """Run git and return its stdout, raising `GitError` with git's last stderr line on failure."""
    # No optional locks, so a read never refreshes the user's index; no prompts, so git never waits on a tty.
    full_env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", **(env or {})}
    # `git` is resolved from PATH on purpose: the hook runs wherever the agent runs, and args are never shell parsed.
    proc = subprocess.run(  # noqa: S603
        ["git", *args],  # noqa: S607
        cwd=cwd,
        env=full_env,
        input=stdin,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise GitError(f"`git {args[0]}` failed: {lines[-1] if lines else f'exit {proc.returncode}'}")
    return proc.stdout


def _git_text(
    args: Sequence[str], cwd: Path, *, env: Mapping[str, str] | None = None, stdin: bytes | None = None
) -> str:
    """Run git and return its stdout as stripped text."""
    return _git(args, cwd, env=env, stdin=stdin).decode("utf-8", "replace").strip()


def _nul_paths(raw: bytes) -> list[str]:
    """Split `-z` output into paths, keeping undecodable bytes round trippable."""
    return [os.fsdecode(item) for item in raw.split(b"\0") if item]


def find_repo(cwd: Path) -> Repo | None:
    """The repo that contains `cwd`, or `None` outside a worktree."""
    try:
        root, git_dir = _git_text(["rev-parse", "--show-toplevel", "--absolute-git-dir"], cwd).splitlines()
    except (GitError, OSError, ValueError):
        return None
    return Repo(root=Path(root), git_dir=Path(git_dir))


def _ref_commit(repo: Repo, ref: str) -> str | None:
    """The commit a ref points at, or `None` when it does not exist."""
    try:
        return _git_text(["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], repo.root) or None
    except GitError:
        return None


def resolve_base(repo: Repo) -> str:
    """What the next diff starts from: the last reported snapshot, else `HEAD`, else the empty tree."""
    for ref in (BASE_REF, "HEAD"):
        commit = _ref_commit(repo, ref)
        if commit:
            return commit
    # `mktree` with no input prints the empty tree id in whichever hash format the repo uses.
    return _git_text(["mktree"], repo.root, stdin=b"")


def take_snapshot(repo: Repo, policy: FilePolicy) -> str:
    """Commit the worktree as it is now, minus skipped files, to `PENDING_REF` and return the commit id."""
    real_index = repo.root / _git_text(["rev-parse", "--git-path", "index"], repo.root)
    # Excluding vendored folders up front keeps `git add` from hashing them on every turn.
    ignored = [f":(exclude,glob,icase)**/{name}/**" for name in sorted(policy.ignored_dirs)]
    with tempfile.TemporaryDirectory(prefix="threatviz-") as tmp:
        index = Path(tmp) / "index"
        # Starting from a copy of the real index keeps git's stat cache, so unchanged files are not rehashed.
        if real_index.is_file():
            shutil.copyfile(real_index, index)
        env = {"GIT_INDEX_FILE": str(index)}
        # Only paths that may be sent are added: `git add` writes each file it sees into the object store,
        # and a skipped file such as an untracked `.env` must never be hashed there.
        changed = _nul_paths(
            _git(["ls-files", "-z", "--others", "--modified", "--deleted", "--exclude-standard", "--", ".", *ignored],
                 repo.root, env=env)
        )  # fmt: skip
        wanted = sorted({path for path in changed if not skip_reason(path, policy)})
        if wanted:
            _git(
                ["--literal-pathspecs", "add", "-A", "--ignore-errors",
                 "--pathspec-from-file=-", "--pathspec-file-nul"],
                repo.root,
                env=env,
                stdin=b"\0".join(os.fsencode(path) for path in wanted),
            )  # fmt: skip
        tracked = _nul_paths(_git(["ls-files", "-z", "--cached"], repo.root, env=env))
        left_out = [path for path in tracked if skip_reason(path, policy)]
        if left_out:
            _git(
                ["--literal-pathspecs", "rm", "--cached", "-q", "-f", "--ignore-unmatch",
                 "--pathspec-from-file=-", "--pathspec-file-nul"],
                repo.root,
                env=env,
                stdin=b"\0".join(os.fsencode(path) for path in left_out),
            )  # fmt: skip
        tree = _git_text(["write-tree"], repo.root, env=env)
    commit = _git_text(["commit-tree", "--no-gpg-sign", tree, "-m", "ThreatViz snapshot"], repo.root, env=_IDENTITY)
    _git(["update-ref", PENDING_REF, commit], repo.root)
    return commit


def changed_files(repo: Repo, base: str, snapshot: str, policy: FilePolicy) -> list[str]:
    """Paths that differ between two snapshots and may be sent, capped at `MAX_FILES`."""
    raw = _git(["diff", "--name-only", "-z", "--no-renames", base, snapshot], repo.root)
    # The base can be `HEAD`, which may hold a committed secret file; filtering both sides keeps it out.
    kept = [path for path in _nul_paths(raw) if not skip_reason(path, policy) and _small_enough(repo, path, policy)]
    return kept[:MAX_FILES]


def _small_enough(repo: Repo, path: str, policy: FilePolicy) -> bool:
    """True unless the file on disk is over the policy's size cap. Deleted files count as small."""
    try:
        return (repo.root / path).lstat().st_size <= policy.max_file_bytes
    except OSError:
        return True


def build_diff(repo: Repo, base: str, snapshot: str, files: Sequence[str]) -> str:
    """The unified diff for `files` only, masked and capped at `MAX_DIFF_CHARS`."""
    if not files:
        return ""
    # Fixed prefixes override `diff.noprefix`, since the server splits the diff on `diff --git a/... b/...`.
    raw = _git(
        ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
         "--src-prefix=a/", "--dst-prefix=b/", base, snapshot, "--", *files],
        repo.root,
    )  # fmt: skip
    return cap_diff(mask_secrets(raw.decode("utf-8", "replace")))


def cap_diff(diff: str, limit: int = MAX_DIFF_CHARS) -> str:
    """Cut a diff at a line break so it fits in `limit` characters, and say that it was cut."""
    if len(diff) <= limit:
        return diff
    cut = diff.rfind("\n", 0, limit - len(TRUNCATED))
    return diff[: cut if cut > 0 else limit - len(TRUNCATED)] + TRUNCATED


# =============================================================================
# Local state under the git dir: prompts, the run lock and the last outcome
# =============================================================================


def _write_json(path: Path, data: object) -> None:
    """Write JSON atomically, so a reader never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name, dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    os.replace(tmp, path)


def _read_json(path: Path) -> object:
    """Parsed JSON from `path`, or `None` when it is missing or unreadable."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def load_prompts(repo: Repo) -> list[dict[str, str]]:
    """Saved prompts, oldest first, each as `{"id", "prompt"}`."""
    data = _read_json(repo.state_dir / "prompts.json")
    if not isinstance(data, list):
        return []
    return [
        item
        for item in data
        if isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("prompt"), str)
    ]


def append_prompt(repo: Repo, prompt: str) -> None:
    """Save a masked, shortened prompt, keeping only the last `MAX_PROMPTS`."""
    text = " ".join(mask_secrets(prompt).split())[:MAX_PROMPT_CHARS]
    if not text:
        return
    prompts = [*load_prompts(repo), {"id": uuid.uuid4().hex, "prompt": text}]
    _write_json(repo.state_dir / "prompts.json", prompts[-MAX_PROMPTS:])


def drop_prompts(repo: Repo, ids: Sequence[str]) -> None:
    """Forget the prompts that were posted, keeping any that arrived during the post."""
    posted = set(ids)
    _write_json(repo.state_dir / "prompts.json", [item for item in load_prompts(repo) if item["id"] not in posted])


def record_outcome(repo: Repo, outcome: str, detail: str = "") -> None:
    """Remember the last run's outcome for `status`, since a background run has nowhere else to say it."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with contextlib.suppress(OSError):
        _write_json(repo.state_dir / "last.json", {"at": stamp, "outcome": outcome, "detail": detail})


@contextlib.contextmanager
def run_lock(repo: Repo) -> Iterator[bool]:
    """Hold the run lock for the block, yielding `False` when another live run holds it."""
    path = repo.state_dir / "lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    for _attempt in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            # A run killed mid way leaves its lock behind; past the stale age it cannot still be working.
            with contextlib.suppress(OSError):
                if time.time() - path.stat().st_mtime > LOCK_STALE_SECS:
                    path.unlink()
                    continue
            yield False
            return
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        try:
            yield True
        finally:
            with contextlib.suppress(OSError):
                path.unlink()
        return
    yield False


# =============================================================================
# The API
# =============================================================================


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse redirects, so the bearer token is never replayed to another host."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        """Return `None`, which makes urllib raise the 3xx as an `HTTPError`."""
        return None


def _opener() -> urllib.request.OpenerDirector:
    """A urllib opener that refuses redirects."""
    # Built per call, not at import: its proxy lookup starts native threads on macOS, and the hook forks later.
    return urllib.request.build_opener(_NoRedirect)


@dataclass(frozen=True)
class Reply:
    """An HTTP status and the parsed JSON body, or `None` when the body was not JSON."""

    status: int
    body: object


def call_api(method: str, url: str, *, token: str | None, body: object = None, timeout: float) -> Reply:
    """Send one JSON request and return the reply. Network failures raise `OSError`."""
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    # The scheme is checked in `normalize_api_url`, so this never opens a file or ftp url.
    request = urllib.request.Request(url, data=data, headers=headers, method=method)  # noqa: S310
    try:
        with _opener().open(request, timeout=timeout) as response:
            status, raw = response.status, response.read(2_000_000)
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read(2_000_000)
    try:
        return Reply(status, json.loads(raw) if raw else None)
    except ValueError:
        return Reply(status, None)


def fetch_policy(api_url: str) -> tuple[FilePolicy, str]:
    """The server's file policy merged with the built in one, and a note when the fallback was used."""
    try:
        reply = call_api("GET", f"{api_url}/api/config", token=None, timeout=POLICY_TIMEOUT_SECS)
        if reply.status != 200 or not isinstance(reply.body, dict):
            raise ValueError(f"GET /api/config answered {reply.status}")
        return FilePolicy.from_api(reply.body.get("file_policy")).merged(BUILTIN_POLICY), ""
    except (OSError, ValueError) as exc:
        return BUILTIN_POLICY, f"used the built in file policy ({exc})"


def _error_message(reply: Reply) -> str:
    """The API's error message, or the bare status."""
    body = reply.body
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        message = body["error"].get("message")
        if isinstance(message, str):
            return message
    return f"HTTP {reply.status}"


def post_change(config: Config, agent: str, summary: str, diff: str, files: Sequence[str]) -> Reply:
    """Post one change to the board's changes route."""
    board = urllib.parse.quote(config.board_id, safe="")
    body = {"agent": agent[:40], "summary": summary[:MAX_SUMMARY_CHARS], "diff": diff, "files": list(files)}
    return call_api(
        "POST", f"{config.api_url}/api/agent/boards/{board}/changes", token=config.token, body=body,
        timeout=API_TIMEOUT_SECS,
    )  # fmt: skip


def build_summary(prompts: Sequence[str], agent: str) -> str:
    """The prompts behind the change, oldest first, or a stock line when none were saved."""
    if not prompts:
        return f"Changes made in a {agent} session."
    return "\n".join(prompts)[:MAX_SUMMARY_CHARS]


# =============================================================================
# One stop: snapshot, diff, decide, post
# =============================================================================


def report_turn(repo: Repo, config: Config, agent: str) -> tuple[str, str]:
    """Report what changed since the last reported snapshot and return `(outcome, detail)`."""
    policy, policy_note = fetch_policy(config.api_url)
    snapshot = take_snapshot(repo, policy)
    base = resolve_base(repo)
    files = changed_files(repo, base, snapshot, policy)
    diff = build_diff(repo, base, snapshot, files)
    prompts = load_prompts(repo)
    if not diff.strip():
        # Nothing sendable changed; moving the base is safe because the diff from it is empty.
        _git(["update-ref", BASE_REF, snapshot], repo.root)
        # The prompts behind a skipped change describe work no later diff will carry, so they go too.
        drop_prompts(repo, [item["id"] for item in prompts])
        return "skipped", "no changes to report"
    if not is_architectural(files, diff):
        # Judge each change once, so later diffs stay small and only carry new work.
        _git(["update-ref", BASE_REF, snapshot], repo.root)
        drop_prompts(repo, [item["id"] for item in prompts])
        return "skipped", f"no architectural change in {len(files)} file(s)"
    summary = build_summary([item["prompt"] for item in prompts], agent)
    try:
        reply = post_change(config, agent, summary, diff, files)
    except OSError as exc:
        return "error", f"could not reach {config.api_url}: {exc}"
    note = f"; {policy_note}" if policy_note else ""
    if reply.status == 202:
        _git(["update-ref", BASE_REF, snapshot], repo.root)
        drop_prompts(repo, [item["id"] for item in prompts])
        review = reply.body.get("review_url", "") if isinstance(reply.body, dict) else ""
        return "reported", f"{len(files)} file(s) sent, review at {review}{note}"
    # Any other answer keeps the base, so the next stop folds this change into its diff.
    reasons = {
        401: "the token was rejected; create a new one in the web app",
        404: "board not found; check THREATVIZ_BOARD_ID or run `init` again",
        409: "the board is busy mapping or analyzing; will retry on the next turn",
        429: "rate limited; will retry on the next turn",
    }
    return "kept", f"{reasons.get(reply.status, _error_message(reply))}{note}"


# =============================================================================
# Hook mode
# =============================================================================


def _detach() -> bool:
    """Fork into a background child on POSIX; return `True` in the process that should do the work."""
    if not hasattr(os, "fork"):
        return True
    # The hook starts no threads of its own, and a warning here would be output the agent sees.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        pid = os.fork()
    if pid > 0:
        return False
    os.setsid()
    # The agent waits until the hook's pipes close, so the child lets go of every standard stream.
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    return True


def run_hook(raw: str, env: Mapping[str, str]) -> None:
    """Handle one hook call. Returns quietly when the payload, repo or config is missing."""
    try:
        payload = json.loads(raw)
    except ValueError:
        return
    event = parse_event(payload)
    if event is None:
        return
    repo = find_repo(event.cwd)
    if repo is None:
        return
    try:
        config = load_config(repo, env)
    except ValueError as exc:
        record_outcome(repo, "refused" if isinstance(exc, UntrustedOriginError) else "error", str(exc))
        raise
    if config is None:
        return
    if event.kind == "prompt":
        append_prompt(repo, event.prompt)
        return
    if env.get(FOREGROUND_ENV) != "1" and not _detach():
        return
    with run_lock(repo) as held:
        if not held:
            record_outcome(repo, "skipped", "another run was in progress")
            return
        try:
            outcome, detail = report_turn(repo, config, event.agent)
        except (GitError, OSError) as exc:
            outcome, detail = "error", str(exc)
        record_outcome(repo, outcome, detail)


# =============================================================================
# Commands for humans
# =============================================================================


def _hook_command(repo: Repo | None, harness: str) -> str:
    """The shell command a harness should run, relative to the project dir when the script lives inside it."""
    script = Path(__file__).resolve()
    if harness == "claude" and repo is not None and script.is_relative_to(repo.root.resolve()):
        relative = script.relative_to(repo.root.resolve()).as_posix()
        return f'python3 "$CLAUDE_PROJECT_DIR"/{shlex.quote(relative)}'
    return f"python3 {shlex.quote(str(script))}"


def settings_snippet(repo: Repo | None, harness: str) -> dict[str, object]:
    """The hooks config for Claude Code (`claude`) or Cursor (`cursor`)."""
    command = _hook_command(repo, harness)
    if harness == "cursor":
        return {"version": 1, "hooks": {"beforeSubmitPrompt": [{"command": command}], "stop": [{"command": command}]}}
    hook = {"type": "command", "command": command, "async": True, "timeout": 60}
    return {"hooks": {"UserPromptSubmit": [{"hooks": [hook]}], "Stop": [{"hooks": [hook]}]}}


def _require_repo() -> Repo:
    """The repo around the current directory, or exit with a message."""
    repo = find_repo(Path.cwd())
    if repo is None:
        raise SystemExit("threatviz: run this inside the git repo you want to track.")
    return repo


def cmd_init(board_id: str, api_url: str | None) -> int:
    """Check the token and board, keep the origin under the git dir, write `.threatviz.json` and take the base."""
    repo = _require_repo()
    token = os.environ.get("THREATVIZ_TOKEN", "")
    if not token:
        raise SystemExit("threatviz: set THREATVIZ_TOKEN to a personal token (tvd_...) from the web app first.")
    # Never falls back to `.threatviz.json`: the token is about to be sent there.
    chosen = api_url or trusted_api_url(repo, os.environ)
    if not chosen:
        raise SystemExit("threatviz: pass `--api-url https://your-api` or set THREATVIZ_API_URL.")
    try:
        origin = normalize_api_url(chosen)
        reply = call_api("GET", f"{origin}/api/agent/boards", token=token, timeout=API_TIMEOUT_SECS)
    except ValueError as exc:
        raise SystemExit(f"threatviz: {exc}") from exc
    except OSError as exc:
        raise SystemExit(f"threatviz: could not reach {chosen}: {exc}") from exc
    if reply.status == 401:
        raise SystemExit("threatviz: the token was rejected. Create a new one in the web app.")
    if reply.status != 200 or not isinstance(reply.body, list):
        raise SystemExit(f"threatviz: listing boards failed: {_error_message(reply)}")
    boards = {item.get("id"): item.get("title", "") for item in reply.body if isinstance(item, dict)}
    if board_id not in boards:
        listed = "\n".join(f"  {bid}  {title}" for bid, title in boards.items()) or "  (none yet)"
        raise SystemExit(f"threatviz: board {board_id!r} is not one of yours. Your boards:\n{listed}")
    _write_json(repo.state_dir / ORIGIN_FILE, {"api_url": origin})
    # `api_url` is dropped too, since the hook refuses to post while a committed one differs from the kept origin.
    stored = {key: value for key, value in read_config_file(repo.root).items() if key not in ("token", "api_url")}
    stored["board_id"] = board_id
    (repo.root / CONFIG_FILE).write_text(json.dumps(stored, indent=2) + "\n", encoding="utf-8")
    policy, note = fetch_policy(origin)
    snapshot = take_snapshot(repo, policy)
    _git(["update-ref", BASE_REF, snapshot], repo.root)
    record_outcome(repo, "initialized", note)
    print(f"Tracking board {boards[board_id]!r} ({board_id}) from {repo.root}.")
    print(f"Wrote {CONFIG_FILE}; it holds no secrets or API origin and can be committed.")
    print(f"Kept the API origin in {repo.state_dir / ORIGIN_FILE}, which git never commits.")
    print("The token stays in THREATVIZ_TOKEN.")
    print("Changes from now on are reported. Add this to .claude/settings.json (or run `print-config cursor`):\n")
    print(json.dumps(settings_snippet(repo, "claude"), indent=2))
    return 0


def cmd_status() -> int:
    """Print the config, base, waiting prompts and last outcome for the current repo."""
    repo = _require_repo()
    stored = read_config_file(repo.root)
    env = os.environ
    trusted = trusted_api_url(repo, env)
    api_url = trusted or "(missing, run `init` or export THREATVIZ_API_URL)"
    board = env.get("THREATVIZ_BOARD_ID") or stored.get("board_id") or "(missing)"
    base = _ref_commit(repo, BASE_REF)
    last = _read_json(repo.state_dir / "last.json")
    print(f"repo:     {repo.root}")
    print(f"api url:  {api_url}")
    print(f"board:    {board}")
    print(f"token:    {'set' if env.get('THREATVIZ_TOKEN') else '(missing, export THREATVIZ_TOKEN)'}")
    print(f"base:     {base[:12] if base else 'HEAD (nothing reported yet)'}")
    print(f"prompts:  {len(load_prompts(repo))} waiting")
    print(f"locked:   {'yes' if (repo.state_dir / 'lock').exists() else 'no'}")
    if isinstance(last, dict):
        print(f"last run: {last.get('at')} {last.get('outcome')}: {last.get('detail')}")
    else:
        print("last run: never")
    if "token" in stored:
        print(f"warning:  remove `token` from {CONFIG_FILE}; the hook ignores it and it should not be committed.")
    if trusted:
        try:
            check_committed_origin(stored, normalize_api_url(trusted))
        except ValueError as exc:
            print(f"warning:  {exc}")
    return 0


def cmd_print_config(harness: str) -> int:
    """Print the hooks config for one harness."""
    print(json.dumps(settings_snippet(find_repo(Path.cwd()), harness), indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    """The command line: no subcommand means hook mode, reading the payload from stdin."""
    parser = argparse.ArgumentParser(
        prog="threatviz_hook.py",
        description="Report architectural changes from Claude Code or Cursor to a ThreatViz Defend board. "
        "With no subcommand it runs as a hook and reads the hook payload from stdin.",
    )
    commands = parser.add_subparsers(dest="command")
    init = commands.add_parser("init", help="link this repo to a board and take the first snapshot")
    init.add_argument("--board", required=True, help="board id from the web app")
    init.add_argument("--api-url", help="API origin, for example https://api.example.com")
    commands.add_parser("status", help="show config, base snapshot and the last run")
    printer = commands.add_parser("print-config", help="print the hooks config for a harness")
    printer.add_argument("harness", choices=("claude", "cursor"))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run a human command, or run as a hook that always exits 0 and never writes to stdout."""
    args = build_parser().parse_args(argv)
    if args.command == "init":
        return cmd_init(args.board, args.api_url)
    if args.command == "status":
        return cmd_status()
    if args.command == "print-config":
        return cmd_print_config(args.harness)
    # Integration boundary: nothing may break or block the agent, so every failure ends as one stderr line.
    try:
        run_hook(sys.stdin.read(), os.environ)
    except Exception as exc:
        with contextlib.suppress(Exception):
            print(f"threatviz: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
