import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlparse

from app.llm.base import JsonMode

# =============================================================================
# Module Overview
# =============================================================================
# Server settings, read once from the environment into a frozen `Settings`.
# `load_settings` validates everything up front, so a misconfigured deploy
# fails at startup with a message naming the variable to fix. `.env.example`
# at the repo root documents every variable.

log = logging.getLogger(__name__)

Environment = Literal["development", "production", "test"]
SameSite = Literal["lax", "strict", "none"]

_API_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_STATIC = _API_ROOT.parent / "web" / "dist"
_DEV_INVITE = "local-dev"
# Only for development and tests: production refuses to start without its own `APP_SECRET`.
_DEV_SECRET = "development-only-secret-never-use-in-production"  # noqa: S105


@dataclass(frozen=True)
class Settings:
    """Everything the server reads from its environment."""

    app_name: str = "ThreatViz Defend"
    environment: Environment = "development"
    database_url: str = f"sqlite:///{_API_ROOT / 'data' / 'app.db'}"
    public_origin: str | None = None
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "testserver")
    trust_proxy: bool = False
    client_ip_header: str = "do-connecting-ip"
    cookie_secure: bool = False
    cookie_samesite: SameSite = "lax"
    cors_origins: tuple[str, ...] = ()
    app_secret: str = _DEV_SECRET
    allow_private_provider_urls: bool = True
    backboard_base_url: str = "https://app.backboard.io/api"
    # The server's Backboard key: memory for every user who has not turned it off or brought their own key.
    backboard_api_key: str | None = None
    session_days: int = 7
    invite_codes: tuple[str, ...] = (_DEV_INVITE,)
    max_users: int = 300
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_json_mode: JsonMode = "json_schema"
    llm_timeout_s: float = 120.0
    llm_max_tokens: int | None = 16_384
    daily_model_calls: int = 60
    model_calls_per_minute: int = 6
    global_daily_model_calls: int = 3000
    daily_voice_sessions: int = 10
    daily_dictations: int = 30
    # A ready-made account for local development; refused in production.
    dev_username: str | None = None
    dev_password: str | None = None
    elevenlabs_api_key: str | None = None
    elevenlabs_agent_id: str | None = None
    elevenlabs_stt_model: str = "scribe_v2"
    static_dir: Path | None = field(default=_DEFAULT_STATIC if _DEFAULT_STATIC.is_dir() else None)

    @property
    def production(self) -> bool:
        """True when running for real users."""
        return self.environment == "production"

    @property
    def llm_configured(self) -> bool:
        """True when a real model is set up; otherwise the demo analyst runs."""
        return bool(self.llm_api_key and self.llm_model)

    @property
    def voice_configured(self) -> bool:
        """True when the ElevenLabs agent can be reached."""
        return bool(self.elevenlabs_api_key and self.elevenlabs_agent_id)

    @property
    def dictation_configured(self) -> bool:
        """True when questions can be spoken: an ElevenLabs key and a daily allowance above zero."""
        return bool(self.elevenlabs_api_key) and self.daily_dictations > 0

    @property
    def session_cookie(self) -> str:
        """Cookie name; the `__Host-` prefix pins it to this exact host over HTTPS."""
        return "__Host-tvd_session" if self.cookie_secure else "tvd_session"

    @property
    def web_origin(self) -> str:
        """Where the web app lives, for links sent to coding agents: the first CORS origin, else this server."""
        return self.cors_origins[0] if self.cors_origins else (self.public_origin or "")

    @property
    def trusted_origins(self) -> tuple[str, ...]:
        """Browser origins allowed to call the API with the user's cookie."""
        own = (self.public_origin,) if self.public_origin else ()
        return own + self.cors_origins


