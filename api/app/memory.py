import logging
import re
from collections.abc import Callable
from typing import Protocol

from app.llm.backboard import BackboardApi
from app.llm.base import LlmError

# =============================================================================
# Module Overview
# =============================================================================
# Long-term memory of one developer's progress, kept apart from the model that
# answers. `Memory` is what the analyst calls around `answer` and `grade`:
# `recall` returns notes from earlier sessions and `keep` stores a new one.
# `BackboardMemory` keeps them in the user's own Backboard assistant, through
# Backboard's memory API only, so any provider can do the model work. Notes are
# composed by the analyst from questions and verdicts, never from uploads, maps
# or the developer's own answer text. Memory is a nicety: when Backboard fails,
# the analysis goes on without it.

log = logging.getLogger(__name__)

_RECALL_LIMIT = 5
_QUERY_CHARS = 500
_NOTE_CHARS = 600
# Assistant ids go into URL paths, so only plain id characters are accepted from Backboard.
_ASSISTANT_ID = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
_ASSISTANT = {
    "name": "ThreatViz Defend memory",
    "system_prompt": "Holds one developer's progress in threat modeling: questions asked and quiz verdicts.",
}


class Memory(Protocol):
    """Notes about one developer that carry across boards and sessions."""

    def recall(self, query: str) -> list[str]:
        """Earlier notes relevant to `query`, most relevant first; empty when there are none or memory failed."""
        ...

    def keep(self, note: str) -> None:
        """Store `note` for later sessions; a failure is logged, never raised."""
        ...


class BackboardMemory:
    """A `Memory` held in the user's Backboard assistant, created the first time a note is kept."""

    def __init__(
        self,
        api: BackboardApi,
        *,
        assistant_id: str | None,
        on_assistant: Callable[[str], None] | None = None,
    ) -> None:
        self._api = api
        self._assistant_id = assistant_id if assistant_id and _ASSISTANT_ID.match(assistant_id) else None
        self._on_assistant = on_assistant

    def check(self) -> str:
        """Confirm the key works by listing assistants; raises `LlmError` when it does not."""
        response = self._api.request("GET", "/assistants")
        count = len(response) if isinstance(response, list) else 0
        return f"Backboard accepted the key ({count} assistants on the account)."

    def recall(self, query: str) -> list[str]:
        """Search the assistant's memories; with no assistant yet there is nothing to find."""
        if self._assistant_id is None or not query.strip():
            return []
        try:
            reply = self._api.request(
                "POST",
                f"/assistants/{self._assistant_id}/memories/search",
                {"query": query.strip()[:_QUERY_CHARS], "limit": _RECALL_LIMIT},
            )
        except LlmError as exc:
            log.warning("[memory] recall failed: %s", exc.code)
            return []
        found = reply.get("memories") if isinstance(reply, dict) else None
        if not isinstance(found, list):
            return []
        notes = [str(m["content"])[:_NOTE_CHARS] for m in found if isinstance(m, dict) and m.get("content")]
        return notes[:_RECALL_LIMIT]

    def keep(self, note: str) -> None:
        """Add one note, creating the assistant on first use."""
        try:
            assistant = self._assistant_id or self._create_assistant()
            if assistant is None:
                return
            self._api.request("POST", f"/assistants/{assistant}/memories", {"content": note.strip()[:_NOTE_CHARS]})
        except LlmError as exc:
            log.warning("[memory] keep failed: %s", exc.code)

    def _create_assistant(self) -> str | None:
        """Make the assistant that holds this user's notes, and report its id so it is reused."""
        reply = self._api.request("POST", "/assistants", dict(_ASSISTANT))
        assistant = reply.get("assistant_id") if isinstance(reply, dict) else None
        if not isinstance(assistant, str) or not _ASSISTANT_ID.match(assistant):
            log.warning("[memory] Backboard returned no usable assistant id.")
            return None
        self._assistant_id = assistant
        if self._on_assistant is not None:
            self._on_assistant(assistant)
        return assistant
