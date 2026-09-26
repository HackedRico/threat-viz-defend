from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.analysis.analyst import Analyst
from app.auth.service import Accounts, Tokens
from app.boards.service import Boards
from app.config import Settings
from app.db import Database
from app.errors import unauthorized
from app.jobs import Jobs
from app.limits import Budget, RateLimiter
from app.providers.service import Providers
from app.quiz_service import Quiz
from app.tables import UserRow
from app.voice import VoiceClient

# =============================================================================
# Module Overview
# =============================================================================
# The objects one running server shares, and the FastAPI dependencies routes
# use to reach them. `Services` is built once in `main.create_app`; tests build
# it with fakes. `CurrentUser` and `AgentUser` resolve a cookie session or a
# personal token into a user, or answer 401.


@dataclass(frozen=True)
class Services:
    """Everything a request handler may need."""

    settings: Settings
    db: Database
    limiter: RateLimiter
    budget: Budget
    analyst: Analyst
    jobs: Jobs
    accounts: Accounts
    tokens: Tokens
    boards: Boards
    quiz: Quiz
    providers: Providers
    voice: VoiceClient | None


def services(request: Request) -> Services:
    """The shared services of the app handling `request`."""
    found: Services = request.app.state.services
    return found


Svc = Annotated[Services, Depends(services)]


def db_session(svc: Svc) -> Iterator[Session]:
    """A session per request that commits when the handler succeeds."""
    with svc.db.session() as session:
        yield session


Db = Annotated[Session, Depends(db_session)]


def client_ip(request: Request, settings: Settings) -> str:
    """The caller's IP: the proxy's header when the proxy is trusted, else the socket peer."""
    if settings.trust_proxy:
        forwarded = request.headers.get(settings.client_ip_header, "").split(",")[0].strip()
        if forwarded:
            return forwarded
    return request.client.host if request.client else "unknown"


def current_user(request: Request, svc: Svc, session: Db) -> UserRow:
    """The user behind the session cookie, or 401."""
    token = request.cookies.get(svc.settings.session_cookie)
    user = svc.accounts.user_for_session(session, token) if token else None
    if user is None:
        raise unauthorized()
    return user


CurrentUser = Annotated[UserRow, Depends(current_user)]


def agent_user(request: Request, svc: Svc, session: Db) -> UserRow:
    """The user behind a `Bearer` personal token, or 401."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    user = svc.tokens.user_for_token(session, token.strip()) if scheme.lower() == "bearer" else None
    if user is None:
        raise unauthorized(
            "Send a personal token as `Authorization: Bearer tvd_...`. Create one under Connect an agent."
        )
    return user


AgentUser = Annotated[UserRow, Depends(agent_user)]
