from collections.abc import Callable, Iterator
from dataclasses import replace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.analysis.analyst import Analyst, DemoAnalyst
from app.config import Settings
from app.jobs import InlineJobs
from app.main import create_app
from app.providers.netguard import Resolver
from app.voice import Transcriber, VoiceClient
from tests.factories import inbox

# =============================================================================
# Module Overview
# =============================================================================
# Fixtures for API tests. `make_client` builds the whole app on an in-memory
# database with jobs run inline, the demo analyst and no voice or dictation, and each
# option can swap one piece. `signed_in` returns a client with a fresh account.

INVITE = "letmein-2026"
PASSWORD = "correct horse battery"

BASE_SETTINGS = Settings(
    environment="test",
    database_url="sqlite://",
    static_dir=None,
    invite_codes=(INVITE,),
    allowed_hosts=("testserver", "localhost"),
)

ClientFactory = Callable[..., TestClient]


@pytest.fixture
def make_client() -> Iterator[ClientFactory]:
    """Build app clients; every client opened here is closed after the test."""
    opened: list[TestClient] = []

    def build(
        *,
        analyst: Analyst | None = None,
        voice: VoiceClient | None = None,
        transcriber: Transcriber | None = None,
        resolver: Resolver | None = None,
        **overrides: Any,
    ) -> TestClient:
        settings = replace(BASE_SETTINGS, **overrides)
        app = create_app(
            settings,
            analyst=analyst or DemoAnalyst(),
            jobs=InlineJobs(),
            voice=voice,
            transcriber=transcriber,
            resolver=resolver or _no_dns,
        )
        client = TestClient(app)
        client.__enter__()
        opened.append(client)
        return client

    yield build
    for client in opened:
        client.__exit__(None, None, None)


def _no_dns(host: str, port: int) -> list[str]:
    """Tests never touch real DNS; a test that needs a public host passes its own resolver."""
    raise OSError(f"no DNS in tests for {host}")


@pytest.fixture
def client(make_client: ClientFactory) -> TestClient:
    """A client for the default test app, signed out."""
    return make_client()


def sign_up(client: TestClient, username: str = "alice") -> dict[str, Any]:
    """Create an account and return the response body; the client keeps the cookie."""
    response = client.post("/api/auth/signup", json={"username": username, "password": PASSWORD, "invite_code": INVITE})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


@pytest.fixture
def signed_in(client: TestClient) -> TestClient:
    """A client signed in as a new user."""
    sign_up(client)
    return client


def example_material() -> dict[str, Any]:
    """A sources body holding the example's design notes, which the demo analyst can map."""
    return {"sources": [{"name": "notes.md", "kind": "text", "text": inbox().material}]}
