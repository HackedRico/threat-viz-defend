from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.analysis.analyst import Analyst
from app.boards.service import Boards, model_error, read_analysis, read_map
from app.db import Database
from app.domain.models import GradeVerdict
from app.domain.quiz import QuizQuestion, Result, build_quiz, grade_choice, mastery
from app.errors import bad_request, conflict, not_found
from app.limits import Budget
from app.llm.base import LlmError
from app.schemas import AnsweredOut, AnswerIn, AttemptOut, QuestionOut, QuizOut
from app.tables import BoardRow, QuizAttemptRow

# =============================================================================
# Module Overview
# =============================================================================
# The whiteboard defense as a service. `Quiz.state` rebuilds the questions from
# a board's current map and analysis and pairs each with its latest attempt.
# `Quiz.answer` grades choice questions by code and open ones with the analyst,
# stores the attempt, and returns the explanation that teaches the answer.

_OPEN_RESULT: dict[GradeVerdict, Result] = {"solid": "correct", "partial": "partial", "missed": "wrong"}


class Quiz:
    """Questions, grading and progress for one user's board."""

    def __init__(self, db: Database, boards: Boards, analyst: Analyst, budget: Budget) -> None:
        self._db = db
        self._boards = boards
        self._analyst = analyst
        self._budget = budget

    def state(self, session: Session, user_id: str, board_id: str) -> QuizOut:
        """The questions for the board as it stands, and the latest result for each."""
        row = self._boards.get(session, user_id, board_id)
        questions = _questions(row)
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
        )

    def answer(self, user_id: str, board_id: str, body: AnswerIn) -> AnsweredOut:
        """Grade one answer, store it, and return what it teaches."""
        with self._db.session() as session:
            row = self._boards.get(session, user_id, board_id)
            question = next((q for q in _questions(row) if q.id == body.question_id), None)
            if question is None:
                raise not_found("That question is out of date because the board changed. Reload the quiz.")
            system, analysis, version = read_map(row), read_analysis(row), row.analysis_version
            if question.kind == "open":
                if not (body.text and body.text.strip()):
                    raise bad_request("Type or say an answer in your own words first.")
                self._budget.spend(session, user_id, "model", "grade")

        if question.kind == "open":
            assert system is not None  # a question exists only when the board has a map
            try:
                grade = self._analyst.grade(system, analysis, question, (body.text or "").strip())
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
        return AnsweredOut(attempt=attempt, mastery=state.mastery)

    def reset(self, session: Session, user_id: str, board_id: str) -> None:
        """Forget every attempt on a board, to start the defense over."""
        row = self._boards.get(session, user_id, board_id)
        session.execute(
            delete(QuizAttemptRow).where(QuizAttemptRow.user_id == user_id, QuizAttemptRow.board_id == row.id)
        )

    def question(self, session: Session, user_id: str, board_id: str, question_id: str) -> QuizQuestion:
        """One current question with its key, for tools that speak it."""
        row = self._boards.get(session, user_id, board_id)
        found = next((q for q in _questions(row) if q.id == question_id), None)
        if found is None:
            raise not_found("That question is out of date because the board changed.")
        return found


def _questions(row: BoardRow) -> list[QuizQuestion]:
    """The questions for a board's current map and analysis."""
    system = read_map(row)
    return build_quiz(system, read_analysis(row)) if system is not None else []


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
