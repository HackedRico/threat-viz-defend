from fastapi import APIRouter
from sqlalchemy import func, select

from app.context import Db, Svc
from app.domain.masking import file_policy
from app.schemas import ConfigOut, FilePolicyOut, HealthOut
from app.tables import UserRow

# =============================================================================
# Module Overview
# =============================================================================
# Routes anyone may call before signing in: liveness for the host's health
# check, and the public configuration the sign-in page and uploader need.

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/health")
def health() -> HealthOut:
    """Liveness for load balancers."""
    return HealthOut(ok=True)


@router.get("/config")
def config(svc: Svc, session: Db) -> ConfigOut:
    """The app name, what analyzes boards, whether voice, dictation and sign up are on, and the upload policy."""
    settings = svc.settings
    # A full server refuses every sign up, so the home page should not offer one.
    accounts = session.scalar(select(func.count()).select_from(UserRow)) or 0
    return ConfigOut(
        app_name=settings.app_name,
        analyst=svc.analyst.label,
        demo_mode=not settings.llm_configured,
        voice_enabled=svc.voice is not None,
        dictation_enabled=svc.transcriber is not None,
        signup_open=bool(settings.invite_codes) and accounts < settings.max_users,
        file_policy=FilePolicyOut.model_validate(file_policy()),
    )
