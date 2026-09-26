from datetime import datetime

from sqlalchemy.orm import Session

from app.boards.service import Boards, read_analysis, read_map, read_previous_map
from app.domain.rules import ai_exposure, crosses_boundary, severity_counts
from app.schemas import BoardOut, BoardSummary, EventOut, ExposureOut, SeverityCounts, SourceOut
from app.tables import BoardRow

# =============================================================================
# Module Overview
# =============================================================================
# Turns stored board rows into the shapes the API returns. `board_out` adds
# what the rules work out, the AI exposure and the trust boundary crossings,
# so the browser draws them without reimplementing any rule.


def board_summary(row: BoardRow) -> BoardSummary:
    """A board as the sidebar lists it."""
    return BoardSummary(
        id=row.id,
        title=row.title,
        status=row.status,
        example=row.example,
        updated_at=row.updated_at,
        revision=row.revision,
        counts=SeverityCounts(**severity_counts(read_analysis(row))),
    )


def board_out(session: Session, boards: Boards, row: BoardRow) -> BoardOut:
    """A board with its map, analysis, activity and the rules' findings."""
    system = read_map(row)
    analysis = read_analysis(row)
    exposure = ai_exposure(system) if system else []
    return BoardOut(
        id=row.id,
        title=row.title,
        status=row.status,
        example=row.example,
        sources=[
            SourceOut(
                id=str(s["id"]),
                name=str(s["name"]),
                kind=s["kind"],
                bytes=int(s["bytes"]),
                added_at=datetime.fromisoformat(str(s["added_at"])),
            )
            for s in row.sources
        ],
        map=system,
        previous_map=read_previous_map(row),
        analysis=analysis,
        analysis_version=row.analysis_version,
        analyzed_by=row.analyzed_by,
        error=row.error,
        revision=row.revision,
        created_at=row.created_at,
        updated_at=row.updated_at,
        events=[
            EventOut(id=e.id, kind=e.kind, text=e.text, created_at=e.created_at) for e in boards.events(session, row.id)
        ],
        exposure=[
            ExposureOut(
                node=x.node,
                private_data=list(x.private_data),
                untrusted=list(x.untrusted),
                outbound=list(x.outbound),
                lethal=x.lethal,
            )
            for x in exposure
        ],
        crossings=[f.id for f in system.flows if crosses_boundary(system, f)] if system else [],
        counts=SeverityCounts(**severity_counts(analysis)),
    )
