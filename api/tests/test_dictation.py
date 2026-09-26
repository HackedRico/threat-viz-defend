import base64
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.errors import AppError
from app.voice import AudioType, ElevenLabsTranscriber
from tests.conftest import ClientFactory, sign_up

CLIP = b"\x1aE\xdf\xa3" + bytes(4_000)


class FakeTranscriber:
    """Records what it was sent and answers with fixed text."""

    def __init__(self, text: str = "What happens if the database leaks?") -> None:
        self.text = text
        self.calls: list[tuple[bytes, AudioType]] = []

    def transcribe(self, audio: bytes, audio_type: AudioType) -> str:
        self.calls.append((audio, audio_type))
        return self.text


def dictation(audio: bytes = CLIP, audio_type: str = "audio/webm") -> dict[str, Any]:
    return {"audio": base64.b64encode(audio).decode(), "audio_type": audio_type}


def test_dictation_is_off_without_configuration(signed_in: TestClient) -> None:
    assert signed_in.get("/api/config").json()["dictation_enabled"] is False
    response = signed_in.post("/api/dictation", json=dictation())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "not_configured"


def test_dictation_needs_a_session(make_client: ClientFactory) -> None:
    client = make_client(transcriber=FakeTranscriber())
    assert client.post("/api/dictation", json=dictation()).status_code == 401


def test_dictation_returns_the_text_and_spends_one(make_client: ClientFactory) -> None:
    fake = FakeTranscriber()
    client = make_client(transcriber=fake)
    sign_up(client)
    assert client.get("/api/config").json()["dictation_enabled"] is True
    response = client.post("/api/dictation", json=dictation(audio_type="audio/mp4"))
    assert response.status_code == 200, response.text
    assert response.json() == {"text": "What happens if the database leaks?"}
    assert fake.calls == [(CLIP, "audio/mp4")]
    usage = client.get("/api/auth/me").json()["usage"]
    assert usage["dictations_today"] == 1
    assert usage["model_calls_today"] == 0


def test_long_transcripts_are_cut_to_fit_the_ask_box(make_client: ClientFactory) -> None:
    client = make_client(transcriber=FakeTranscriber("word " * 1_000))
    sign_up(client)
    assert len(client.post("/api/dictation", json=dictation()).json()["text"]) == 2_000


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"audio": "not base64!", "audio_type": "audio/webm"}, 400),
        (dictation(audio=b"tiny"), 400),
        (dictation(audio_type="video/quicktime"), 422),
        ({**dictation(), "language": "en"}, 422),
    ],
)
def test_bad_clips_are_refused_before_any_spend(make_client: ClientFactory, body: dict[str, Any], status: int) -> None:
    fake = FakeTranscriber()
    client = make_client(transcriber=fake)
    sign_up(client)
    assert client.post("/api/dictation", json=body).status_code == status
    assert fake.calls == []
    assert client.get("/api/auth/me").json()["usage"]["dictations_today"] == 0


def test_the_daily_dictation_allowance_is_enforced(make_client: ClientFactory) -> None:
    client = make_client(transcriber=FakeTranscriber(), daily_dictations=1)
    sign_up(client)
    assert client.post("/api/dictation", json=dictation()).status_code == 200
    refused = client.post("/api/dictation", json=dictation())
    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "budget_exhausted"
    assert "dictations" in refused.json()["error"]["message"]


def test_dictation_follows_the_elevenlabs_key_and_allowance() -> None:
    assert not load_settings({}).dictation_configured
    settings = load_settings({"ELEVENLABS_API_KEY": "xi-test"})
    assert settings.dictation_configured
    assert settings.elevenlabs_stt_model == "scribe_v2"
    assert not load_settings({"ELEVENLABS_API_KEY": "xi-test", "DAILY_DICTATIONS": "0"}).dictation_configured
    assert load_settings({"ELEVENLABS_STT_MODEL": "scribe_v1"}).elevenlabs_stt_model == "scribe_v1"


# =============================================================================
# The ElevenLabs client, against a mock transport
# =============================================================================


def transcriber(handle: Any) -> ElevenLabsTranscriber:
    client = httpx.Client(
        base_url="https://api.elevenlabs.io", headers={"xi-api-key": "xi-test"}, transport=httpx.MockTransport(handle)
    )
    return ElevenLabsTranscriber("xi-test", "scribe_v2", client=client)


def test_the_transcriber_sends_the_clip_as_a_speech_to_text_upload() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"text": "  Where can untrusted\ninput reach an AI part? ", "words": []})

    assert transcriber(handle).transcribe(CLIP, "audio/webm") == "Where can untrusted input reach an AI part?"
    request = seen[0]
    body = request.read()
    assert request.method == "POST"
    assert request.url.path == "/v1/speech-to-text"
    assert request.headers["xi-api-key"] == "xi-test"
    assert request.headers["content-type"].startswith("multipart/form-data")
    assert b'name="model_id"\r\n\r\nscribe_v2' in body
    assert b'name="tag_audio_events"\r\n\r\nfalse' in body
    assert b'filename="question.webm"' in body
    assert b"Content-Type: audio/webm" in body
    assert CLIP in body


@pytest.mark.parametrize(
    ("answer", "status", "code"),
    [(401, 503, "voice_error"), (429, 429, "voice_error"), (422, 400, "bad_request"), (500, 503, "voice_error")],
)
def test_transcriber_failures_are_explained(answer: int, status: int, code: str) -> None:
    with pytest.raises(AppError) as info:
        transcriber(lambda _: httpx.Response(answer, json={"detail": "nope"})).transcribe(CLIP, "audio/ogg")
    assert (info.value.status, info.value.code) == (status, code)


def test_an_unreachable_speech_service_is_explained() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(AppError) as info:
        transcriber(handle).transcribe(CLIP, "audio/webm")
    assert info.value.status == 503
