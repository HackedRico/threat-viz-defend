import hashlib
import hmac
import logging
import re
import secrets
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.errors import AppError, bad_request, conflict, forbidden, not_found, too_many, unauthorized
from app.limits import RateLimiter
from app.tables import ApiTokenRow, LoginSessionRow, UserRow

# =============================================================================
# Module Overview
# =============================================================================
# Account rules. `Accounts.signup` admits only holders of an invite code, and
# `Accounts.login` locks a username after repeated failures. Sessions and
# personal tokens are random secrets of which only a SHA-256 hash is stored,
# so a database leak cannot be replayed. Passwords are hashed with argon2id.

log = logging.getLogger(__name__)

USERNAME = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,23}$")
# A recognizable prefix lets secret scanners and our own masking spot leaked tokens.
TOKEN_PREFIX = "tvd_"  # noqa: S105
MAX_TOKENS_PER_USER = 10

_hasher = PasswordHasher()
# Verifying against a throwaway hash when the username is unknown keeps both paths equally slow,
# so response time does not reveal which usernames exist.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))
# Each argon2id hash takes 64 MiB; two at a time keeps a burst of sign ins from exhausting memory.
_HASH_SLOTS = threading.BoundedSemaphore(2)
_HASH_WAIT_S = 5.0
_COMMON_PASSWORDS = frozenset({"password12", "password123", "1234567890", "qwertyuiop", "letmein123", "iloveyou12"})


def hash_secret(secret: str) -> str:
    """The SHA-256 hex digest under which a session or token secret is stored."""
    return hashlib.sha256(secret.encode()).hexdigest()


@dataclass(frozen=True)
class SignedIn:
    """A user and the fresh session secret to put in their cookie."""

    user: UserRow
    session_token: str


