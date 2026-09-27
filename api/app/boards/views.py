from datetime import datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.boards.service import Boards, current_analysis, read_analysis, read_map, read_previous_map
from app.boards.versions import Version, list_versions, open_version
from app.domain.models import SystemMap, ThreatAnalysis
from app.domain.rules import ai_exposure, crosses_boundary, severity_counts
from app.errors import not_found
from app.schemas import (
    BoardOut,
    BoardSummary,
    EventOut,
    ExposureOut,
    MapVersionOut,
    MapVersionSummary,
    SeverityCounts,
    SourceOut,
)
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
        exposure=_exposure(system),
        crossings=_crossings(system),
        counts=SeverityCounts(**severity_counts(analysis)),
        versions=[_summary(v) for v in list_versions(session, row, _ready_json(row))],
    )


def version_out(session: Session, row: BoardRow, number: int) -> MapVersionOut:
    """One version of a board's map with its threats and the rules' findings, or 404."""
    opened = open_version(session, row, number, _ready_json(row))
    if opened is None:
        raise not_found("That version is no longer kept. Only the latest versions are.")
    try:
        system = SystemMap.model_validate(opened.map)
        analysis = ThreatAnalysis.model_validate(opened.analysis) if opened.analysis is not None else None
    except ValidationError as exc:
        raise not_found("That version was saved in an older shape and can no longer be drawn.") from exc
    return MapVersionOut(
        **_summary(opened.version).model_dump(),
        map=system,
        analysis=analysis,
        exposure=_exposure(system),
        crossings=_crossings(system),
    )


def _ready_json(row: BoardRow) -> dict[str, Any] | None:
    """The current threats as stored JSON while they describe the map, for a board whose history has not started."""
    return row.analysis if current_analysis(row) is not None else None


def _summary(version: Version) -> MapVersionSummary:
    """A version for the list."""
    return MapVersionSummary(
        number=version.number,
        source=version.source,
        label=version.label,
        created_at=version.created_at,
        nodes=version.node_count,
        flows=version.flow_count,
        counts=SeverityCounts(**version.counts) if version.counts is not None else None,
    )


def _exposure(system: SystemMap | None) -> list[ExposureOut]:
    """Each AI node's exposure, as the rules work it out."""
    return [
        ExposureOut(
            node=x.node,
            private_data=list(x.private_data),
            untrusted=list(x.untrusted),
            outbound=list(x.outbound),
            lethal=x.lethal,
        )
        for x in (ai_exposure(system) if system else [])
    ]


def _crossings(system: SystemMap | None) -> list[str]:
    """Ids of the flows that cross a trust boundary."""
    return [f.id for f in system.flows if crosses_boundary(system, f)] if system else []
