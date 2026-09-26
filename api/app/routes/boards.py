from fastapi import APIRouter, Response, status

from app.boards.github import fetch_repo, parse_repo_url
from app.boards.ingest import SourceItem, build_material
from app.boards.service import read_analysis, read_map
from app.boards.views import board_out, board_summary
from app.context import CurrentUser, Db, Svc
from app.db import utcnow
from app.domain.briefing import brief
from app.domain.models import Answer
from app.domain.report import render_report
from app.errors import conflict
from app.schemas import AskIn, BoardCreate, BoardOut, BoardPatch, BoardSummary, BriefOut, GithubIn, MapIn, SourcesIn

# =============================================================================
# Module Overview
# =============================================================================
# Board routes: list, create, rename, delete, add material, edit and confirm
# the map, ask questions and export. Slow steps answer 202 with the board in
# its busy status; the browser polls the board until the status settles.

router = APIRouter(prefix="/api/boards", tags=["boards"])


@router.get("")
def list_boards(user: CurrentUser, svc: Svc, session: Db) -> list[BoardSummary]:
    """The user's boards, most recently changed first."""
    return [board_summary(row) for row in svc.boards.all_for(session, user.id)]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_board(body: BoardCreate, user: CurrentUser, svc: Svc, session: Db) -> BoardOut:
    """Start an empty board."""
    return board_out(session, svc.boards, svc.boards.create(session, user.id, body.title))


@router.post("/example", status_code=status.HTTP_201_CREATED)
def add_example(user: CurrentUser, svc: Svc, session: Db) -> BoardOut:
    """Add a fresh copy of the built-in example board."""
    return board_out(session, svc.boards, svc.boards.add_example(session, user.id))


@router.get("/{board_id}")
def get_board(board_id: str, user: CurrentUser, svc: Svc, session: Db) -> BoardOut:
    """One board with its map, analysis and activity."""
    return board_out(session, svc.boards, svc.boards.get(session, user.id, board_id))


@router.patch("/{board_id}")
def rename_board(board_id: str, body: BoardPatch, user: CurrentUser, svc: Svc, session: Db) -> BoardOut:
    """Rename a board."""
    return board_out(session, svc.boards, svc.boards.rename(session, user.id, board_id, body.title))


@router.delete("/{board_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_board(board_id: str, user: CurrentUser, svc: Svc, session: Db) -> None:
    """Delete a board and everything on it."""
    svc.boards.delete(session, user.id, board_id)


@router.post("/{board_id}/sources", status_code=status.HTTP_202_ACCEPTED)
def add_sources(board_id: str, body: SourcesIn, user: CurrentUser, svc: Svc, session: Db) -> BoardOut:
    """Add pasted text or files and start drawing the map; poll the board for the result."""
    # Check ownership and pace before masking, which is the expensive part of an upload.
    svc.boards.get(session, user.id, board_id)
    svc.limiter.hit(f"sources:{user.id}", 20, 600, "Too many uploads in a few minutes. Wait, then try again.")
    items = [SourceItem(name=s.name, kind=s.kind, text=s.text) for s in body.sources]
    svc.boards.add_material(user.id, board_id, build_material(items, utcnow()))
    return board_out(session, svc.boards, svc.boards.get(session, user.id, board_id))


@router.post("/{board_id}/github", status_code=status.HTTP_202_ACCEPTED)
def add_github(board_id: str, body: GithubIn, user: CurrentUser, svc: Svc, session: Db) -> BoardOut:
    """Read a public GitHub repository and start drawing the map from it."""
    repo = parse_repo_url(body.url)
    svc.boards.get(session, user.id, board_id)
    svc.limiter.hit(f"sources:{user.id}", 20, 600, "Too many uploads in a few minutes. Wait, then try again.")
    svc.boards.add_from_fetch(
        user.id, board_id, lambda: fetch_repo(repo, utcnow()), f"Reading {repo.label} from GitHub."
    )
    return board_out(session, svc.boards, svc.boards.get(session, user.id, board_id))


@router.put("/{board_id}/map")
def save_map(board_id: str, body: MapIn, user: CurrentUser, svc: Svc, session: Db) -> BoardOut:
    """Save a map edited by hand; the board returns to review."""
    svc.limiter.hit(f"map-save:{user.id}", 60, 600, "Too many map saves in a few minutes. Wait, then try again.")
    return board_out(session, svc.boards, svc.boards.save_map(session, user.id, board_id, body.map))


@router.post("/{board_id}/confirm", status_code=status.HTTP_202_ACCEPTED)
def confirm_map(board_id: str, user: CurrentUser, svc: Svc, session: Db) -> BoardOut:
    """Accept the map and start finding threats on it."""
    svc.boards.confirm(user.id, board_id)
    return board_out(session, svc.boards, svc.boards.get(session, user.id, board_id))


@router.post("/{board_id}/ask")
def ask(board_id: str, body: AskIn, user: CurrentUser, svc: Svc) -> Answer:
    """Answer a question about a finished board, with the ids to highlight."""
    return svc.boards.ask(user.id, board_id, body.question, body.focus)


@router.get("/{board_id}/brief")
def get_brief(board_id: str, user: CurrentUser, svc: Svc, session: Db) -> BriefOut:
    """A spoken-style walkthrough of the board, for the voice coach and agents."""
    row = svc.boards.get(session, user.id, board_id)
    system = read_map(row)
    if system is None:
        raise conflict("This board has no map yet. Add material first.")
    return BriefOut(text=brief(system, read_analysis(row)))


@router.get("/{board_id}/report.md", response_class=Response)
def report(board_id: str, user: CurrentUser, svc: Svc, session: Db) -> Response:
    """The board as a Markdown report, downloaded as a file."""
    row = svc.boards.get(session, user.id, board_id)
    system = read_map(row)
    if system is None:
        raise conflict("This board has no map yet, so there is nothing to export.")
    text = render_report(row.title, system, read_analysis(row), row.analyzed_by)
    return Response(
        text,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="threat-model.md"'},
    )
