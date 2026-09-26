from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import DateTime, Engine, create_engine, event
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.types import TypeDecorator

# =============================================================================
# Module Overview
# =============================================================================
# The database handle. `Database` owns the engine and hands out sessions that
# commit on success and roll back on error. SQLite serves development and
# tests; Postgres serves production. `UtcDateTime` stores naive UTC and reads
# back aware UTC, so both engines compare times the same way.


def utcnow() -> datetime:
    """The current time, timezone aware, in UTC."""
    return datetime.now(UTC)


class UtcDateTime(TypeDecorator[datetime]):
    """A timestamp column that always round-trips as aware UTC."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        """Store naive UTC; SQLite drops offsets, so every engine gets the same form."""
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("Store aware datetimes only; use `utcnow()`.")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        """Read naive UTC back as aware UTC."""
        return None if value is None else value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    """Base class for every table."""


class Database:
    """An engine plus a session factory."""

    def __init__(self, url: str) -> None:
        options: dict[str, Any] = {"pool_pre_ping": True}
        if url.startswith("sqlite"):
            options = {"connect_args": {"check_same_thread": False}}
            if url in ("sqlite://", "sqlite:///:memory:"):
                # One shared connection keeps an in-memory database alive across sessions and threads.
                options["poolclass"] = StaticPool
            else:
                Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
        self.engine: Engine = create_engine(url, **options)
        if url.startswith("sqlite"):
            event.listen(self.engine, "connect", _sqlite_pragmas)
        self._sessions = sessionmaker(self.engine, expire_on_commit=False)

    def create_tables(self) -> None:
        """Create any missing tables; existing tables are left as they are."""
        # Importing registers every table on `Base.metadata`.
        from app import tables  # noqa: F401

        Base.metadata.create_all(self.engine)

    @contextmanager
    def session(self) -> Iterator[Session]:
        """A session that commits when the block succeeds and rolls back when it raises."""
        session = self._sessions()
        try:
            yield session
            session.commit()
        except BaseException:
            session.rollback()
            raise
        finally:
            session.close()


def _sqlite_pragmas(connection: Any, _record: Any) -> None:
    """Enforce foreign keys and let readers work while a writer commits."""
    cursor = connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()
