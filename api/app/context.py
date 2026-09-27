import ipaddress
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
from app.providers.memory import MemorySettings
from app.providers.service import Providers
from app.quiz_service import Quiz
from app.tables import UserRow
from app.voice import Transcriber, VoiceClient

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
    memory: MemorySettings
    voice: VoiceClient | None
    transcriber: Transcriber | None


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
    """The caller's network for rate limits: the proxy's header when trusted, else the socket peer."""
    address = request.client.host if request.client else "unknown"
    if settings.trust_proxy:
        forwarded = request.headers.get(settings.client_ip_header, "").split(",")[0].strip()
        if forwarded:
            address = forwarded
    return network_key(address)


def web_app_origin(request: Request | None, settings: Settings) -> str:
    """Where the web app lives, for links to boards: the configured origin, else the one `request` came to."""
    if settings.web_origin or request is None:
        return settings.web_origin
    # Only local runs get here, since production requires `PUBLIC_ORIGIN`. `RequestGuard` has already refused
    # any host outside `ALLOWED_HOSTS`, so the link cannot name someone else's site.
    return f"{request.url.scheme}://{request.url.netloc}"


def network_key(address: str) -> str:
    """An IPv4 address as is, an IPv6 address as its /64, since one client holds a whole /64."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return address
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


def current_user(request: Request, svc: Svc, session: Db) -> UserRow:
    """The user behind the session cookie, or 401."""
    token = request.cookies.get(svc.settings.session_cookie)
    user = svc.accounts.user_for_session(session, token) if token else None
    if user is None:
        raise unauthorized()
    _commit_touch(session)
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
    _commit_touch(session)
    return user


def _commit_touch(session: Session) -> None:
    """Commit a refreshed `last_seen_at` or `last_used_at` now, so the request holds no lock or connection."""
    # Left pending, the next query flushes it and SQLite keeps its one write lock until the request ends,
    # so a service that opens its own session, as `Boards._begin` does, waits out `busy_timeout` and fails.
    # Committing also returns the connection to the pool while a route waits on a model; later queries take one again.
    session.commit()


AgentUser = Annotated[UserRow, Depends(agent_user)]
