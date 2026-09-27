import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from app.llm.base import LlmError

# =============================================================================
# Module Overview
# =============================================================================
# Backboard is the memory layer around the model calls. The model that answers
# stays the server's (DigitalOcean serverless inference by default) or a user's
# own endpoint; Backboard only remembers. Before a question is answered or an
# open quiz answer graded, `recall` fetches a developer's notes from earlier
# sessions and they are fenced into the prompt. After a question or any quiz
# answer, `keep` stores a new note, and the quiz reads the notes back to start
# with the topics they found hard. `BackboardMemory` keeps each user's notes
# in their own Backboard assistant and talks only to Backboard's memory API.
# Notes come from `app.domain.notes`, never from uploads, maps or answer text.
# Memory is a nicety: when Backboard fails, the work goes on without it.

log = logging.getLogger(__name__)

RECALL_LIMIT = 5
_QUERY_CHARS = 500
_NOTE_CHARS = 600
# Backboard pages memories at up to 100.
_LIST_LIMIT = 100
# Assistant ids go into URL paths, so only plain id characters are accepted from Backboard.
_ASSISTANT_ID = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
_ASSISTANT_PROMPT = (
    "Holds one developer's progress in threat modeling for ThreatViz Defend: the questions they asked about "
    "their boards and how their quiz answers went, by topic."
)


@dataclass(frozen=True)
class Note:
    """One remembered note, as Backboard lists it."""

    id: str
    content: str
    created_at: str | None


class Memory(Protocol):
    """Notes about one developer that carry across boards and sessions."""

    def recall(self, query: str, limit: int = RECALL_LIMIT) -> list[str]:
        """Earlier notes relevant to `query`, most relevant first; empty when there are none or memory failed."""
        ...

    def keep(self, note: str) -> None:
        """Store `note` for later sessions; a failure is logged, never raised."""
        ...


class MemorySource(Protocol):
    """Anything that finds the memory, if any, for a user."""

    def for_user(self, user_id: str) -> Memory | None:
        """The user's memory, or `None` when it is off or not set up."""
        ...


class NoMemory:
    """A `MemorySource` for setups without memory, such as most tests."""

    def for_user(self, user_id: str) -> Memory | None:
        """Never any memory."""
        return None


class BackboardMemory:
    """A `Memory` held in one Backboard assistant; `ensure_assistant` makes it on the first note."""

    def __init__(
        self,
        api: "BackboardApi",
        *,
        assistant_id: str | None,
        ensure_assistant: Callable[[], str | None] | None = None,
    ) -> None:
        self._api = api
        self._assistant_id = _usable(assistant_id)
        self._ensure = ensure_assistant

    def check(self) -> str:
        """Confirm the key works by listing assistants; raises `LlmError` when it does not."""
        response = self._api.request("GET", "/assistants")
        count = len(response) if isinstance(response, list) else 0
        return f"Backboard accepted the key ({count} assistants on the account)."

    def recall(self, query: str, limit: int = RECALL_LIMIT) -> list[str]:
        """Search the assistant's memories; with no assistant yet there is nothing to find."""
        if self._assistant_id is None or not query.strip():
            return []
        try:
            reply = self._api.request(
                "POST",
                f"/assistants/{self._assistant_id}/memories/search",
                {"query": query.strip()[:_QUERY_CHARS], "limit": max(1, min(limit, 50))},
            )
        except LlmError as exc:
            log.warning("[memory] recall failed: %s", exc.code)
            return []
        return [note.content for note in _notes(reply)][:limit]

    def keep(self, note: str) -> None:
        """Add one note, making the assistant first when there is none yet."""
        try:
            assistant = self._assistant_id or (self._ensure() if self._ensure is not None else None)
            assistant = _usable(assistant)
            if assistant is None:
                return
            self._assistant_id = assistant
            self._api.request(
                "POST",
                f"/assistants/{assistant}/memories",
                {"content": note.strip()[:_NOTE_CHARS], "metadata": {"source": "threatviz-defend"}},
            )
        except LlmError as exc:
            log.warning("[memory] keep failed: %s", exc.code)

    def notes(self, limit: int = _LIST_LIMIT) -> list[Note]:
        """Every note the assistant holds, newest first; raises `LlmError`, since the memory page says why."""
        if self._assistant_id is None:
            return []
        reply = self._api.request(
            "GET", f"/assistants/{self._assistant_id}/memories", params={"page": 1, "page_size": min(limit, 100)}
        )
        found = _notes(reply)
        # Backboard does not promise an order; ISO timestamps sort by time, and notes without one go last.
        return sorted(found, key=lambda note: note.created_at or "", reverse=True)[:limit]

    def forget_all(self) -> None:
        """Delete every note the assistant holds; raises `LlmError` when Backboard refuses."""
        if self._assistant_id is not None:
            self._api.request("DELETE", f"/assistants/{self._assistant_id}/memories")


