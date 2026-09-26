from fastapi import APIRouter, status

from app.context import CurrentUser, Db, Svc
from app.schemas import MemoryIn, MemoryOut, MemoryTestOut

# =============================================================================
# Module Overview
# =============================================================================
# The user's Backboard memory setting, kept apart from the model provider so
# any model can remember their progress. The key goes in and never comes back
# out; responses show only its last four characters.

router = APIRouter(prefix="/api/memory", tags=["memory"])


@router.get("")
def get_memory(user: CurrentUser, svc: Svc, session: Db) -> MemoryOut:
    """Whether memory is saved and applies to this user's analyses."""
    return svc.memory.view(session, user.id)


@router.put("")
def save_memory(body: MemoryIn, user: CurrentUser, svc: Svc, session: Db) -> MemoryOut:
    """Save the user's Backboard key for memory; a null `api_key` keeps the saved one."""
    return svc.memory.save(session, user.id, body)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(user: CurrentUser, svc: Svc, session: Db) -> None:
    """Turn memory off and forget the key."""
    svc.memory.delete(session, user.id)


@router.post("/test")
def test_memory(body: MemoryIn, user: CurrentUser, svc: Svc) -> MemoryTestOut:
    """Check that Backboard accepts the key, before saving it."""
    svc.limiter.hit(f"memory-test:{user.id}", 10, 300, "Too many memory tests. Wait a few minutes.")
    return svc.memory.test(user.id, body)
