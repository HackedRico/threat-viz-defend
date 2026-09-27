import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any

from app.domain.masking import MAX_FILES, mask_secrets, skip_reason

# =============================================================================
# Module Overview
# =============================================================================
# Turns uploads and agent changes into material for the map prompt. `build_material`
# drops files that should never be read, masks credential-shaped values, and
# when a code folder is too big, keeps the files that say the most about
# architecture: docs, manifests, deploy files, API specs and entry points.
# Only a record of each source (name, kind, size) is kept after the call.
# Code files go in with a line number before each line, so the map can point
# a reader at `path:line` instead of making them search for it.

MATERIAL_CHARS = 150_000
PER_FILE_CHARS = 24_000
# The changed file list of one agent change, so a long list cannot crowd out the diff or the budget.
FILE_LIST_CHARS = 20_000
TREE_LINES = 300

# Lower rank is read first. Checked in order against the lowercase path.
_PRIORITY: tuple[tuple[int, re.Pattern[str]], ...] = (
    (0, re.compile(r"(^|/)(readme|architecture|design|overview)[^/]*\.(md|txt|rst)$")),
    (1, re.compile(r"(^|/)docs?/.*\.(md|txt|rst)$")),
    (
        2,
        re.compile(
            r"(^|/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|cargo\.toml|pom\.xml|"
            r"build\.gradle(\.kts)?|gemfile|composer\.json|deno\.jsonc?)$"
        ),
    ),
    (
        3,
        re.compile(
            r"(^|/)(dockerfile[^/]*|[^/]*compose[^/]*\.ya?ml|procfile|fly\.toml|vercel\.json|netlify\.toml|"
            r"app\.ya?ml|serverless\.ya?ml|[^/]*\.tf|\.env\.(example|sample|template))$"
        ),
    ),
    (4, re.compile(r"(^|/)(openapi|swagger)[^/]*\.(ya?ml|json)$|\.proto$|\.graphql$|(^|/)\.?mcp\.json$")),
    (5, re.compile(r"(^|/)(k8s|kubernetes|helm|deploy|infra|terraform|\.github/workflows)/")),
    (6, re.compile(r"(^|/)(main|app|server|index|wsgi|asgi|manage|settings|config)\.[a-z]+$")),
    (7, re.compile(r"(^|/)(routes?|routers?|api|controllers?|handlers?|views|services?|agents?|tools?|auth)/")),
    (8, re.compile(r"\.(py|ts|tsx|js|jsx|go|rs|java|kt|rb|php|cs|swift)$")),
)


# Prose reads better without line numbers, and its evidence is quoted, not located.
_PROSE = re.compile(r"\.(md|markdown|mdx|txt|rst|adoc)$")


@dataclass(frozen=True)
class SourceItem:
    """One uploaded piece of material."""

    name: str
    kind: str
    text: str


@dataclass(frozen=True)
class Material:
    """Prompt-ready material and the record of what went into it."""

    text: str
    sources: list[dict[str, Any]]
    masked: int
    skipped: list[str] = field(default_factory=list)
    omitted: list[str] = field(default_factory=list)

    def summary(self) -> str:
        """One line for the activity log."""
        names = [s["name"] for s in self.sources]
        shown = ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else "")
        parts = [f"Added {shown}"]
        if self.masked:
            parts.append(f"masked {self.masked} secret-like values")
        if self.skipped:
            parts.append(f"skipped {len(self.skipped)} files")
        if self.omitted:
            parts.append(f"left out {len(self.omitted)} files over the size budget")
        return ". ".join(parts) + "."