def create_assistant(api: "BackboardApi", name: str) -> str | None:
    """Make the assistant that holds one user's notes and return its id, or `None` when Backboard gave none."""
    reply = api.request("POST", "/assistants", {"name": name[:255], "system_prompt": _ASSISTANT_PROMPT})
    assistant = _usable(reply.get("assistant_id") if isinstance(reply, dict) else None)
    if assistant is None:
        log.warning("[memory] Backboard returned no usable assistant id.")
    return assistant


class BackboardApi:
    """Backboard's HTTP API with its key, redirects off, and failures turned into `LlmError`."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        label: str = "Backboard",
        timeout_s: float = 15.0,
        client: httpx.Client | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._label = label
        self._headers = {"X-API-Key": api_key}
        self._client = client or httpx.Client(
            base_url=base_url.rstrip("/"), timeout=timeout_s, follow_redirects=False, transport=transport
        )

    def request(
        self, method: str, path: str, body: dict[str, Any] | None = None, *, params: dict[str, Any] | None = None
    ) -> Any:
        """Call Backboard and return its JSON, translating HTTP failures into `LlmError`."""
        try:
            response = self._client.request(method, path, json=body, params=params, headers=self._headers)
        except httpx.TimeoutException as exc:
            raise LlmError("timeout", f"{self._label} took too long to answer. Try again.") from exc
        except httpx.HTTPError as exc:
            raise LlmError("unavailable", f"{self._label} is unreachable right now.") from exc
        if response.status_code in (401, 403):
            raise LlmError("auth", "Backboard rejected the API key. Check it in settings.")
        if response.status_code == 429:
            raise LlmError("rate_limited", "Backboard is rate limiting requests. Wait a minute and retry.")
        if response.status_code == 404:
            raise LlmError("not_configured", "Backboard does not know that assistant or endpoint.")
        if response.status_code >= 400:
            # Collapsing whitespace keeps a hostile error body from forging log lines.
            detail = " ".join(response.text[:200].split())
            raise LlmError("unavailable", f"Backboard answered {response.status_code}: {detail}")
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise LlmError("bad_output", "Backboard returned something that is not JSON.") from exc


def _notes(reply: object) -> list[Note]:
    """The notes in a Backboard list or search reply, skipping entries without text."""
    found = reply.get("memories") if isinstance(reply, dict) else None
    if not isinstance(found, list):
        return []
    notes: list[Note] = []
    for item in found:
        if isinstance(item, dict) and item.get("content"):
            created = item.get("created_at")
            notes.append(
                Note(
                    id=str(item.get("id") or ""),
                    content=str(item["content"])[:_NOTE_CHARS],
                    created_at=str(created) if created else None,
                )
            )
    return notes


def _usable(assistant_id: object) -> str | None:
    """An assistant id safe to put in a URL path, or `None`."""
    return assistant_id if isinstance(assistant_id, str) and _ASSISTANT_ID.match(assistant_id) else None
