import logging
import uuid
from collections.abc import Callable
from typing import Any, TypeGuard, cast

from pydantic import ValidationError
from sqlalchemy import CursorResult, delete, select, update
from sqlalchemy.orm import Session

from app.analysis.analyst import Analyst
from app.boards.ingest import Material
from app.boards.versions import attach_analysis, ensure_version, newest_has_threats, record_change
from app.db import Database, utcnow
from app.domain.models import SystemMap, ThreatAnalysis
from app.domain.notes import question_note
from app.domain.rules import sanitize_map
from app.errors import bad_request, conflict, not_found
from app.examples import load_examples
from app.jobs import Jobs
from app.limits import Budget
from app.llm.base import LlmError
from app.memory import Memory, MemorySource, NoMemory
from app.providers.service import AnalystSource
from app.schemas import AskOut, MemoryUse, VersionSource
from app.tables import BoardEventRow, BoardRow

# =============================================================================
# Module Overview
# =============================================================================
# The life of a board. `Boards` moves a board through its statuses: material
# goes in and the map is drawn (`mapping` then `review`), a person confirms the
# map and threats are found (`analyzing` then `ready`). Model calls run as jobs
# outside any database transaction; a failed job puts the board back where it
# was and records the error for the user. Questions go through Backboard memory
# when it is on: earlier notes feed the prompt and the question is kept after.

log = logging.getLogger(__name__)

BUSY = ("mapping", "analyzing")
MAX_BOARDS = 30
MAX_SOURCES = 100
MAX_EVENTS = 40


