import threading
from collections.abc import Iterator
from contextlib import contextmanager

from pydantic import BaseModel

from app.llm.base import Llm, LlmError, LlmRequest

# =============================================================================
# Module Overview
# =============================================================================
# Limits on calls to hosts users choose. A user's provider can answer slowly on
# purpose, and a timeout only bounds each read, not the whole call, so each
# user gets one call in flight and all users together a few. However slow those
# hosts are, they can hold at most `MAX_IN_FLIGHT` threads; the rest of the
# server keeps answering.

MAX_IN_FLIGHT = 4

_slots = threading.BoundedSemaphore(MAX_IN_FLIGHT)
_busy_users: set[str] = set()
_busy_lock = threading.Lock()


@contextmanager
def provider_slot(user_id: str) -> Iterator[None]:
    """Hold the user's single slot and one shared slot, or raise `LlmError` right away when either is taken."""
    with _busy_lock:
        if user_id in _busy_users:
            raise LlmError("rate_limited", "Your model provider is still answering an earlier request. Wait for it.")
        _busy_users.add(user_id)
    try:
        if not _slots.acquire(blocking=False):
            raise LlmError("rate_limited", "Many people are using their own providers right now. Try again shortly.")
        try:
            yield
        finally:
            _slots.release()
    finally:
        with _busy_lock:
            _busy_users.discard(user_id)


class GatedLlm:
    """An `Llm` that holds a provider slot for the length of each call."""

    def __init__(self, inner: Llm, user_id: str) -> None:
        self._inner = inner
        self._user_id = user_id

    @property
    def label(self) -> str:
        """The wrapped provider's label."""
        return self._inner.label

    def generate[T: BaseModel](self, request: LlmRequest[T]) -> T:
        """Call the wrapped provider inside the user's slot."""
        with provider_slot(self._user_id):
            return self._inner.generate(request)
