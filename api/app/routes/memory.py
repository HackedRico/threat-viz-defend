from fastapi import APIRouter, status

from app.context import CurrentUser, Db, Svc
from app.schemas import MemoryIn, MemoryNotesOut, MemoryOut, MemorySwitchIn, MemoryTestOut

# =============================================================================
# Module Overview
# =============================================================================
# The user's Backboard memory: the switch, what it remembers, and an optional
# key of their own in place of the server's. Memory sits around the model calls
# whichever model serves the user. A key goes in and never comes back out;
# responses show only its last four characters.

router = APIRouter(prefix="/api/memory", tags=["memory"])


@router.get("")
def get_memory(user: CurrentUser, svc: Svc, session: Db) -> MemoryOut:
    """Whether memory is on for this user, and whose Backboard account holds it."""
    return svc.memory.view(session, user.id)


@router.put("/enabled")
def switch_memory(body: MemorySwitchIn, user: CurrentUser, svc: Svc, session: Db) -> MemoryOut:
    """Turn memory on or off; notes already kept stay until forgotten."""
    return svc.memory.switch(session, user.id, body.enabled)


@router.get("/notes")
def get_notes(user: CurrentUser, svc: Svc) -> MemoryNotesOut:
    """What Backboard remembers about this user, newest first."""
    svc.limiter.hit(f"memory-notes:{user.id}", 30, 60, "Too many memory reads in a minute. Wait a little.")
    return svc.memory.notes(user.id)


@router.delete("/notes", status_code=status.HTTP_204_NO_CONTENT)
def forget_notes(user: CurrentUser, svc: Svc) -> None:
    """Delete every note Backboard holds about this user."""
    svc.limiter.hit(f"memory-forget:{user.id}", 5, 300, "Too many resets. Wait a few minutes.")
    svc.memory.forget(user.id)


@router.put("")
def save_memory(body: MemoryIn, user: CurrentUser, svc: Svc, session: Db) -> MemoryOut:
    """Save the user's own Backboard key for memory; a null `api_key` keeps the saved one."""
    return svc.memory.save(session, user.id, body)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(user: CurrentUser, svc: Svc, session: Db) -> None:
    """Forget the user's own key; the server's Backboard account holds their memory from then on, if it has one."""
    svc.memory.delete(session, user.id)


@router.post("/test")
def test_memory(body: MemoryIn, user: CurrentUser, svc: Svc) -> MemoryTestOut:
    """Check that Backboard accepts the key, before saving it."""
    svc.limiter.hit(f"memory-test:{user.id}", 10, 300, "Too many memory tests. Wait a few minutes.")
    return svc.memory.test(user.id, body)
