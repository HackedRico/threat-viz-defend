from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, undefer

from app.domain.rules import SEVERITIES
from app.schemas import VersionSource
from app.tables import BoardRow, MapVersionRow

# =============================================================================
# Module Overview
# =============================================================================
# A board's map history, so a person can see how the design changed across
# uploads, coding agent changes and hand edits. `record_change` keeps the map
# a board now holds as its newest version, first saving the map before it
# when history starts late, as on a board made before versions were kept.
# `attach_analysis` pins the threats a confirm found to the newest version.
# Only the last `MAX_VERSIONS` are kept, and a board with a map but no rows
# yet lists its current map as version 1 without writing anything. Listing
# reads only small columns; `open_version` loads one map and its threats.

MAX_VERSIONS = 30
MAX_LABEL = 200


@dataclass(frozen=True)
class Version:
    """One version's facts for a list: no map, so polling a board stays cheap."""

    number: int
    source: VersionSource
    label: str
    node_count: int
    flow_count: int
    counts: dict[str, int] | None
    created_at: datetime


@dataclass(frozen=True)
class OpenedVersion:
    """One version with its map and threats, as stored JSON."""

    version: Version
    map: dict[str, Any]
    analysis: dict[str, Any] | None


def record_change(
    session: Session,
    row: BoardRow,
    *,
    before: dict[str, Any] | None,
    before_analysis: dict[str, Any] | None,
    source: VersionSource,
    label: str,
    analysis: dict[str, Any] | None = None,
) -> None:
    """Keep `row.map` as the board's newest version; `before` becomes version 1 when history starts now."""
    if row.map is None:
        return
    newest = _newest_number(session, row.id)
    if newest == 0 and before is not None:
        session.add(_row(row.id, 1, "earlier", "Map before version history", before, before_analysis))
        newest = 1
    session.add(_row(row.id, newest + 1, source, label, row.map, analysis))
    session.flush()
    _prune(session, row.id)


def attach_analysis(session: Session, board_id: str, analysis: dict[str, Any]) -> None:
    """Pin threats found by a confirm to the newest version, the map they were found on."""
    newest = session.scalar(
        select(MapVersionRow).where(MapVersionRow.board_id == board_id).order_by(MapVersionRow.number.desc()).limit(1)
    )
    if newest is not None:
        newest.analysis = analysis
        newest.counts = severity_counts(analysis)


def list_versions(session: Session, row: BoardRow, analysis: dict[str, Any] | None) -> list[Version]:
    """Every kept version, oldest first; a board with a map and no history lists that map as version 1."""
    stored = session.scalars(
        select(MapVersionRow).where(MapVersionRow.board_id == row.id).order_by(MapVersionRow.number)
    ).all()
    if stored:
        return [_version(v) for v in stored]
    opened = _unsaved_first(row, analysis)
    return [opened.version] if opened else []


def open_version(session: Session, row: BoardRow, number: int, analysis: dict[str, Any] | None) -> OpenedVersion | None:
    """One version with its map and threats, or `None` when it is not kept."""
    stored = session.scalar(
        select(MapVersionRow)
        .where(MapVersionRow.board_id == row.id, MapVersionRow.number == number)
        .options(undefer(MapVersionRow.map), undefer(MapVersionRow.analysis))
    )
    if stored is not None:
        return OpenedVersion(_version(stored), stored.map, stored.analysis)
    if number != 1 or _newest_number(session, row.id) != 0:
        return None
    return _unsaved_first(row, analysis)


def severity_counts(analysis: dict[str, Any] | None) -> dict[str, int] | None:
    """Threats per severity from stored JSON, or `None` for a map whose threats were never found."""
    if analysis is None:
        return None
    counts: dict[str, int] = dict.fromkeys(SEVERITIES, 0)
    for threat in analysis.get("threats", []):
        severity = threat.get("severity") if isinstance(threat, dict) else None
        if severity in counts:
            counts[severity] += 1
    return counts


def _unsaved_first(row: BoardRow, analysis: dict[str, Any] | None) -> OpenedVersion | None:
    """The map a board holds, as version 1 of a history that has not been written yet."""
    if row.map is None:
        return None
    version = Version(
        number=1,
        source="example" if row.example else "earlier",
        label="Built-in example" if row.example else "Current map",
        node_count=len(row.map.get("nodes", [])),
        flow_count=len(row.map.get("flows", [])),
        counts=severity_counts(analysis),
        created_at=row.created_at,
    )
    return OpenedVersion(version, row.map, analysis)


def _newest_number(session: Session, board_id: str) -> int:
    """The highest version number on a board, or 0 before its first."""
    found = session.scalar(select(func.max(MapVersionRow.number)).where(MapVersionRow.board_id == board_id))
    return int(found or 0)


def _row(
    board_id: str,
    number: int,
    source: VersionSource,
    label: str,
    system: dict[str, Any],
    analysis: dict[str, Any] | None,
) -> MapVersionRow:
    """A version row for one map, with its part and threat counts worked out once."""
    return MapVersionRow(
        board_id=board_id,
        number=number,
        source=source,
        label=" ".join(label.split())[:MAX_LABEL] or "Map changed",
        map=system,
        analysis=analysis,
        node_count=len(system.get("nodes", [])),
        flow_count=len(system.get("flows", [])),
        counts=severity_counts(analysis),
    )


def _prune(session: Session, board_id: str) -> None:
    """Drop versions beyond the newest `MAX_VERSIONS`; numbers keep counting up, so a version keeps its name."""
    cutoff = _newest_number(session, board_id) - MAX_VERSIONS
    if cutoff > 0:
        session.execute(delete(MapVersionRow).where(MapVersionRow.board_id == board_id, MapVersionRow.number <= cutoff))


def _version(stored: MapVersionRow) -> Version:
    """A stored row's small columns as a `Version`."""
    source: VersionSource = stored.source  # type: ignore[assignment]
    return Version(
        number=stored.number,
        source=source,
        label=stored.label,
        node_count=stored.node_count,
        flow_count=stored.flow_count,
        counts=stored.counts,
        created_at=stored.created_at,
    )