def build_material(items: Sequence[SourceItem], now: datetime) -> Material:
    """Filter, mask and rank uploaded items into one block of material."""
    skipped: list[str] = []
    readable: list[SourceItem] = []
    for item in items[:MAX_FILES]:
        reason = skip_reason(item.name) if item.kind in ("file", "code") else None
        if reason:
            skipped.append(f"{item.name}: {reason}")
        elif item.text.strip():
            readable.append(item)

    masked_total = 0
    chunks: list[str] = []
    omitted: list[str] = []
    budget = MATERIAL_CHARS

    code_paths = [i.name for i in readable if i.kind == "code"]
    if code_paths:
        tree = "\n".join(sorted(code_paths)[:TREE_LINES])
        more = f"\n... and {len(code_paths) - TREE_LINES} more files" if len(code_paths) > TREE_LINES else ""
        listing = f"### File tree of the uploaded folder\n{tree}{more}"
        chunks.append(listing)
        budget -= len(listing)

    for item in sorted(readable, key=_rank):
        masked = mask_secrets(item.text)
        masked_total += masked.count
        body = masked.text
        cut = ""
        if len(body) > PER_FILE_CHARS:
            body = body[:PER_FILE_CHARS]
            cut = f"\n[... cut: the file continues for {len(masked.text) - PER_FILE_CHARS} characters]"
        if item.kind != "text" and not _PROSE.search(item.name.lower()):
            body = number_lines(body)
        body += cut
        block = f"### {_heading(item)}\n{body}"
        if len(block) > budget:
            omitted.append(item.name)
            continue
        chunks.append(block)
        budget -= len(block)

    if omitted:
        chunks.append("### Files left out to fit the size budget\n" + "\n".join(omitted[:TREE_LINES]))
    sources = [
        {
            "id": str(uuid.uuid4()),
            "name": _display_name(i),
            "kind": i.kind,
            "bytes": len(i.text.encode()),
            "added_at": now.isoformat(),
        }
        for i in readable
        if i.name not in omitted
    ]
    # A folder shows up as one source in the sidebar, not hundreds.
    sources = _collapse_code(sources, now)
    return Material("\n\n".join(chunks), sources, masked_total, skipped, omitted)


def number_lines(text: str) -> str:
    """Prefix each line with its 1-based number as `12| `, the form the map prompt tells the model to cite."""
    return "\n".join(f"{number}| {line}" for number, line in enumerate(text.split("\n"), start=1))


def agent_material(agent: str, summary: str, diff: str, files: Sequence[str], now: datetime) -> Material:
    """Material for one coding agent change: what the agent said it did, the files and the diff."""
    safe_summary = mask_secrets(" ".join(summary.split())).text
    safe_diff = mask_secrets(_drop_secret_hunks(diff))
    listed = [f[:300] for f in files if not skip_reason(f)][:200]
    text = "\n".join(
        [
            f"### coding agent change: {agent}",
            f"What the agent was asked or says it did: {safe_summary or 'not reported'}",
            f"Changed files: {', '.join(listed)[:FILE_LIST_CHARS] if listed else 'not listed'}",
            "",
            safe_diff.text[:MATERIAL_CHARS],
        ]
    )
    title = safe_summary[:80] or "Agent change"
    source = {
        "id": str(uuid.uuid4()),
        "name": f"{agent}: {title}",
        "kind": "agent",
        "bytes": len(text.encode()),
        "added_at": now.isoformat(),
    }
    return Material(text, [source], safe_diff.count)


def _rank(item: SourceItem) -> tuple[int, int, str]:
    """Sort key: pasted text first, then by architectural value, then smaller files first."""
    if item.kind == "text":
        return (-1, 0, item.name)
    path = item.name.lower()
    rank = next((r for r, pattern in _PRIORITY if pattern.search(path)), 9)
    return (rank, len(item.text), path)


def _heading(item: SourceItem) -> str:
    """The heading a model sees above one item."""
    if item.kind == "text":
        return f"Pasted text: {item.name}"
    lines = item.text.count("\n") + 1
    return f"File {item.name} ({lines} lines)"


def _display_name(item: SourceItem) -> str:
    """A short name for the sidebar."""
    return item.name if item.kind == "text" else PurePosixPath(item.name).as_posix()


