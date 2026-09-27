import math
import threading
import time
from collections import deque
from collections.abc import Callable
from datetime import datetime
from datetime import time as dtime
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.errors import AppError, too_many
from app.tables import UsageRow

# =============================================================================
# Module Overview
# =============================================================================
# Abuse controls. `RateLimiter` counts hits per key in a sliding window, in
# memory, which fits the single instance this app runs as. `Budget` meters the
# expensive things, model calls, voice sessions and dictations, per user per
# UTC day and across all users, and records each spend in the `usage` table.

UsageKind = Literal["model", "voice", "dictation"]

_NOUNS: dict[UsageKind, str] = {"model": "model requests", "voice": "voice sessions", "dictation": "dictations"}

_MAX_KEYS = 50_000


class RateLimiter:
    """Sliding-window counters keyed by strings such as `login-ip:1.2.3.4`."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        # Pruning by the caller's window would drop keys with longer windows, such as a login lockout.
        self._longest_window_s = 0.0

    def hit(self, key: str, limit: int, window_s: float, message: str) -> None:
        """Count one hit on `key`, raising 429 with `message` once `limit` hits land inside `window_s`."""
        now = self._clock()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= now - window_s:
                hits.popleft()
            if len(hits) >= limit:
                raise too_many(message, math.ceil(hits[0] + window_s - now))
            hits.append(now)
            self._longest_window_s = max(self._longest_window_s, window_s)
            if len(self._hits) > _MAX_KEYS:
                self._prune(now, self._longest_window_s)

    def count(self, key: str, window_s: float) -> int:
        """How many hits `key` has inside the window, without adding one."""
        now = self._clock()
        with self._lock:
            return sum(1 for t in self._hits.get(key, ()) if t > now - window_s)

    def undo(self, key: str) -> None:
        """Take back the latest hit on `key`, for a slot reserved before an outcome that turned out fine."""
        with self._lock:
            hits = self._hits.get(key)
            if hits:
                hits.pop()

    def reset(self, key: str) -> None:
        """Forget every hit on `key`, as after a successful login."""
        with self._lock:
            self._hits.pop(key, None)

    def _prune(self, now: float, window_s: float) -> None:
        """Drop keys with no recent hits so a flood of distinct keys cannot grow memory without bound."""
        stale = [key for key, hits in self._hits.items() if not hits or hits[-1] <= now - window_s]
        for key in stale:
            del self._hits[key]


class Budget:
    """Daily allowances for model calls, voice sessions and dictations, per user and overall."""

    def __init__(self, settings: Settings, limiter: RateLimiter) -> None:
        self._settings = settings
        self._limiter = limiter

    def spend(self, session: Session, user_id: str, kind: UsageKind, task: str, *, own_key: bool = False) -> None:
        """Record one use of `kind` by `user_id`, or raise 429 when a limit is reached.

        Calls on the user's own provider key cost the server nothing, so only the per-minute limit applies.
        """
        per_user, overall = self._limits(kind)
        if kind == "voice":
            # The count below cannot see spends still uncommitted in parallel requests, so a burst is capped here.
            self._limiter.hit(
                f"voice-minute:{user_id}", 2, 60, "Voice sessions are starting very quickly. Wait a minute."
            )
        if kind == "model":
            self._limiter.hit(
                f"model-minute:{user_id}",
                self._settings.model_calls_per_minute,
                60,
                "You are asking the model very quickly. Wait a moment and try again.",
            )
        if own_key and kind == "model":
            session.add(UsageRow(user_id=user_id, kind="own_model", task=task))
            session.flush()
            return
        since = _start_of_day()
        mine = self._count(session, kind, since, user_id)
        if mine >= per_user:
            raise AppError(
                429,
                "budget_exhausted",
                f"You have used today's {per_user} {_NOUNS[kind]}. The allowance resets at midnight UTC.",
                headers={"Retry-After": str(_seconds_to_midnight())},
            )
        if self._count(session, kind, since, None) >= overall:
            raise AppError(
                429,
                "budget_exhausted",
                "The app has reached its shared daily limit. Try again after midnight UTC.",
                headers={"Retry-After": str(_seconds_to_midnight())},
            )
        session.add(UsageRow(user_id=user_id, kind=kind, task=task))
        session.flush()

    def used_today(self, session: Session, user_id: str, kind: UsageKind) -> int:
        """How many times `user_id` used `kind` since midnight UTC."""
        return self._count(session, kind, _start_of_day(), user_id)

    def _limits(self, kind: UsageKind) -> tuple[int, int]:
        """The per-user and overall daily limits for `kind`."""
        if kind == "model":
            return self._settings.daily_model_calls, self._settings.global_daily_model_calls
        # Voice and dictation have no separate overall cap; the ElevenLabs plan's own credits are the ceiling.
        if kind == "voice":
            return self._settings.daily_voice_sessions, 10**9
        return self._settings.daily_dictations, 10**9

    @staticmethod
    def _count(session: Session, kind: UsageKind, since: datetime, user_id: str | None) -> int:
        """Count usage rows of `kind` since `since`, for one user or for everyone."""
        query = select(func.count()).select_from(UsageRow).where(UsageRow.kind == kind, UsageRow.created_at >= since)
        if user_id is not None:
            query = query.where(UsageRow.user_id == user_id)
        return int(session.scalar(query) or 0)


def _start_of_day() -> datetime:
    """Midnight UTC today."""
    now = utcnow()
    return datetime.combine(now.date(), dtime(0), tzinfo=now.tzinfo)


def _seconds_to_midnight() -> int:
    """Seconds until the daily allowances reset."""
    now = utcnow()
    return max(1, 86_400 - (now.hour * 3600 + now.minute * 60 + now.second))