class Boards:
    """Board storage and the jobs that analyze them."""

    def __init__(
        self, db: Database, analysts: AnalystSource, budget: Budget, jobs: Jobs, memory: MemorySource | None = None
    ) -> None:
        self._db = db
        self._analysts = analysts
        self._budget = budget
        self._jobs = jobs
        self._memory = memory or NoMemory()

    # -----------------------------------------------------------------
    # Reading and simple edits
    # -----------------------------------------------------------------

    def all_for(self, session: Session, user_id: str) -> list[BoardRow]:
        """The user's boards, most recently changed first."""
        query = select(BoardRow).where(BoardRow.user_id == user_id).order_by(BoardRow.updated_at.desc())
        return list(session.scalars(query))

    def get(self, session: Session, user_id: str, board_id: str) -> BoardRow:
        """One of the user's boards; someone else's board is reported as missing."""
        row = session.get(BoardRow, board_id)
        if row is None or row.user_id != user_id:
            raise not_found("That board does not exist. It may have been deleted.")
        return row

    def events(self, session: Session, board_id: str) -> list[BoardEventRow]:
        """The newest activity on a board, newest first."""
        query = (
            select(BoardEventRow)
            .where(BoardEventRow.board_id == board_id)
            .order_by(BoardEventRow.id.desc())
            .limit(MAX_EVENTS)
        )
        return list(session.scalars(query))

    def create(self, session: Session, user_id: str, title: str) -> BoardRow:
        """Start an empty board."""
        count = len(self.all_for(session, user_id))
        if count >= MAX_BOARDS:
            raise conflict(f"You have {MAX_BOARDS} boards. Delete one before starting another.")
        row = BoardRow(id=str(uuid.uuid4()), user_id=user_id, title=title.strip(), status="empty", sources=[])
        session.add(row)
        session.flush()
        return row

    def rename(self, session: Session, user_id: str, board_id: str, title: str) -> BoardRow:
        """Change a board's title."""
        row = self.get(session, user_id, board_id)
        row.title = title.strip()
        _touch(row)
        return row

    def delete(self, session: Session, user_id: str, board_id: str) -> None:
        """Delete a board, its activity and its quiz attempts."""
        row = self.get(session, user_id, board_id)
        session.delete(row)

    def add_example(self, session: Session, user_id: str) -> BoardRow:
        """Add a finished copy of the built-in example, ready to explore and quiz."""
        example = load_examples()[0]
        row = self.create(session, user_id, example.title)
        now = utcnow()
        row.example = True
        row.status = "ready"
        row.map = example.map.model_dump(mode="json")
        row.analysis = example.analysis.model_dump(mode="json")
        row.analysis_version = 1
        row.analyzed_by = "Built-in example"
        row.sources = [
            {
                "id": str(uuid.uuid4()),
                "name": "Design notes",
                "kind": "example",
                "bytes": len(example.material),
                "added_at": now.isoformat(),
            }
        ]
        _event(session, row.id, "example", "Loaded the built-in example. Open Defend to try the quiz.")
        record_change(
            session, row, before=None, before_analysis=None, source="example", label="Built-in example",
            analysis=row.analysis,
        )  # fmt: skip
        return row

    # -----------------------------------------------------------------
    # Drawing and editing the map
    # -----------------------------------------------------------------

    def check_idle(self, session: Session, user_id: str, board_id: str) -> None:
        """Raise 404 for a board the user does not own and 409 for a busy one, before any work or pace is spent."""
        if self.get(session, user_id, board_id).status in BUSY:
            raise conflict("The board is already working. Wait for it to finish, then try again.")

    def add_material(self, user_id: str, board_id: str, material: Material) -> None:
        """Record new material and start drawing, or updating, the map from it."""
        if not material.text.strip():
            raise bad_request("Nothing readable was sent: every file was empty or skipped.")
        kind = str(material.sources[0]["kind"]) if material.sources else "sources"
        # An agent change is named by the agent and its summary; anything else by what was added.
        source: VersionSource = "agent" if kind == "agent" else "upload"
        label = str(material.sources[0]["name"]) if source == "agent" and material.sources else _headline(material)

        def record(row: BoardRow, session: Session) -> None:
            row.sources = [*row.sources, *material.sources][-MAX_SOURCES:]
            _event(session, row.id, kind, material.summary())

        current, restore, analyst = self._begin(user_id, board_id, "draft_map", "mapping", record)
        self._queue_draft(board_id, current, restore, analyst, lambda: material.text, source, lambda: label)

    def add_from_fetch(self, user_id: str, board_id: str, fetch: Callable[[], Material], note: str) -> None:
        """Start drawing the map from material a job must fetch first, such as a GitHub repository."""
        current, restore, analyst = self._begin(
            user_id, board_id, "draft_map", "mapping", lambda row, session: _event(session, row.id, "github", note)
        )

        fetched: list[str] = []

        def load() -> str:
            material = fetch()
            if not material.text.strip():
                raise ValueError("Nothing readable was found in the repository: every file was empty or skipped.")
            fetched.append(_headline(material))
            with self._db.session() as session:
                target = session.get(BoardRow, board_id)
                if target is not None:
                    target.sources = [*target.sources, *material.sources][-MAX_SOURCES:]
                    _event(session, board_id, "github", material.summary())
            return material.text

        self._queue_draft(board_id, current, restore, analyst, load, "github", lambda: fetched[-1] if fetched else note)

    def save_map(self, session: Session, user_id: str, board_id: str, system: SystemMap) -> BoardRow:
        """Save a map edited by hand; threats found on the old map need a fresh confirm."""
        row = self.get(session, user_id, board_id)
        if row.status in BUSY:
            raise conflict("The board is busy. Wait for it to finish, then save your edits.")
        clean = sanitize_map(system)
        if not clean.nodes:
            raise bad_request("A map needs at least one component.")
        # Claimed with one conditional write, as `_begin` does, so a confirm that started since this row was read
        # cannot find threats on one map while this edit saves another under it.
        claim = update(BoardRow).where(
            BoardRow.id == row.id, BoardRow.status.not_in(BUSY), BoardRow.revision == row.revision
        )
        claimed = session.execute(claim.values(status="review").execution_options(synchronize_session=False))
        if cast(CursorResult[tuple[()]], claimed).rowcount != 1:
            raise conflict("The board changed or is busy. Reload it, then save your edits again.")
        # Keep the map before the edit so review marks what the person changed.
        before, before_analysis = row.map, _analysis_json(row)
        row.previous_map = row.map
        row.map = clean.model_dump(mode="json")
        row.status = "review"
        row.error = None
        _event(session, row.id, "edited", "Map edited by hand. Confirm it to refresh the threats.")
        record_change(
            session, row, before=before, before_analysis=before_analysis, source="edit", label="Edited by hand"
        )
        _touch(row)
        return row

    def confirm(self, user_id: str, board_id: str) -> None:
        """Accept the drafted map and start finding threats on it."""

        def in_review(row: BoardRow) -> None:
            if row.status != "review" or row.map is None:
                raise conflict("Only a drafted map waiting for review can be confirmed.")

        # The version this confirm finds threats on, pinned now so its threats never land on a later map.
        confirmed: list[int] = []

        def record(row: BoardRow, session: Session) -> None:
            _event(session, row.id, "confirmed", "Map confirmed. Finding threats.")
            confirmed.append(ensure_version(session, row))

        system, _, analyst = self._begin(user_id, board_id, "find_threats", "analyzing", record, require=in_review)
        if system is None:
            self._fail(board_id, "review", "The stored map no longer loads. Edit and save it, then confirm again.")
            return

        def work() -> None:
            try:
                analysis = analyst.find_threats(system)
            except LlmError as exc:
                self._fail(board_id, "review", exc.message)
                return
            except Exception:
                log.exception("[boards] Finding threats for %s failed unexpectedly.", board_id)
                self._fail(board_id, "review", "Finding threats failed. Try again.")
                return
            try:
                with self._db.session() as session:
                    target = session.get(BoardRow, board_id, with_for_update=True)
                    if not _still_claimed(target, "analyzing", board_id):
                        return
                    target.analysis = analysis.model_dump(mode="json")
                    attach_analysis(session, board_id, target.analysis, confirmed[0])
                    target.analysis_version += 1
                    # The column holds 120 characters, and a saved provider's model id and host can run longer.
                    target.analyzed_by = analyst.label[:120]
                    target.status = "ready"
                    target.error = None
                    _event(session, board_id, "analyzed", f"Found {len(analysis.threats)} threats. {analysis.verdict}")
                    _touch(target)
            except Exception:
                # A failed save must still end the busy status, or the board spins until the next restart.
                log.exception("[boards] Saving the threats for %s failed.", board_id)
                self._fail(board_id, "review", "Saving the threats failed. Try again.")

        self._jobs.submit(work, f"find_threats {board_id}")

    # -----------------------------------------------------------------
    # Questions
    # -----------------------------------------------------------------

    def ask(self, user_id: str, board_id: str, question: str, focus: str | None) -> AskOut:
        """Answer a question about a finished board, through memory when it is on."""
        with self._db.session() as session:
            row = self.get(session, user_id, board_id)
            system, analysis, title = read_map(row), current_analysis(row), row.title
            if system is None or analysis is None:
                raise conflict("Confirm the map and wait for the threats before asking about them.")
        # Outside any session: a saved provider's host is resolved here, and a slow lookup must not hold a connection.
        chosen = self._analysts.for_user(user_id)
        with self._db.session() as session:
            self._budget.spend(session, user_id, "model", "answer", own_key=chosen.own_key)
        text = question.strip()
        memory = self._memory.for_user(user_id)
        notes = memory.recall(text) if memory is not None else []
        try:
            reply = chosen.analyst.answer(system, analysis, text, focus, notes)
        except LlmError as exc:
            raise model_error(exc) from exc
        if memory is not None:
            self.remember(memory, question_note(title, text))
        use = MemoryUse(recalled=notes, kept=True) if memory is not None else None
        return AskOut(answer=reply.answer, highlight=reply.highlight, memory=use)

    def remember(self, memory: Memory, note: str) -> None:
        """Keep a note in the background, so Backboard never slows the answer the person is waiting for."""
        self._jobs.submit(lambda: memory.keep(note), "memory keep")

    # -----------------------------------------------------------------
    # Upkeep
    # -----------------------------------------------------------------

    def recover_interrupted(self) -> int:
        """Put boards left busy by a restart back to a usable status; return how many."""
        with self._db.session() as session:
            rows = list(session.scalars(select(BoardRow).where(BoardRow.status.in_(BUSY))))
            for row in rows:
                row.status = _recovered_status(session, row)
                row.error = "The server restarted while this was running. Try again."
                _touch(row)
            return len(rows)

    def delete_user_boards(self, session: Session, user_id: str) -> None:
        """Delete every board a user owns."""
        session.execute(delete(BoardRow).where(BoardRow.user_id == user_id))

    # -----------------------------------------------------------------
    # Internals
    # -----------------------------------------------------------------

    def _begin(
        self,
        user_id: str,
        board_id: str,
        task: str,
        status: str,
        record: Callable[[BoardRow, Session], None],
        require: Callable[[BoardRow], None] | None = None,
    ) -> tuple[SystemMap | None, str, Analyst]:
        """Check the board is idle and passes `require`, pick the analyst, spend one call, and commit before a job."""
        chosen = self._analysts.for_user(user_id)  # before the session, since it may resolve a host
        # The commit has to land first: a job that writes the board inside this transaction would
        # deadlock on SQLite and race everywhere else.
        with self._db.session() as session:
            row = self.get(session, user_id, board_id)
            if row.status in BUSY:
                raise conflict("The board is already working. Wait for it to finish, then try again.")
            if require is not None:
                require(row)
            restore = _stable_status(row)
            current = read_map(row)
            # One conditional write claims the board, so two requests that both saw it idle, such as a coding
            # agent's change and a click on confirm, cannot both spend a call and start a job. The revision must
            # also be the one read, or a hand edit that committed in between would be drafted over or pinned to
            # threats found on the map this read.
            claim = update(BoardRow).where(
                BoardRow.id == board_id, BoardRow.status.not_in(BUSY), BoardRow.revision == row.revision
            )
            claimed = session.execute(
                claim.values(status=status, error=None).execution_options(synchronize_session=False)
            )
            if cast(CursorResult[tuple[()]], claimed).rowcount != 1:
                raise conflict("The board changed or is already working. Reload it, then try again.")
            self._budget.spend(session, user_id, "model", task, own_key=chosen.own_key)
            row.status = status
            row.error = None
            record(row, session)
            _touch(row)
        return current, restore, chosen.analyst

    def _queue_draft(
        self,
        board_id: str,
        current: SystemMap | None,
        restore: str,
        analyst: Analyst,
        material: Callable[[], str],
        source: VersionSource,
        label: Callable[[], str],
    ) -> None:
        """Queue the job that draws the map from `material`, refining `current`, and keep it as a new version."""

        def work() -> None:
            try:
                drawn = analyst.draft_map(material(), current)
            except LlmError as exc:
                self._fail(board_id, restore, exc.message)
                return
            except ValueError as exc:
                self._fail(board_id, restore, str(exc))
                return
            except Exception:
                # Network errors, broken archives and the like must not leave the board busy forever.
                log.exception("[boards] Drawing the map for %s failed unexpectedly.", board_id)
                self._fail(board_id, restore, "Reading the material failed. Try again.")
                return
            try:
                with self._db.session() as session:
                    target = session.get(BoardRow, board_id, with_for_update=True)
                    if not _still_claimed(target, "mapping", board_id):
                        return
                    before, before_analysis = target.map, _analysis_json(target, restore)
                    target.previous_map = current.model_dump(mode="json") if current else None
                    target.map = drawn.model_dump(mode="json")
                    target.status = "review"
                    target.error = None
                    verb = "Updated" if current else "Drew"
                    parts = f"{len(drawn.nodes)} parts and {len(drawn.flows)} flows"
                    _event(session, board_id, "mapped", f"{verb} the map: {parts}. Check it, then confirm.")
                    record_change(
                        session, target, before=before, before_analysis=before_analysis, source=source, label=label()
                    )
                    _touch(target)
            except Exception:
                # A failed save must still end the busy status, or the board spins until the next restart.
                log.exception("[boards] Saving the map for %s failed.", board_id)
                self._fail(board_id, restore, "Saving the map failed. Try again.")

        self._jobs.submit(work, f"draft_map {board_id}")

    def _fail(self, board_id: str, status: str, message: str) -> None:
        """Record a failed job and put the board back to `status`."""
        # A provider's error text can hold a NUL, which would fail this write too and leave the board busy.
        message = message.replace("\x00", "")
        log.warning("[boards] Job on %s failed: %s", board_id, message)
        try:
            with self._db.session() as session:
                row = session.get(BoardRow, board_id, with_for_update=True)
                # A board no longer busy moved on without this job, as after a restart, and keeps what it has now.
                if row is None or row.status not in BUSY:
                    return
                row.status = status
                row.error = message
                _event(session, board_id, "failed", message)
                _touch(row)
        except Exception:
            # Nothing is left to try here; a restart resets busy boards (`recover_interrupted`).
            log.exception("[boards] Recording the failure on %s failed too.", board_id)


