from fastapi import APIRouter

from app.context import Svc
from app.domain.masking import file_policy
from app.schemas import ConfigOut, FilePolicyOut, HealthOut

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
def config(svc: Svc) -> ConfigOut:
    """The app name, what analyzes boards, whether voice and sign up are on, and the upload policy."""
    settings = svc.settings
    return ConfigOut(
        app_name=settings.app_name,
        analyst=svc.analyst.label,
        demo_mode=not settings.llm_configured,
        voice_enabled=svc.voice is not None,
        signup_open=bool(settings.invite_codes),
        file_policy=FilePolicyOut.model_validate(file_policy()),
    )
