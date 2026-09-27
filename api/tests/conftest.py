import json
import re
from collections.abc import Callable, Iterator
from dataclasses import replace
from typing import Any

import httpx
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
# `FakeBackboard` stands in for Backboard's memory API when a test turns memory on.

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
        backboard: httpx.BaseTransport | None = None,
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
            backboard=backboard,
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


class FakeBackboard:
    """Backboard's assistants and memory API in memory; search returns an assistant's notes newest first."""

    def __init__(self) -> None:
        self.owners: dict[str, str] = {}
        self.notes: dict[str, list[dict[str, Any]]] = {}
        self.calls: list[tuple[str, str, str]] = []

    def transport(self) -> httpx.MockTransport:
        """A transport for `make_client(backboard=...)`."""
        return httpx.MockTransport(self._handle)

    def kept(self) -> list[str]:
        """Every note kept, across assistants, in the order they arrived."""
        return [note["content"] for notes in self.notes.values() for note in notes]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        key = request.headers.get("x-api-key", "")
        path = request.url.path.removeprefix("/api")
        self.calls.append((request.method, path, key))
        body: dict[str, Any] = json.loads(request.content) if request.content else {}
        if path == "/assistants":
            if request.method == "GET":
                return httpx.Response(200, json=[{"assistant_id": a} for a, k in self.owners.items() if k == key])
            assistant = f"asst-{len(self.owners) + 1}"
            self.owners[assistant], self.notes[assistant] = key, []
            return httpx.Response(200, json={"assistant_id": assistant, "name": body["name"]})
        found = re.fullmatch(r"/assistants/([^/]+)/memories(/search)?", path)
        if found is None or self.owners.get(found[1]) != key:
            return httpx.Response(404, json={"detail": "Not found"})
        notes = self.notes[found[1]]
        if found[2]:
            newest = list(reversed(notes))[: body.get("limit", 5)]
            return httpx.Response(200, json={"memories": newest, "total_count": len(notes)})
        if request.method == "POST":
            stamp = f"2026-09-27T12:00:{len(notes):02d}Z"
            notes.append({"id": f"m{len(notes) + 1}", "content": body["content"], "created_at": stamp})
            return httpx.Response(201, json={"operation_id": "op-1", "status": "pending"})
        if request.method == "GET":
            return httpx.Response(200, json={"memories": notes, "total_count": len(notes)})
        notes.clear()
        return httpx.Response(200, json={"success": True, "message": "Deleted"})