def load_settings(env: Mapping[str, str]) -> Settings:
    """Read and validate settings from `env`, raising `ValueError` that names the variable to fix."""
    environment = _choice(env, "APP_ENV", ("development", "production", "test"), "development")
    production = environment == "production"

    public_origin = _text(env, "PUBLIC_ORIGIN")
    if public_origin is not None:
        public_origin = _origin(public_origin, "PUBLIC_ORIGIN")
    if production and (public_origin is None or not public_origin.startswith("https://")):
        raise ValueError("Set `PUBLIC_ORIGIN` to this API's own https URL, such as `https://api.example.com`.")

    hosts = list(_list(env, "ALLOWED_HOSTS"))
    if public_origin is not None:
        hosts.append(urlparse(public_origin).hostname or "")
    if not production:
        hosts += ["localhost", "127.0.0.1", "testserver"]

    invites = _list(env, "INVITE_CODES")
    if not invites and not production:
        invites = (_DEV_INVITE,)
        log.info("[config] No `INVITE_CODES`; development signups use the code %r.", _DEV_INVITE)
    if not invites:
        log.warning("[config] `INVITE_CODES` is empty, so nobody can sign up.")
    if any(len(code) < 6 for code in invites) and production:
        raise ValueError("Every code in `INVITE_CODES` needs 6 characters or more in production.")

    database_url = _database_url(_text(env, "DATABASE_URL") or Settings.database_url)
    if production and database_url.startswith("sqlite"):
        log.warning("[config] Production is using SQLite; on hosts with ephemeral disks every deploy erases it.")

    base_url = _text(env, "LLM_BASE_URL")
    default_mode: JsonMode = "json_schema" if base_url is None or "api.openai.com" in base_url else "prompt"
    json_mode = cast(JsonMode, _choice(env, "LLM_JSON_MODE", ("json_schema", "json_object", "prompt"), default_mode))

    cors = tuple(_origin(o, "CORS_ORIGINS") for o in _list(env, "CORS_ORIGINS"))
    if production and any(not o.startswith("https://") for o in cors):
        raise ValueError("Every origin in `CORS_ORIGINS` must be https in production.")
    samesite = cast(SameSite, _choice(env, "COOKIE_SAMESITE", ("lax", "strict", "none"), "lax"))
    cookie_secure = _flag(env, "COOKIE_SECURE", default=production)
    if samesite == "none" and not cookie_secure:
        raise ValueError("`COOKIE_SAMESITE=none` needs `COOKIE_SECURE=true`; browsers drop the cookie otherwise.")

    app_secret = _text(env, "APP_SECRET")
    if app_secret is None:
        if production:
            raise ValueError("Set `APP_SECRET` to 32 or more random characters; it encrypts saved API keys.")
        app_secret = _DEV_SECRET
    if len(app_secret) < 32:
        raise ValueError("`APP_SECRET` must be at least 32 characters.")

    dev_username, dev_password = _text(env, "DEV_USERNAME"), _text(env, "DEV_PASSWORD")
    if production and (dev_username or dev_password):
        raise ValueError("`DEV_USERNAME` and `DEV_PASSWORD` are for local development; remove them in production.")
    if bool(dev_username) != bool(dev_password):
        raise ValueError("Set both `DEV_USERNAME` and `DEV_PASSWORD`, or neither.")
    if dev_password is not None and len(dev_password) < 10:
        raise ValueError("`DEV_PASSWORD` needs 10 or more characters.")

    static = _text(env, "STATIC_DIR")
    static_dir = Path(static).resolve() if static else Settings().static_dir
    if static and not (static_dir and static_dir.is_dir()):
        raise ValueError(f"`STATIC_DIR` points at `{static}`, which is not a folder. Build the web app first.")

    return Settings(
        app_name=_text(env, "APP_NAME") or Settings.app_name,
        environment=cast(Environment, environment),
        database_url=database_url,
        public_origin=public_origin,
        allowed_hosts=tuple(dict.fromkeys(h for h in hosts if h)),
        trust_proxy=_flag(env, "TRUST_PROXY", default=False),
        client_ip_header=(_text(env, "CLIENT_IP_HEADER") or Settings.client_ip_header).lower(),
        cookie_secure=cookie_secure,
        cookie_samesite=samesite,
        cors_origins=cors,
        app_secret=app_secret,
        allow_private_provider_urls=_flag(env, "ALLOW_PRIVATE_PROVIDER_URLS", default=not production),
        backboard_base_url=(_text(env, "BACKBOARD_BASE_URL") or Settings.backboard_base_url).rstrip("/"),
        backboard_api_key=_text(env, "BACKBOARD_API_KEY"),
        session_days=_int(env, "SESSION_DAYS", 7, low=1, high=30),
        invite_codes=invites,
        max_users=_int(env, "MAX_USERS", 300, low=1, high=100_000),
        llm_api_key=_text(env, "LLM_API_KEY"),
        llm_base_url=base_url,
        llm_model=_text(env, "LLM_MODEL"),
        llm_json_mode=json_mode,
        llm_timeout_s=float(_int(env, "LLM_TIMEOUT_S", 120, low=5, high=600)),
        # Some providers stop at 4096 unless asked, which a reasoning model can spend before it finishes a threat list.
        llm_max_tokens=_int(env, "LLM_MAX_TOKENS", 16_384, low=0, high=200_000) or None,
        daily_model_calls=_int(env, "DAILY_MODEL_CALLS", 60, low=0, high=100_000),
        model_calls_per_minute=_int(env, "MODEL_CALLS_PER_MINUTE", 6, low=1, high=1000),
        global_daily_model_calls=_int(env, "GLOBAL_DAILY_MODEL_CALLS", 3000, low=0, high=10_000_000),
        daily_voice_sessions=_int(env, "DAILY_VOICE_SESSIONS", 10, low=0, high=10_000),
        daily_dictations=_int(env, "DAILY_DICTATIONS", 30, low=0, high=10_000),
        elevenlabs_api_key=_text(env, "ELEVENLABS_API_KEY"),
        dev_username=dev_username.lower() if dev_username else None,
        dev_password=dev_password,
        elevenlabs_agent_id=_text(env, "ELEVENLABS_AGENT_ID"),
        elevenlabs_stt_model=_text(env, "ELEVENLABS_STT_MODEL") or Settings.elevenlabs_stt_model,
        static_dir=static_dir,
    )


