import logging
import threading
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

import httpx
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import Database, utcnow
from app.errors import AppError, bad_request
from app.llm.base import LlmError
from app.memory import BackboardApi, BackboardMemory, create_assistant
from app.providers.secrets_box import SecretBox
from app.schemas import MemoryIn, MemoryNoteOut, MemoryNotesOut, MemoryOut, MemorySource, MemoryTestOut
from app.tables import MemoryPrefsRow, MemoryRow

# =============================================================================
# Module Overview
# =============================================================================
# Who holds a user's memory, and whether it is on. The server's Backboard key
# (`BACKBOARD_API_KEY`) gives every user memory by default, each in their own
# assistant on that account. A user may turn memory off, or bring their own
# Backboard key, sealed like a provider key, so their notes live in their own
# account. Memory works with whichever model serves the user, since it sits
# around the model calls rather than making them. Backboard is a fixed host
# (`BACKBOARD_BASE_URL`), so no user URL is involved.

log = logging.getLogger(__name__)

# Memory is a side call around the real work, and a recall runs while a person waits on an answer, so a
# Backboard that hangs costs each answer at most this long before the answer goes on without memory.
_TIMEOUT_S = 8.0
# The sealed key's owner string differs from a provider key's, so one cannot be swapped in for the other.
_SEAL_SCOPE = "memory:"

Account = Literal["own", "server"]


@dataclass(frozen=True)
class _Where:
    """The Backboard account and assistant that hold one user's notes."""

    account: Account
    key: str
    assistant_id: str | None


