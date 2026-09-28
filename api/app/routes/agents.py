from fastapi import APIRouter, Request, status

from app.boards.ingest import agent_material
from app.boards.views import board_summary
from app.context import AgentUser, Db, Svc, web_app_origin
from app.db import utcnow
from app.schemas import AgentChangeIn, AgentChangeOut, BoardSummary

# =============================================================================
# Module Overview
# =============================================================================
# Routes for coding agents, authenticated with a personal token instead of a
# cookie. A hook posts each turn's diff here, and the board redraws its map
# from it; the change then waits in review for the developer to confirm.

router = APIRouter(prefix="/api/agent", tags=["agents"])


@router.get("/boards")
def agent_boards(user: AgentUser, svc: Svc, session: Db) -> list[BoardSummary]:
    """The token owner's boards, so a hook can check its board id."""
    return [board_summary(row) for row in svc.boards.all_for(session, user.id)]


@router.post("/boards/{board_id}/changes", status_code=status.HTTP_202_ACCEPTED)
def report_change(
    board_id: str, body: AgentChangeIn, request: Request, user: AgentUser, svc: Svc, session: Db
) -> AgentChangeOut:
    """Update the board's map from a coding agent's change."""
    # A hook retries a busy board on its next turn, and those retries must not use up the hour's changes.
    svc.boards.check_idle(session, user.id, board_id)
    # Masking the diff takes a while and `add_material` opens sessions of its own, so the connection goes back first.
    session.commit()
    svc.limiter.hit(f"agent-change:{user.id}", 30, 3600, "Too many agent changes this hour. Batch them or wait.")
    material = agent_material(body.agent, body.summary, body.diff, body.files, utcnow())
    svc.boards.add_material(user.id, board_id, material)
    row = svc.boards.get(session, user.id, board_id)
    origin = web_app_origin(request, svc.settings)
    return AgentChangeOut(board_id=row.id, status=row.status, review_url=f"{origin}/boards/{row.id}")