# =============================================================================
# Parsing helpers
# =============================================================================


def _text(env: Mapping[str, str], key: str) -> str | None:
    """A trimmed value, or `None` when unset or blank."""
    value = env.get(key, "").strip()
    return value or None


def _list(env: Mapping[str, str], key: str) -> tuple[str, ...]:
    """A comma-separated list, trimmed, with blanks dropped."""
    return tuple(item.strip() for item in env.get(key, "").split(",") if item.strip())


def _flag(env: Mapping[str, str], key: str, *, default: bool) -> bool:
    """A boolean written as true/false, 1/0 or yes/no."""
    value = _text(env, key)
    if value is None:
        return default
    if value.lower() in ("1", "true", "yes", "on"):
        return True
    if value.lower() in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"`{key}` must be true or false, not {value!r}.")


def _int(env: Mapping[str, str], key: str, default: int, *, low: int, high: int) -> int:
    """An integer within `low` and `high`."""
    value = _text(env, key)
    if value is None:
        return default
    try:
        number = int(value)
    except ValueError as exc:
        raise ValueError(f"`{key}` must be a whole number, not {value!r}.") from exc
    if not low <= number <= high:
        raise ValueError(f"`{key}` must be between {low} and {high}.")
    return number


def _choice(env: Mapping[str, str], key: str, options: tuple[str, ...], default: str) -> str:
    """One of `options`."""
    value = _text(env, key) or default
    if value not in options:
        raise ValueError(f"`{key}` must be one of {', '.join(options)}, not {value!r}.")
    return value


def _origin(value: str, key: str) -> str:
    """Normalize `https://host[:port]`, rejecting paths, queries and other schemes."""
    parsed = urlparse(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.path not in ("", "/") or parsed.query:
        raise ValueError(f"`{key}` entries must look like `https://app.example.com`, with no path.")
    return f"{parsed.scheme}://{parsed.netloc}"


def _database_url(url: str) -> str:
    """Point Postgres URLs at the psycopg 3 driver, which SQLAlchemy does not pick by default."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix) :]
    return url