def _collapse_code(sources: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    """Replace many code files with one folder entry named after their common root."""
    code = [s for s in sources if s["kind"] == "code"]
    if len(code) <= 1:
        return sources
    roots = {PurePosixPath(s["name"]).parts[0] for s in code}
    name = f"{roots.pop()}/ ({len(code)} files)" if len(roots) == 1 else f"Code folder ({len(code)} files)"
    folder = {
        "id": str(uuid.uuid4()),
        "name": name,
        "kind": "code",
        "bytes": sum(s["bytes"] for s in code),
        "added_at": now.isoformat(),
    }
    return [s for s in sources if s["kind"] != "code"] + [folder]


# Git's own headers; `--cc` and `--combined` are what a plain `git diff` prints during an unresolved merge.
_DIFF_HEADER = re.compile(r"^diff (?:--git|--cc|--combined) [^\n]*$", re.MULTILINE)
# Lines between a section's header and its first hunk that name the file on either side.
_PATH_LINES = ("--- ", "+++ ", "rename from ", "rename to ", "copy from ", "copy to ")
_C_ESCAPES = {"a": 7, "b": 8, "t": 9, "n": 10, "v": 11, "f": 12, "r": 13, '"': 34, "\\": 92}


def _drop_secret_hunks(diff: str) -> str:
    """Remove whole file sections of a unified diff for files that should never be read, or cannot be named."""
    diff = diff.replace("\r\n", "\n")
    sections = _DIFF_HEADER.split(diff)
    headers = _DIFF_HEADER.findall(diff)
    # Text before the first header is usually a message, but a plain `diff -u` block there names its files too.
    preamble = sections[0]
    reasons = [reason for path in _named_paths(preamble, in_header=False) if (reason := skip_reason(path))]
    kept = [f"[left out: {reasons[0]}]\n" if reasons else preamble]
    for header, body in zip(headers, sections[1:], strict=True):
        paths = [*_header_paths(header), *_named_paths(body, in_header=True)]
        reasons = [reason for path in paths if (reason := skip_reason(path))]
        if not paths:
            # A header this parser cannot read might hide a secret file, so it is dropped rather than trusted.
            kept.append(f"{header}\n[left out: the file name could not be read]\n")
        elif reasons:
            kept.append(f"{header}\n[left out: {reasons[0]}]\n")
        else:
            kept.append(f"{header}{body}")
    return "".join(kept)


def _named_paths(text: str, *, in_header: bool) -> list[str]:
    """Every path `text` names on `---`, `+++`, rename and copy lines, header lines until each first hunk."""
    paths: list[str] = []
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if line.startswith("@@"):
            in_header = False
        elif in_header:
            paths += [_diff_name(line, prefix) for prefix in _PATH_LINES if line.startswith(prefix)]
        elif line.startswith("--- ") and index + 1 < len(lines) and lines[index + 1].startswith("+++ "):
            # Inside hunks only a `---` line right above a `+++` line starts another file, so a removed
            # line that happens to begin with two dashes is not read as a name.
            in_header = True
            paths.append(_diff_name(line, "--- "))
    return [path for path in paths if path and path != "/dev/null"]


def _diff_name(line: str, prefix: str) -> str:
    """The path on one `---`, `+++`, rename or copy line, unquoted and without git's `a/` or `b/`."""
    name = _unquote(line.removeprefix(prefix).split("\t")[0])
    if prefix in ("--- ", "+++ ") and name[:2] in ("a/", "b/"):
        return name[2:]
    return name


def _header_paths(header: str) -> list[str]:
    """The paths a `diff` header names, quoted or not; empty when they cannot be told apart."""
    if not header.startswith("diff --git "):
        # A merge's `diff --cc path` names one path.
        path = _unquote(header.split(" ", 2)[2].strip())
        return [path] if path else []
    rest = header.removeprefix("diff --git ")
    if rest.startswith('"'):
        first, _, after = _split_quoted(rest)
        second = _unquote(after.strip())
        return [p[2:] for p in (first, second) if p[:2] in ("a/", "b/")]
    # Unquoted paths may hold spaces, so `a/P b/P` is only readable when both sides are the same path.
    half = (len(rest) - 5) // 2
    if rest.startswith("a/") and rest[2 + half : 5 + half] == " b/" and rest[2 : 2 + half] == rest[5 + half :]:
        return [rest[2 : 2 + half]]
    return []


def _split_quoted(text: str) -> tuple[str, str, str]:
    """Split a leading C-quoted string off `text`: (unquoted value, quoted source, rest)."""
    index = 1
    while index < len(text) and text[index] != '"':
        index += 2 if text[index] == "\\" else 1
    return _unquote(text[: index + 1]), text[: index + 1], text[index + 1 :]


def _unquote(name: str) -> str:
    """Undo git's C-style quoting of a path with special or non-ASCII characters."""
    if len(name) < 2 or not (name.startswith('"') and name.endswith('"')):
        return name
    raw = bytearray()
    body, index = name[1:-1], 0
    while index < len(body):
        char = body[index]
        if char == "\\" and index + 1 < len(body):
            escaped = body[index + 1]
            if escaped in "01234567":
                digits = body[index + 1 : index + 4]
                raw.append(int(digits, 8) & 0xFF)
                index += 1 + len(digits)
                continue
            raw.append(_C_ESCAPES.get(escaped, ord(escaped) & 0xFF))
            index += 2
            continue
        raw.extend(char.encode())
        index += 1
    return raw.decode(errors="replace")
