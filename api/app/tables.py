from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UtcDateTime, utcnow

# =============================================================================
# Module Overview
# =============================================================================
# Every table. Rows hold data only; the services in `auth`, `boards` and `quiz`
# own the rules for changing them. JSON columns hold validated domain values:
# a board's map and analysis are dumped from `SystemMap` and `ThreatAnalysis`
# and validated again when read.

_CASCADE = "CASCADE"


class UserRow(Base):
    """An account."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class LoginSessionRow(Base):
    """A signed-in browser. Only a hash of the cookie value is stored."""

    __tablename__ = "login_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete=_CASCADE), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    last_seen_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class ApiTokenRow(Base):
    """A personal token a coding agent uses. Only a hash is stored; the token is shown once."""

    __tablename__ = "api_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete=_CASCADE), index=True)
    name: Mapped[str] = mapped_column(String(60))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    prefix: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class BoardRow(Base):
    """One system's threat model: its sources, map, analysis and status."""

    __tablename__ = "boards"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete=_CASCADE), index=True)
    title: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(16), default="empty")
    example: Mapped[bool] = mapped_column(Boolean, default=False)
    sources: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    map: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    # The map before the latest update, so a review can show what changed.
    previous_map: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    analysis: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    analysis_version: Mapped[int] = mapped_column(Integer, default=0)
    analyzed_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Bumped on every save, so a browser can tell when to refetch.
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class BoardEventRow(Base):
    """A line in a board's activity log: material added, an agent change, a confirmation."""

    __tablename__ = "board_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    board_id: Mapped[str] = mapped_column(ForeignKey("boards.id", ondelete=_CASCADE), index=True)
    kind: Mapped[str] = mapped_column(String(24))
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class QuizAttemptRow(Base):
    """One answer to one quiz question."""

    __tablename__ = "quiz_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete=_CASCADE), index=True)
    board_id: Mapped[str] = mapped_column(ForeignKey("boards.id", ondelete=_CASCADE), index=True)
    # Questions are rebuilt from each analysis, so attempts only count for the version they answered.
    analysis_version: Mapped[int] = mapped_column(Integer)
    question_id: Mapped[str] = mapped_column(String(80))
    answer: Mapped[dict[str, Any]] = mapped_column(JSON)
    result: Mapped[str] = mapped_column(String(10))
    feedback: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class UsageRow(Base):
    """One spend of a metered resource, for daily budgets and an audit trail."""

    __tablename__ = "usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete=_CASCADE), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    task: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)
