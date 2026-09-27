import threading
import time
from collections.abc import Callable

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.boards.service import Boards, current_analysis, model_error, read_map
from app.db import Database
from app.domain.models import GradeVerdict
from app.domain.notes import notes_about, quiz_note, weak_topics
from app.domain.quiz import QuestionTopic, QuizQuestion, Result, build_quiz, grade_choice, mastery
from app.errors import bad_request, conflict, not_found
from app.limits import Budget
from app.llm.base import LlmError
from app.memory import MemorySource, NoMemory
from app.providers.service import AnalystSource
from app.schemas import AnsweredOut, AnswerIn, AttemptOut, MemoryUse, QuestionOut, QuizFocus, QuizOut
from app.tables import BoardRow, QuizAttemptRow

# =============================================================================
# Module Overview
# =============================================================================
# The whiteboard defense as a service. `Quiz.state` rebuilds the questions from
# a board's current map and analysis and pairs each with its latest attempt.
# `Quiz.answer` grades choice questions by code and open ones with the analyst,
# stores the attempt, and returns the explanation that teaches the answer.
# With Backboard memory on, grading an open answer recalls earlier notes, every
# answer is kept as a note, and `Quiz.focus` reads the notes back into the
# topics the developer found hard, which the quiz then asks first.

_OPEN_RESULT: dict[GradeVerdict, Result] = {"solid": "correct", "partial": "partial", "missed": "wrong"}
# What the focus asks memory for; the notes `quiz_note` writes name topics and results in these words.
_FOCUS_QUERY = "quiz topics and questions they got wrong or only partly right"
_FOCUS_RECALL = 10
# Long enough that the order holds still through one sitting of the quiz, short enough to pick up new misses.
_FOCUS_TTL_S = 20 * 60