class MemorySettings:
    """Per-user memory: the switch, an optional own key, and the `Memory` that services call."""

    def __init__(self, db: Database, settings: Settings, *, transport: httpx.BaseTransport | None = None) -> None:
        self._db = db
        self._base_url = settings.backboard_base_url
        self._server_key = settings.backboard_api_key
        self._box = SecretBox(settings.app_secret)
        self._transport = transport
        # Held while making an assistant, so two notes kept at once cannot each make one and orphan the other.
        self._creating = threading.Lock()

    @property
    def server_key_set(self) -> bool:
        """Whether the server has its own Backboard key, which gives every user memory by default."""
        return self._server_key is not None

    def view(self, session: Session, user_id: str) -> MemoryOut:
        """The user's memory setting, without the key."""
        own = session.get(MemoryRow, user_id)
        prefs = session.get(MemoryPrefsRow, user_id)
        enabled = prefs.enabled if prefs is not None else True
        source: MemorySource = "own" if own is not None else ("server" if self._server_key else "none")
        return MemoryOut(
            enabled=enabled,
            active=enabled and source != "none",
            source=source,
            saved=own is not None,
            key_preview=f"...{own.key_last4}" if own is not None else None,
            message=_message(enabled, source),
            updated_at=_latest(own, prefs),
        )

    def switch(self, session: Session, user_id: str, enabled: bool) -> MemoryOut:
        """Turn memory on or off; notes already kept stay in Backboard until forgotten."""
        prefs = session.get(MemoryPrefsRow, user_id)
        if prefs is None:
            prefs = MemoryPrefsRow(user_id=user_id)
            session.add(prefs)
        prefs.enabled = enabled
        prefs.updated_at = utcnow()
        session.flush()
        return self.view(session, user_id)

    def save(self, session: Session, user_id: str, body: MemoryIn) -> MemoryOut:
        """Save the user's own key, keeping the stored one when `api_key` is null."""
        row = session.get(MemoryRow, user_id)
        if body.api_key is None:
            if row is None:
                raise bad_request("Enter your Backboard API key.")
        else:
            key = body.api_key.strip()
            if not key:
                raise bad_request("Enter your Backboard API key.")
            if row is None:
                row = MemoryRow(user_id=user_id)
                session.add(row)
            elif not self._same_key(row, user_id, key):
                # Another account's key would not know the old assistant.
                row.assistant_id = None
            row.key_sealed = self._box.seal(key, _SEAL_SCOPE + user_id)
            row.key_last4 = key[-4:]
        row.updated_at = utcnow()
        session.flush()
        return self.view(session, user_id)

    def delete(self, session: Session, user_id: str) -> None:
        """Forget the user's own key, so the server's account takes over. Their notes stay in their account."""
        row = session.get(MemoryRow, user_id)
        if row is not None:
            session.delete(row)

    def test(self, user_id: str, body: MemoryIn) -> MemoryTestOut:
        """Check that Backboard accepts the typed key, or the saved one when none was typed."""
        key = body.api_key.strip() if body.api_key is not None else self._saved_key(user_id)
        if key is None:
            raise bad_request("Enter your Backboard API key to test.")
        memory = BackboardMemory(self._api(key), assistant_id=None)
        try:
            return MemoryTestOut(ok=True, message=memory.check())
        except LlmError as exc:
            return MemoryTestOut(ok=False, message=exc.message)

    def for_user(self, user_id: str) -> BackboardMemory | None:
        """The user's memory while it is on, or `None` when it is off or there is no key."""
        with self._db.session() as session:
            prefs = session.get(MemoryPrefsRow, user_id)
            if prefs is not None and not prefs.enabled:
                return None
        return self._memory(user_id)

    def notes(self, user_id: str) -> MemoryNotesOut:
        """Every note memory holds for the user, newest first, even while memory is off."""
        where = self._where(user_id)
        if where is None:
            return MemoryNotesOut(source="none", notes=[])
        memory = self._memory(user_id)
        try:
            found = memory.notes() if memory is not None else []
        except LlmError as exc:
            raise AppError(503, "memory_error", exc.message) from exc
        return MemoryNotesOut(
            source=where.account,
            notes=[MemoryNoteOut(id=n.id, content=n.content, created_at=n.created_at) for n in found],
        )

    def forget(self, user_id: str) -> None:
        """Delete every note memory holds for the user, in whichever account holds them now."""
        memory = self._memory(user_id)
        if memory is None:
            return
        try:
            memory.forget_all()
        except LlmError as exc:
            raise AppError(503, "memory_error", exc.message) from exc

    # -----------------------------------------------------------------
    # Internals
    # -----------------------------------------------------------------

    def _memory(self, user_id: str) -> BackboardMemory | None:
        """The memory in the user's current account, whether or not it is switched on."""
        where = self._where(user_id)
        if where is None:
            return None
        return BackboardMemory(
            self._api(where.key),
            assistant_id=where.assistant_id,
            ensure_assistant=lambda: self._ensure_assistant(user_id, where),
        )

    def _where(self, user_id: str) -> _Where | None:
        """The user's own key when they saved one, else the server's, with the assistant stored for it."""
        with self._db.session() as session:
            own = session.get(MemoryRow, user_id)
            if own is not None:
                sealed, assistant = own.key_sealed, own.assistant_id
            elif self._server_key is not None:
                prefs = session.get(MemoryPrefsRow, user_id)
                return _Where("server", self._server_key, prefs.assistant_id if prefs is not None else None)
            else:
                return None
        try:
            return _Where("own", self._box.open(sealed, _SEAL_SCOPE + user_id), assistant)
        except ValueError:
            # A key sealed under an old secret cannot be used; answers still work without memory.
            log.warning("[memory] A saved Backboard key no longer opens; memory is off for that user.")
            return None

    def _ensure_assistant(self, user_id: str, where: _Where) -> str | None:
        """The stored assistant for this account, made now when there is none; raises `LlmError` from Backboard."""
        with self._creating:
            # Read again under the lock: a note kept a moment ago may have made it already.
            stored = self._stored_assistant(user_id, where.account)
            if stored is not None:
                return stored
            assistant = create_assistant(self._api(where.key), f"ThreatViz Defend memory {user_id}")
            if assistant is not None:
                self._store_assistant(user_id, where.account, assistant)
            return assistant

    def _stored_assistant(self, user_id: str, account: Account) -> str | None:
        """The assistant id saved for `account`, if any."""
        with self._db.session() as session:
            row = session.get(MemoryRow, user_id) if account == "own" else session.get(MemoryPrefsRow, user_id)
            return row.assistant_id if row is not None else None

    def _store_assistant(self, user_id: str, account: Account, assistant: str) -> None:
        """Save a new assistant id where `account` keeps it."""
        with self._db.session() as session:
            if account == "own":
                own = session.get(MemoryRow, user_id)
                if own is not None:
                    own.assistant_id = assistant
                return
            prefs = session.get(MemoryPrefsRow, user_id)
            if prefs is None:
                prefs = MemoryPrefsRow(user_id=user_id, enabled=True)
                session.add(prefs)
            prefs.assistant_id = assistant
            prefs.updated_at = utcnow()

    def _saved_key(self, user_id: str) -> str | None:
        """The stored own key, opened, or `None` when there is none."""
        with self._db.session() as session:
            row = session.get(MemoryRow, user_id)
            if row is None:
                return None
            try:
                return self._box.open(row.key_sealed, _SEAL_SCOPE + user_id)
            except ValueError as exc:
                raise bad_request(str(exc)) from exc

    def _same_key(self, row: MemoryRow, user_id: str, key: str) -> bool:
        """Whether `key` is the one already saved; a key that no longer opens counts as different."""
        try:
            return self._box.open(row.key_sealed, _SEAL_SCOPE + user_id) == key
        except ValueError:
            return False

    def _api(self, key: str) -> BackboardApi:
        """A client for the fixed Backboard host."""
        return BackboardApi(
            api_key=key,
            base_url=self._base_url,
            label="Backboard memory",
            timeout_s=_TIMEOUT_S,
            transport=self._transport,
        )


def _message(enabled: bool, source: MemorySource) -> str:
    """One line on what memory does for the user right now."""
    if source == "none":
        return "Memory needs a Backboard key. Add yours below, or set BACKBOARD_API_KEY on the server."
    if not enabled:
        return "Memory is off. Nothing new is kept and nothing is recalled."
    where = "your own Backboard account" if source == "own" else "Backboard"
    return (
        f"On. {where[0].upper()}{where[1:]} remembers the questions you ask and how your quiz answers go, "
        "feeds them into answers and grading, and the quiz starts with the topics you found hard."
    )


def _latest(own: MemoryRow | None, prefs: MemoryPrefsRow | None) -> datetime | None:
    """When the user last changed their memory setting."""
    times = [row.updated_at for row in (own, prefs) if row is not None]
    return max(times) if times else None