class Accounts:
    """Sign up, sign in, sign out and session lookup."""

    def __init__(self, settings: Settings, limiter: RateLimiter) -> None:
        self._settings = settings
        self._limiter = limiter

    def signup(
        self, session: Session, *, username: str, password: str, invite_code: str, honeypot: str, ip: str
    ) -> SignedIn:
        """Create an account for an invite code holder and sign them in."""
        # Everyone at a venue can share one public IP, so per-IP limits stay loose; the invite code is the gate.
        self._limiter.hit(f"signup-ip:{ip}", 60, 3600, "Too many sign ups from this network. Try again in an hour.")
        if honeypot:
            log.warning("[auth] Signup honeypot filled from %s; rejecting.", ip)
            raise bad_request("Sign up failed. Reload the page and try again.")
        name = username.strip().lower()
        if not USERNAME.match(name):
            raise bad_request("Usernames are 3 to 24 characters: letters, digits, dots, dashes and underscores.")
        self._check_invite(invite_code, ip)
        if password.lower() in _COMMON_PASSWORDS or name in password.lower():
            raise bad_request("Pick a less guessable password, one that does not contain your username.")
        if session.scalar(select(UserRow.id).where(UserRow.username == name)) is not None:
            raise conflict("That username is taken. Pick another.")
        count = session.scalar(select(func.count()).select_from(UserRow)) or 0
        if count >= self._settings.max_users:
            raise forbidden("Sign ups are closed: this server has reached its account limit.")
        user = UserRow(id=str(uuid.uuid4()), username=name, password_hash=_hash(password))
        session.add(user)
        session.flush()
        log.info("[auth] New account %s.", name)
        return SignedIn(user, self._open_session(session, user))

    def _check_invite(self, invite_code: str, ip: str) -> None:
        """Refuse a wrong invite code, and any code at all from a network, or a server, that has guessed too often."""
        guessing = "Too many wrong invite codes. Try again in an hour."
        per_network, overall = f"invite-fail:{ip}", "invite-fail:all"
        # A failure is reserved before the code is judged, as sign in does, so a network past its limit is refused
        # even the right code, and parallel guesses cannot all slip under a count taken before any of them failed.
        # The overall limit stops rotating addresses from guessing without end.
        self._limiter.hit(per_network, 20, 3600, guessing)
        try:
            self._limiter.hit(overall, 300, 3600, guessing)
        except AppError:
            self._limiter.undo(per_network)
            raise
        if not self._invite_ok(invite_code):
            raise forbidden("That invite code is not valid. Ask whoever runs this server for the current code.")
        self._limiter.undo(overall)
        self._limiter.undo(per_network)

    def ensure_account(self, session: Session, username: str, password: str) -> UserRow:
        """Create `username` with `password`, or reset an existing one to it; for admins and development only."""
        name = username.strip().lower()
        if not USERNAME.match(name):
            raise bad_request("Usernames are 3 to 24 characters: letters, digits, dots, dashes and underscores.")
        if len(password) < 10:
            raise bad_request("Passwords need 10 or more characters.")
        user = session.scalar(select(UserRow).where(UserRow.username == name))
        if user is None:
            user = UserRow(id=str(uuid.uuid4()), username=name, password_hash=_hash(password))
            session.add(user)
        elif not _verify(user.password_hash, password):
            user.password_hash = _hash(password)
            # A reset is often a response to a compromise, so every existing session and token ends.
            session.execute(delete(LoginSessionRow).where(LoginSessionRow.user_id == user.id))
            session.execute(delete(ApiTokenRow).where(ApiTokenRow.user_id == user.id))
        session.flush()
        return user

    def login(self, session: Session, *, username: str, password: str, ip: str) -> SignedIn:
        """Check a username and password, with per-network and per-username limits."""
        name = username.strip().lower()
        self._limiter.hit(
            f"login-ip:{ip}", 150, 300, "Too many sign in attempts from this network. Wait a few minutes."
        )
        if not USERNAME.match(name):
            # No account can have such a name, so there is nothing to hide by timing, and a colon in one would reach
            # into another account's lockout key below.
            raise unauthorized("Wrong username or password.")
        # Locking by username alone would let anyone lock anyone out, so the tight limit is per network
        # and a looser one per username still stops a distributed guess.
        failures = f"login-fail:{name}:{ip}"
        spread = f"login-fail:{name}"
        # Each attempt reserves a failure before the slow password check, so parallel guesses cannot all
        # pass a count taken before any of them failed; a right password gives its reservation back.
        locked = "Too many failed sign ins for this account. Try again in 15 minutes."
        try:
            self._limiter.hit(failures, 5, 900, locked)
        except AppError:
            raise too_many(locked, 900) from None
        try:
            self._limiter.hit(spread, 50, 900, locked)
        except AppError:
            self._limiter.undo(failures)
            raise too_many(locked, 900) from None
        try:
            user = session.scalar(select(UserRow).where(UserRow.username == name))
            matched = user is not None and _verify(user.password_hash, password)
            if user is None:
                _verify(_DUMMY_HASH, password)
        except Exception:
            # A busy hash slot or a database error says nothing about the password, so it is not a failure.
            self._limiter.undo(spread)
            self._limiter.undo(failures)
            raise
        if user is None or not matched:
            raise unauthorized("Wrong username or password.")
        self._limiter.undo(spread)
        self._limiter.reset(failures)
        if user.disabled:
            raise forbidden("This account is disabled. Ask whoever runs this server.")
        if _hasher.check_needs_rehash(user.password_hash):
            user.password_hash = _hash(password)
        user.last_login_at = utcnow()
        return SignedIn(user, self._open_session(session, user))

    def logout(self, session: Session, token: str) -> None:
        """End the session behind `token`, if it exists."""
        row = session.get(LoginSessionRow, hash_secret(token))
        if row is not None:
            session.delete(row)

    def user_for_session(self, session: Session, token: str) -> UserRow | None:
        """The active user behind a session cookie, or `None` when it is unknown, expired or disabled."""
        row = session.get(LoginSessionRow, hash_secret(token))
        now = utcnow()
        if row is None or row.expires_at <= now:
            return None
        user = session.get(UserRow, row.user_id)
        if user is None or user.disabled:
            return None
        # Writing on every request would serialize reads on SQLite; five minutes is precise enough.
        if now - row.last_seen_at > timedelta(minutes=5):
            row.last_seen_at = now
        return user

    def _invite_ok(self, code: str) -> bool:
        """True when `code` matches a configured invite code, compared in constant time."""
        given = code.strip().encode()
        return any(hmac.compare_digest(given, known.encode()) for known in self._settings.invite_codes)

    def _open_session(self, session: Session, user: UserRow) -> str:
        """Store a new session for `user` and return its secret."""
        token = secrets.token_urlsafe(32)
        now = utcnow()
        session.add(
            LoginSessionRow(
                token_hash=hash_secret(token),
                user_id=user.id,
                created_at=now,
                last_seen_at=now,
                expires_at=now + timedelta(days=self._settings.session_days),
            )
        )
        return token


