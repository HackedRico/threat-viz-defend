from fastapi import APIRouter, status

from app.boards.service import read_analysis, read_map
from app.context import CurrentUser, Db, Svc
from app.domain.briefing import brief
from app.domain.quiz import build_quiz
from app.errors import AppError, conflict
from app.schemas import AnsweredOut, AnswerIn, QuizOut, VoiceSessionOut

# =============================================================================
# Module Overview
# =============================================================================
# The whiteboard defense: the text quiz and the voice coach. The quiz is built
# from the board's current map and threats; the voice route mints a private
# ElevenLabs conversation token and the context the coach speaks from.

router = APIRouter(prefix="/api/boards", tags=["quiz"])


@router.get("/{board_id}/quiz")
def get_quiz(board_id: str, user: CurrentUser, svc: Svc, session: Db) -> QuizOut:
    """The questions for the board as it stands, and the latest result for each."""
    return svc.quiz.state(session, user.id, board_id)


@router.post("/{board_id}/quiz/answers")
def answer_question(board_id: str, body: AnswerIn, user: CurrentUser, svc: Svc) -> AnsweredOut:
    """Grade one answer: choice questions by code, open ones by the model."""
    svc.limiter.hit(f"quiz-answer:{user.id}", 60, 60, "Too many answers in a minute. Slow down a little.")
    return svc.quiz.answer(user.id, board_id, body)


@router.delete("/{board_id}/quiz", status_code=status.HTTP_204_NO_CONTENT)
def reset_quiz(board_id: str, user: CurrentUser, svc: Svc, session: Db) -> None:
    """Forget every answer on the board and start the defense over."""
    svc.quiz.reset(session, user.id, board_id)


@router.post("/{board_id}/voice")
def start_voice(board_id: str, user: CurrentUser, svc: Svc, session: Db) -> VoiceSessionOut:
    """Mint a one-conversation token for the private voice coach, with the board's context."""
    if svc.voice is None:
        raise AppError(503, "not_configured", "The voice coach is not set up on this server. Use the text quiz.")
    row = svc.boards.get(session, user.id, board_id)
    system = read_map(row)
    if system is None:
        raise conflict("Add material and draw a map before starting the voice coach.")
    analysis = read_analysis(row)
    svc.budget.spend(session, user.id, "voice", "conversation")
    token = svc.voice.conversation_token()
    questions = build_quiz(system, analysis)
    return VoiceSessionOut(
        conversation_token=token,
        dynamic_variables={
            "user_name": user.username,
            "system_name": system.name,
            "board_brief": brief(system, analysis, max_threats=2)[:1500],
            "question_count": str(len(questions)),
        },
    )