# =============================================================================
# Row helpers
# =============================================================================


def read_map(row: BoardRow) -> SystemMap | None:
    """A board's stored map, or `None` when it has none or it no longer validates."""
    system = _validated(row.map, SystemMap, row.id)
    return _with_example_details(system) if row.example and system is not None else system


def _with_example_details(system: SystemMap) -> SystemMap:
    """Fill `how` and `code` on an example board saved before they existed, from the example's node of the same id."""
    # Accounts made earlier hold a copy of the example without them; this shows them without rewriting stored rows.
    example = next((e.map for e in load_examples() if e.map.name == system.name), None)
    if example is None:
        return system
    source = {node.id: node for node in example.nodes}
    nodes = [
        node.model_copy(update={"how": source[node.id].how, "code": source[node.id].code})
        if node.id in source and not node.how and not node.code
        else node
        for node in system.nodes
    ]
    return system.model_copy(update={"nodes": nodes})


def read_analysis(row: BoardRow) -> ThreatAnalysis | None:
    """A board's stored analysis, or `None` when it has none or it no longer validates."""
    return _validated(row.analysis, ThreatAnalysis, row.id)


def current_analysis(row: BoardRow) -> ThreatAnalysis | None:
    """The analysis only while it describes the board's map: on a `ready` board, else `None`."""
    # An edit or a new draft keeps the old threats stored until the next confirm, but they name parts of
    # the map before it, so quiz keys, answers, briefs and reports must not read them.
    return read_analysis(row) if row.status == "ready" else None