class Tokens:
    """Personal tokens that let a coding agent act for one user."""

    def __init__(self, limiter: RateLimiter) -> None:
        self._limiter = limiter

    def create(self, session: Session, user_id: str, name: str) -> tuple[ApiTokenRow, str]:
        """Create a token and return its row and its secret, which is never shown again."""
        self._limiter.hit(f"token-create:{user_id}", 10, 3600, "Too many new tokens. Try again in an hour.")
        count = session.scalar(select(func.count()).select_from(ApiTokenRow).where(ApiTokenRow.user_id == user_id))
        if (count or 0) >= MAX_TOKENS_PER_USER:
            raise conflict(f"You have {MAX_TOKENS_PER_USER} tokens. Revoke one you no longer use first.")
        secret = TOKEN_PREFIX + secrets.token_urlsafe(32)
        row = ApiTokenRow(
            id=str(uuid.uuid4()), user_id=user_id, name=name.strip(), token_hash=hash_secret(secret), prefix=secret[:10]
        )
        session.add(row)
        session.flush()
        return row, secret

    def all_for(self, session: Session, user_id: str) -> list[ApiTokenRow]:
        """The user's tokens, newest first."""
        query = select(ApiTokenRow).where(ApiTokenRow.user_id == user_id).order_by(ApiTokenRow.created_at.desc())
        return list(session.scalars(query))

    def revoke(self, session: Session, user_id: str, token_id: str) -> None:
        """Delete one of the user's tokens."""
        row = session.get(ApiTokenRow, token_id)
        if row is None or row.user_id != user_id:
            raise not_found("That token does not exist. It may already be revoked.")
        session.delete(row)

    def user_for_token(self, session: Session, secret: str) -> UserRow | None:
        """The active user a token belongs to, or `None`."""
        if not secret.startswith(TOKEN_PREFIX):
            return None
        row = session.scalar(select(ApiTokenRow).where(ApiTokenRow.token_hash == hash_secret(secret)))
        if row is None:
            return None
        user = session.get(UserRow, row.user_id)
        if user is None or user.disabled:
            return None
        now = utcnow()
        if row.last_used_at is None or now - row.last_used_at > timedelta(minutes=5):
            row.last_used_at = now
        return user


@contextmanager
def _hash_slot() -> Iterator[None]:
    """Hold one of the few argon2 slots, or answer 503 when the server is busy hashing."""
    if not _HASH_SLOTS.acquire(timeout=_HASH_WAIT_S):
        raise AppError(503, "rate_limited", "Sign in is busy right now. Try again in a few seconds.")
    try:
        yield
    finally:
        _HASH_SLOTS.release()


def _hash(password: str) -> str:
    """Hash a password with argon2id inside a slot."""
    with _hash_slot():
        return _hasher.hash(password)


def _verify(password_hash: str, password: str) -> bool:
    """True when `password` matches `password_hash`."""
    try:
        with _hash_slot():
            return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def require_user(user: UserRow | None) -> UserRow:
    """Raise 401 unless a user is signed in."""
    if user is None:
        raise unauthorized()
    return user
