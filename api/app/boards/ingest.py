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

MATERIAL_CHARS = 150_000
PER_FILE_CHARS = 24_000
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
        if len(body) > PER_FILE_CHARS:
            body = (
                body[:PER_FILE_CHARS]
                + f"\n[... cut: the file continues for {len(masked.text) - PER_FILE_CHARS} characters]"
            )
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


def agent_material(agent: str, summary: str, diff: str, files: Sequence[str], now: datetime) -> Material:
    """Material for one coding agent change: what the agent said it did, the files and the diff."""
    safe_summary = mask_secrets(" ".join(summary.split())).text
    safe_diff = mask_secrets(_drop_secret_hunks(diff))
    listed = [f for f in files if not skip_reason(f)][:200]
    text = "\n".join(
        [
            f"### coding agent change: {agent}",
            f"What the agent was asked or says it did: {safe_summary or 'not reported'}",
            f"Changed files: {', '.join(listed) if listed else 'not listed'}",
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


_DIFF_FILE = re.compile(r"^diff --git a/(\S+) b/(\S+)", re.MULTILINE)


def _drop_secret_hunks(diff: str) -> str:
    """Remove whole file sections of a unified diff for files that should never be read."""
    sections = _DIFF_FILE.split(diff)
    if len(sections) == 1:
        return diff
    kept = [sections[0]]
    # `split` with two groups yields: preamble, then (a_path, b_path, body) triples.
    for index in range(1, len(sections), 3):
        a_path, b_path, body = sections[index], sections[index + 1], sections[index + 2]
        if skip_reason(b_path) or skip_reason(a_path):
            kept.append(f"diff --git a/{a_path} b/{b_path}\n[left out: {skip_reason(b_path) or skip_reason(a_path)}]\n")
        else:
            kept.append(f"diff --git a/{a_path} b/{b_path}{body}")
    return "".join(kept)
