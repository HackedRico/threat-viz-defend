from sqlalchemy.orm import Session

from app.config import Settings
from app.db import Database, utcnow
from app.errors import bad_request
from app.llm.backboard import BackboardApi
from app.llm.base import LlmError
from app.memory import BackboardMemory, Memory
from app.providers.secrets_box import SecretBox
from app.schemas import MemoryIn, MemoryOut, MemoryTestOut
from app.tables import MemoryRow, ProviderRow

# =============================================================================
# Module Overview
# =============================================================================
# A user's Backboard memory setting: one key, sealed like a provider key, and
# the assistant Backboard holds their notes in. Memory rides on the user's own
# OpenAI-compatible provider. The server's default model does not use it, and
# a Backboard provider already brings its own memory, so it stays off there.
# Backboard is a fixed host (`BACKBOARD_BASE_URL`), so no user URL is involved.

# Memory is a side call around the real work, so it gets far less time than a model.
_TIMEOUT_S = 15.0
# The sealed key's owner string differs from a provider key's, so one cannot be swapped in for the other.
_SEAL_SCOPE = "memory:"


class MemorySettings:
    """Saved per-user Backboard memory, and the `Memory` it gives the analyst."""

    def __init__(self, db: Database, settings: Settings) -> None:
        self._db = db
        self._base_url = settings.backboard_base_url
        self._box = SecretBox(settings.app_secret)

    def view(self, session: Session, user_id: str) -> MemoryOut:
        """Whether memory is saved and applies now, without the key."""
        row = session.get(MemoryRow, user_id)
        provider = session.get(ProviderRow, user_id)
        active, message = _status(row, provider)
        return MemoryOut(
            saved=row is not None,
            active=active,
            key_preview=f"...{row.key_last4}" if row is not None else None,
            message=message,
            updated_at=row.updated_at if row is not None else None,
        )

    def save(self, session: Session, user_id: str, body: MemoryIn) -> MemoryOut:
        """Save the key, keeping the stored one when `api_key` is null."""
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
        """Stop using memory and forget the key. Notes already kept stay in the user's Backboard account."""
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

    def for_user(self, user_id: str) -> Memory | None:
        """The user's memory, or `None` when they saved none."""
        with self._db.session() as session:
            row = session.get(MemoryRow, user_id)
            if row is None:
                return None
            sealed, assistant = row.key_sealed, row.assistant_id
        try:
            key = self._box.open(sealed, _SEAL_SCOPE + user_id)
        except ValueError:
            # A key sealed under an old secret cannot be used; answers still work without memory.
            return None

        def remember(assistant_id: str) -> None:
            with self._db.session() as session:
                found = session.get(MemoryRow, user_id)
                if found is not None:
                    found.assistant_id = assistant_id

        return BackboardMemory(self._api(key), assistant_id=assistant, on_assistant=remember)

    def _saved_key(self, user_id: str) -> str | None:
        """The stored key, opened, or `None` when there is none."""
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
        return BackboardApi(api_key=key, base_url=self._base_url, label="Backboard memory", timeout_s=_TIMEOUT_S)


def _status(row: MemoryRow | None, provider: ProviderRow | None) -> tuple[bool, str]:
    """Whether saved memory applies to the user's analyses, and why not when it does not."""
    if row is None:
        return False, "Memory is off."
    if provider is None:
        return False, "Saved, but memory only works with your own model. Add one under Model provider."
    if provider.kind == "backboard":
        return False, "Saved, but your Backboard provider has its own memory setting, so this one is not used."
    return True, "Answers and quiz grading remember your progress."
