from fastapi import APIRouter, status

from app.context import CurrentUser, Db, Svc
from app.schemas import ProviderIn, ProviderOut, ProviderTestOut

# =============================================================================
# Module Overview
# =============================================================================
# The user's model provider setting: which base URL, model and key analyze
# their boards. Keys go in and never come back out; responses show only the
# last four characters. Testing a provider checks the host and the key first.

router = APIRouter(prefix="/api/provider", tags=["provider"])


@router.get("")
def get_provider(user: CurrentUser, svc: Svc, session: Db) -> ProviderOut:
    """What analyzes this user's boards."""
    return svc.providers.view(session, user.id)


@router.put("")
def save_provider(body: ProviderIn, user: CurrentUser, svc: Svc, session: Db) -> ProviderOut:
    """Save the user's own provider; a null `api_key` keeps the saved one."""
    return svc.providers.save(session, user.id, body)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_provider(user: CurrentUser, svc: Svc, session: Db) -> None:
    """Forget the user's provider and key, and go back to the server's default."""
    svc.providers.delete(session, user.id)


@router.post("/test")
def test_provider(body: ProviderIn, user: CurrentUser, svc: Svc) -> ProviderTestOut:
    """Check that a provider is reachable and the key works, before saving it."""
    svc.limiter.hit(f"provider-test:{user.id}", 10, 300, "Too many provider tests. Wait a few minutes.")
    return svc.providers.test(user.id, body)
