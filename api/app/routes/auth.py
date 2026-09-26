from fastapi import APIRouter, Request, Response, status

from app.auth.service import SignedIn
from app.context import CurrentUser, Db, Svc, client_ip
from app.schemas import LoginIn, MeOut, SignupIn, TokenCreate, TokenCreated, TokenOut, UsageOut, UserOut
from app.tables import ApiTokenRow, UserRow

# =============================================================================
# Module Overview
# =============================================================================
# Account routes: sign up with an invite code, sign in and out, who am I, and
# the personal tokens coding agents use. The session lives in an HttpOnly,
# SameSite=Lax cookie that scripts cannot read.

router = APIRouter(prefix="/api", tags=["auth"])


@router.post("/auth/signup", status_code=status.HTTP_201_CREATED)
def signup(body: SignupIn, request: Request, response: Response, svc: Svc, session: Db) -> MeOut:
    """Create an account with the event's invite code, add the example board, and sign in."""
    signed_in = svc.accounts.signup(
        session,
        username=body.username,
        password=body.password,
        invite_code=body.invite_code,
        honeypot=body.website,
        ip=client_ip(request, svc.settings),
    )
    svc.boards.add_example(session, signed_in.user.id)
    _set_cookie(response, svc, signed_in)
    return _me(svc, session, signed_in.user)


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response, svc: Svc, session: Db) -> MeOut:
    """Sign in with a username and password."""
    signed_in = svc.accounts.login(
        session, username=body.username, password=body.password, ip=client_ip(request, svc.settings)
    )
    _set_cookie(response, svc, signed_in)
    return _me(svc, session, signed_in.user)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response, svc: Svc, session: Db) -> None:
    """End this browser's session."""
    token = request.cookies.get(svc.settings.session_cookie)
    if token:
        svc.accounts.logout(session, token)
    response.delete_cookie(
        svc.settings.session_cookie,
        path="/",
        secure=svc.settings.cookie_secure,
        httponly=True,
        samesite=svc.settings.cookie_samesite,
    )


@router.get("/auth/me")
def me(user: CurrentUser, svc: Svc, session: Db) -> MeOut:
    """The signed-in user and today's usage."""
    return _me(svc, session, user)


@router.get("/tokens")
def list_tokens(user: CurrentUser, svc: Svc, session: Db) -> list[TokenOut]:
    """The user's personal tokens, without their secrets."""
    return [_token_out(row) for row in svc.tokens.all_for(session, user.id)]


@router.post("/tokens", status_code=status.HTTP_201_CREATED)
def create_token(body: TokenCreate, user: CurrentUser, svc: Svc, session: Db) -> TokenCreated:
    """Create a personal token; its secret is in this response only."""
    row, secret = svc.tokens.create(session, user.id, body.name)
    return TokenCreated(token=secret, info=_token_out(row))


@router.delete("/tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_token(token_id: str, user: CurrentUser, svc: Svc, session: Db) -> None:
    """Revoke a personal token."""
    svc.tokens.revoke(session, user.id, token_id)


def _set_cookie(response: Response, svc: Svc, signed_in: SignedIn) -> None:
    """Put the session secret in an HttpOnly cookie scripts cannot read."""
    response.set_cookie(
        svc.settings.session_cookie,
        signed_in.session_token,
        max_age=svc.settings.session_days * 86_400,
        path="/",
        secure=svc.settings.cookie_secure,
        httponly=True,
        samesite=svc.settings.cookie_samesite,
    )


def _me(svc: Svc, session: Db, user: UserRow) -> MeOut:
    """The user and their usage today."""
    settings = svc.settings
    return MeOut(
        user=UserOut(id=user.id, username=user.username, created_at=user.created_at),
        usage=UsageOut(
            model_calls_today=svc.budget.used_today(session, user.id, "model"),
            model_calls_limit=settings.daily_model_calls,
            voice_sessions_today=svc.budget.used_today(session, user.id, "voice"),
            voice_sessions_limit=settings.daily_voice_sessions,
            dictations_today=svc.budget.used_today(session, user.id, "dictation"),
            dictations_limit=settings.daily_dictations,
        ),
    )


def _token_out(row: ApiTokenRow) -> TokenOut:
    """A token without its secret."""
    return TokenOut(
        id=row.id, name=row.name, prefix=row.prefix, created_at=row.created_at, last_used_at=row.last_used_at
    )