def read_previous_map(row: BoardRow) -> SystemMap | None:
    """The map before the latest update, if any."""
    return _validated(row.previous_map, SystemMap, row.id)


def _validated[T: (SystemMap, ThreatAnalysis)](data: dict[str, Any] | None, schema: type[T], board_id: str) -> T | None:
    """Validate stored JSON, logging and dropping it when an older shape no longer fits."""
    if data is None:
        return None
    try:
        return schema.model_validate(data)
    except ValidationError:
        log.warning("[boards] Stored %s on board %s no longer validates; ignoring it.", schema.__name__, board_id)
        return None


def _stable_status(row: BoardRow) -> str:
    """The status a board returns to when a job fails, from what it holds."""
    if row.status not in BUSY:
        return row.status
    if row.status == "analyzing":
        # Threats are found only from review, and the stored ones, if any, are for an older map.
        return "review"
    if row.analysis is not None and row.map is not None:
        return "ready"
    return "review" if row.map is not None else "empty"


def _still_claimed(row: BoardRow | None, status: str, board_id: str) -> TypeGuard[BoardRow]:
    """Whether a job's board is still in the busy `status` the job claimed, so its result may be saved."""
    # A restart during a deploy resets busy boards while the old instance's jobs may still finish; saving one then
    # would overwrite whatever the person did since.
    if row is None or row.status != status:
        log.warning("[boards] Dropping a finished job's result on %s: the board moved on while it ran.", board_id)
        return False
    return True


