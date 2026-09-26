import base64
import binascii

from fastapi import APIRouter

from app.context import CurrentUser, Svc
from app.errors import AppError, bad_request
from app.schemas import DictationIn, DictationOut

# =============================================================================
# Module Overview
# =============================================================================
# Dictation: a spoken question in, its text out. The browser records a short
# clip and sends it here as base64 JSON; the server spends one dictation and
# passes the clip to ElevenLabs Speech to Text with the server's key. The clip
# and the text are never stored; the text goes back to the browser, where the
# user reads it before asking.

router = APIRouter(prefix="/api/dictation", tags=["dictation"])

# A webm header alone is a few hundred bytes; anything this small holds no speech.
_MIN_AUDIO_BYTES = 1_000
# A spoken question is short, and the ask box holds at most this many characters.
_MAX_TEXT = 2_000


@router.post("")
def dictate(body: DictationIn, user: CurrentUser, svc: Svc) -> DictationOut:
    """Transcribe one short recording of a question."""
    if svc.transcriber is None:
        raise AppError(503, "not_configured", "Dictation is not set up on this server. Type your question instead.")
    audio = _decode(body.audio)
    svc.limiter.hit(f"dictation-minute:{user.id}", 10, 60, "You are dictating very quickly. Wait a moment.")
    # Spend in its own short transaction, as asking does, so no database lock is held while ElevenLabs works.
    with svc.db.session() as session:
        svc.budget.spend(session, user.id, "dictation", "question")
    text = svc.transcriber.transcribe(audio, body.audio_type)
    return DictationOut(text=text[:_MAX_TEXT])


def _decode(audio: str) -> bytes:
    """The recording's bytes, refusing bodies that are not base64 or hold too little to be speech."""
    try:
        decoded = base64.b64decode(audio, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise bad_request("The recording was not sent as base64. Reload the page and try again.") from exc
    if len(decoded) < _MIN_AUDIO_BYTES:
        raise bad_request("That recording was too short. Hold the button a moment longer.")
    return decoded
