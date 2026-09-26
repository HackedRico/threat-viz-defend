import logging
from typing import Protocol

import httpx

from app.errors import AppError

# =============================================================================
# Module Overview
# =============================================================================
# The ElevenLabs side of the voice coach. The agent is private, so a browser
# cannot start a conversation with its id alone: `ElevenLabsVoice` asks the
# ElevenLabs API, with the server's key, for a short-lived conversation token
# that the browser spends once. The key itself never leaves the server.

log = logging.getLogger(__name__)

ELEVENLABS_API = "https://api.elevenlabs.io"


class VoiceClient(Protocol):
    """Anything that can mint a one-conversation credential for the voice agent."""

    def conversation_token(self) -> str:
        """A fresh token the browser uses to start one private conversation."""
        ...


class ElevenLabsVoice:
    """Mints conversation tokens for one private ElevenLabs agent."""

    def __init__(self, api_key: str, agent_id: str, client: httpx.Client | None = None) -> None:
        self._agent_id = agent_id
        self._client = client or httpx.Client(
            base_url=ELEVENLABS_API, timeout=10.0, headers={"xi-api-key": api_key}, follow_redirects=False
        )

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