def _recovered_status(session: Session, row: BoardRow) -> str:
    """The status a board left busy by a restart goes back to, since the one it had before its job is not kept."""
    status = _stable_status(row)
    if status != "ready":
        return status
    # Stored threats describe the current map only when a confirm pinned them to its version; after a hand edit or an
    # agent change they are for an older map. A board older than version history leaves only the old guess.
    return "review" if newest_has_threats(session, row.id) is False else status


def _headline(material: Material) -> str:
    """What was added, for a version's label: the summary's first sentence, without the masking and skip counts."""
    return material.summary().split(". ")[0].rstrip(".")


def _analysis_json(row: BoardRow, status: str | None = None) -> dict[str, Any] | None:
    """The stored threats while they describe the stored map: on a board that is, or was before a job, `ready`."""
    return row.analysis if (status or row.status) == "ready" else None


def _event(session: Session, board_id: str, kind: str, text: str) -> None:
    """Append a line to a board's activity log."""
    # Event text quotes model and provider text, and Postgres refuses a NUL in it.
    session.add(BoardEventRow(board_id=board_id, kind=kind[:24], text=text.replace("\x00", "")[:1000]))


def _touch(row: BoardRow) -> None:
    """Mark a board changed so polling browsers refetch it."""
    row.updated_at = utcnow()
    row.revision = (row.revision or 0) + 1


def model_error(exc: LlmError) -> Exception:
    """Turn a model failure into the HTTP error the route returns."""
    from app.errors import AppError

    status = 503 if exc.code in ("unavailable", "timeout", "not_configured", "auth") else 502
    if exc.code == "rate_limited":
        status = 429
    return AppError(status, "model_error", exc.message)
