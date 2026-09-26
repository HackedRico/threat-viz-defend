import logging
from typing import Literal, Protocol

import httpx

from app.errors import AppError

# =============================================================================
# Module Overview
# =============================================================================
# The ElevenLabs side of voice: the coach and dictation. The agent is private,
# so a browser cannot start a conversation with its id alone: `ElevenLabsVoice`
# asks the ElevenLabs API, with the server's key, for a short-lived
# conversation token that the browser spends once. `ElevenLabsTranscriber`
# turns a spoken question into text with ElevenLabs Speech to Text; the browser
# sends the recording here rather than to ElevenLabs, so the key never leaves
# the server and the audio is never stored.

log = logging.getLogger(__name__)

ELEVENLABS_API = "https://api.elevenlabs.io"

AudioType = Literal["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"]

# ElevenLabs reads the format from the upload's name as well as its type.
_EXTENSIONS: dict[str, str] = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
}


class VoiceClient(Protocol):
    """Anything that can mint a one-conversation credential for the voice agent."""

    def conversation_token(self) -> str:
        """A fresh token the browser uses to start one private conversation."""
        ...


class Transcriber(Protocol):
    """Anything that can turn a short recording into text."""

    def transcribe(self, audio: bytes, audio_type: AudioType) -> str:
        """The words spoken in `audio`, or an empty string when nobody spoke."""
        ...


def _client(api_key: str, timeout_s: float) -> httpx.Client:
    """An HTTP client for the ElevenLabs API that carries the server's key."""
    return httpx.Client(
        base_url=ELEVENLABS_API, timeout=timeout_s, headers={"xi-api-key": api_key}, follow_redirects=False
    )


class ElevenLabsVoice:
    """Mints conversation tokens for one private ElevenLabs agent."""

    def __init__(self, api_key: str, agent_id: str, client: httpx.Client | None = None) -> None:
        self._agent_id = agent_id
        self._client = client or _client(api_key, 10.0)

    def conversation_token(self) -> str:
        """Ask ElevenLabs for a WebRTC conversation token for the agent."""
        try:
            response = self._client.get("/v1/convai/conversation/token", params={"agent_id": self._agent_id})
        except httpx.HTTPError as exc:
            raise AppError(503, "voice_error", "The voice service is unreachable. Use the text quiz for now.") from exc
        if response.status_code in (401, 403):
            log.error("[voice] ElevenLabs rejected the API key or agent id (%s).", response.status_code)
            raise AppError(503, "voice_error", "The voice coach is misconfigured on the server. Use the text quiz.")
        if response.status_code == 429:
            raise AppError(429, "voice_error", "The voice service is busy. Try again in a minute.")
        if response.status_code != 200:
            log.error("[voice] ElevenLabs answered %s: %s", response.status_code, response.text[:200])
            raise AppError(503, "voice_error", "The voice service failed to start a conversation. Try again.")
        token = response.json().get("token")
        if not isinstance(token, str) or not token:
            raise AppError(503, "voice_error", "The voice service returned no token. Try again.")
        return token


class ElevenLabsTranscriber:
    """Transcribes spoken questions with ElevenLabs Speech to Text."""

    def __init__(self, api_key: str, model: str, client: httpx.Client | None = None) -> None:
        self._model = model
        # A minute of speech takes a few seconds; the cap keeps a stuck call from holding a worker.
        self._client = client or _client(api_key, 30.0)

    def transcribe(self, audio: bytes, audio_type: AudioType) -> str:
        """Send one recording to ElevenLabs and return its text, trimmed."""
        name = f"question.{_EXTENSIONS[audio_type]}"
        # Audio event tags such as "(laughter)" would land in the question box, so they stay off.
        data = {"model_id": self._model, "tag_audio_events": "false"}
        try:
            response = self._client.post("/v1/speech-to-text", data=data, files={"file": (name, audio, audio_type)})
        except httpx.HTTPError as exc:
            raise AppError(503, "voice_error", "The speech service is unreachable. Type your question.") from exc
        if response.status_code in (401, 403):
            log.error("[dictation] ElevenLabs refused the key (%s); it needs Speech to Text.", response.status_code)
            raise AppError(503, "voice_error", "Dictation is misconfigured on the server. Type your question instead.")
        if response.status_code == 429:
            raise AppError(429, "voice_error", "The speech service is busy. Try again in a minute.")
        if response.status_code in (400, 422):
            # A clip too short or damaged to decode lands here, and so does a wrong `ELEVENLABS_STT_MODEL`.
            log.warning("[dictation] ElevenLabs refused a clip (%s): %s", response.status_code, response.text[:200])
            raise AppError(400, "bad_request", "That recording could not be transcribed. Try again, or type it.")
        if response.status_code != 200:
            log.error("[dictation] ElevenLabs answered %s: %s", response.status_code, response.text[:200])
            raise AppError(503, "voice_error", "The speech service failed. Try again, or type your question.")
        text = response.json().get("text")
        if not isinstance(text, str):
            raise AppError(503, "voice_error", "The speech service returned no text. Try again.")
        return " ".join(text.split())