class Quiz:
    """Questions, grading and progress for one user's board."""

    def __init__(
        self,
        db: Database,
        boards: Boards,
        analysts: AnalystSource,
        budget: Budget,
        memory: MemorySource | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._db = db
        self._boards = boards
        self._analysts = analysts
        self._budget = budget
        self._memory = memory or NoMemory()
        self._clock = clock
        self._focus: dict[tuple[str, str, int], tuple[float, QuizFocus | None]] = {}
        self._focus_lock = threading.Lock()

    def state(self, session: Session, user_id: str, board_id: str, focus: QuizFocus | None = None) -> QuizOut:
        """The questions for the board as it stands, `focus` topics first, and the latest result for each."""
        row = self._boards.get(session, user_id, board_id)
        questions = _ordered(_questions(row), focus.topics if focus else [])
        attempts = _latest(session, user_id, row)
        results = {q.id: _attempt_out(q, attempts[q.id]) for q in questions if q.id in attempts}
        latest = {qid: attempt.result for qid, attempt in results.items()}
        return QuizOut(
            analysis_version=row.analysis_version,
            questions=[
                QuestionOut(id=q.id, topic=q.topic, kind=q.kind, prompt=q.prompt, options=q.options) for q in questions
            ],
            results=results,
            mastery=mastery(questions, latest),
            focus=focus,
        )

    def focus(self, user_id: str, board_id: str) -> QuizFocus | None:
        """The topics memory says this developer found hard before, that this board's quiz covers; `None` without."""
        memory = self._memory.for_user(user_id)
        if memory is None:
            return None
        with self._db.session() as session:
            row = self._boards.get(session, user_id, board_id)
            key = (user_id, board_id, row.analysis_version)
            covered = {q.topic for q in _questions(row)}
        if not covered:
            return None
        with self._focus_lock:
            cached = self._focus.get(key)
            if cached is not None and cached[0] > self._clock():
                return cached[1]
        # Outside the lock and any session: a slow Backboard must hold neither.
        notes = memory.recall(_FOCUS_QUERY, _FOCUS_RECALL)
        topics = [topic for topic in weak_topics(notes) if topic in covered]
        found = QuizFocus(topics=topics, notes=notes_about(notes, topics)[:3]) if topics else None
        with self._focus_lock:
            now = self._clock()
            # Old entries go when a new one lands, so the cache cannot grow without bound.
            self._focus = {k: v for k, v in self._focus.items() if v[0] > now}
            self._focus[key] = (now + _FOCUS_TTL_S, found)
        return found

    def forget_focus(self, user_id: str, board_id: str) -> None:
        """Drop the cached focus for a board, so the next quiz reads memory again."""
        with self._focus_lock:
            self._focus = {k: v for k, v in self._focus.items() if k[:2] != (user_id, board_id)}

    def answer(self, user_id: str, board_id: str, body: AnswerIn) -> AnsweredOut:
        """Grade one answer, store it, and return what it teaches."""
        with self._db.session() as session:
            row = self._boards.get(session, user_id, board_id)
            question = next((q for q in _questions(row) if q.id == body.question_id), None)
            if question is None:
                raise not_found("That question is out of date because the board changed. Reload the quiz.")
            system, analysis, version = read_map(row), current_analysis(row), row.analysis_version
            title = row.title
            if question.kind == "open" and not (body.text and body.text.strip()):
                raise bad_request("Type or say an answer in your own words first.")
        if question.kind == "open":
            # Outside any session: a saved provider's host is resolved here, and a slow lookup must not hold one.
            chosen = self._analysts.for_user(user_id)
            with self._db.session() as session:
                self._budget.spend(session, user_id, "model", "grade", own_key=chosen.own_key)
        memory = self._memory.for_user(user_id)
        recalled: list[str] = []

        if question.kind == "open":
            assert system is not None  # a question exists only when the board has a map
            recalled = memory.recall(question.prompt) if memory is not None else []
            try:
                grade = chosen.analyst.grade(system, analysis, question, (body.text or "").strip(), recalled)
            except LlmError as exc:
                raise model_error(exc) from exc
            result, feedback, highlight = (
                _OPEN_RESULT[grade.verdict],
                grade.feedback,
                grade.highlight or question.highlight,
            )
            picked: list[str] = []
        else:
            known = {o.id for o in question.options}
            picked = [c for c in dict.fromkeys(body.choice_ids) if c in known]
            if not picked:
                raise bad_request("Pick at least one option.")
            choice = grade_choice(question, picked)
            result, feedback, highlight = (
                choice.result,
                _choice_feedback(question, choice.missed, choice.wrong),
                question.highlight,
            )

        with self._db.session() as session:
            # Grading an open answer takes seconds; if the board moved on meanwhile, nothing is saved.
            now = self._boards.get(session, user_id, board_id)
            if now.analysis_version != version or current_analysis(now) is None:
                raise conflict("The board changed while grading. Reload the quiz.")
            session.add(
                QuizAttemptRow(
                    user_id=user_id,
                    board_id=board_id,
                    analysis_version=version,
                    question_id=question.id,
                    answer={"ids": picked, "text": body.text if question.kind == "open" else None},
                    result=result,
                    feedback=feedback,
                )
            )
            session.flush()
            state = self.state(session, user_id, board_id)
        attempt = state.results.get(question.id)
        if attempt is None:
            raise conflict("The board changed while grading. Reload the quiz.")
        attempt.highlight = highlight
        if memory is not None:
            # The topic and result only: the developer's own words stay out of memory.
            self._boards.remember(memory, quiz_note(title, question, result))
        use = MemoryUse(recalled=recalled, kept=True) if memory is not None else None
        return AnsweredOut(attempt=attempt, mastery=state.mastery, memory=use)

    def reset(self, session: Session, user_id: str, board_id: str) -> None:
        """Forget every attempt on a board, to start the defense over."""
        row = self._boards.get(session, user_id, board_id)
        session.execute(
            delete(QuizAttemptRow).where(QuizAttemptRow.user_id == user_id, QuizAttemptRow.board_id == row.id)
        )
        self.forget_focus(user_id, board_id)

    def questions(self, session: Session, user_id: str, board_id: str) -> list[QuizQuestion]:
        """The current questions with their keys, for tools that speak them."""
        return _questions(self._boards.get(session, user_id, board_id))

    def question(self, session: Session, user_id: str, board_id: str, question_id: str) -> QuizQuestion:
        """One current question with its key, for tools that speak it."""
        row = self._boards.get(session, user_id, board_id)
        found = next((q for q in _questions(row) if q.id == question_id), None)
        if found is None:
            raise not_found("That question is out of date because the board changed.")
        return found


def _ordered(questions: list[QuizQuestion], first: list[QuestionTopic]) -> list[QuizQuestion]:
    """`questions` with those on the `first` topics moved ahead, in the order of `first`, the rest as they were."""
    rank = {topic: index for index, topic in enumerate(first)}
    return sorted(questions, key=lambda q: rank.get(q.topic, len(first)))


def _questions(row: BoardRow) -> list[QuizQuestion]:
    """The questions for a ready board's map and analysis; none before its threats are found."""
    system, analysis = read_map(row), current_analysis(row)
    # Attempts are kept per analysis version, so a map changed since then must not be quizzed on them.
    return build_quiz(system, analysis) if system is not None and analysis is not None else []


def _latest(session: Session, user_id: str, row: BoardRow) -> dict[str, QuizAttemptRow]:
    """The newest attempt per question on the board's current analysis version."""
    query = (
        select(QuizAttemptRow)
        .where(
            QuizAttemptRow.user_id == user_id,
            QuizAttemptRow.board_id == row.id,
            QuizAttemptRow.analysis_version == row.analysis_version,
        )
        .order_by(QuizAttemptRow.id)
    )
    # Later rows overwrite earlier ones, leaving the newest attempt per question.
    return {attempt.question_id: attempt for attempt in session.scalars(query)}


def _attempt_out(question: QuizQuestion, attempt: QuizAttemptRow) -> AttemptOut:
    """An attempt with the question's key and explanation, now that it has been answered."""
    ids = [str(i) for i in attempt.answer.get("ids", [])]
    text = attempt.answer.get("text")
    return AttemptOut(
        question_id=question.id,
        result=attempt.result,
        feedback=attempt.feedback,
        explanation=question.explanation,
        evidence=question.evidence,
        highlight=question.highlight,
        correct_ids=question.answer,
        your_ids=ids,
        your_text=str(text) if text is not None else None,
    )


def _choice_feedback(question: QuizQuestion, missed: list[str], wrong: list[str]) -> str:
    """Say what a choice answer got right and wrong, by option label."""
    labels = {o.id: o.label for o in question.options}
    if not missed and not wrong:
        return "Right."
    parts: list[str] = []
    if missed:
        parts.append("You left out " + "; ".join(labels[i] for i in missed if i in labels) + ".")
    if wrong:
        parts.append("Not part of the answer: " + "; ".join(labels[i] for i in wrong if i in labels) + ".")
    return " ".join(parts)
