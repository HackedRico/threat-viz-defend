import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.routes import boards

# =============================================================================
# Module Overview
# =============================================================================
# The Snowflake export against a scripted SQL API: the statements it sends, the
# token staying in the header, and the checks that keep the host Snowflake's.

TARGET = {
    "account": "myorg-myaccount",
    "token": "pat-token-for-tests",
    "warehouse": "COMPUTE_WH",
    "database": "THREATVIZ",
    "schema_name": "PUBLIC",
}


def _scripted(monkeypatch: pytest.MonkeyPatch, status: int = 200) -> list[httpx.Request]:
    """Route the export to a fake SQL API that records every request."""
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json={"message": "Object does not exist" if status >= 400 else "ok"})

    monkeypatch.setattr(boards, "snowflake_client", lambda: httpx.Client(transport=httpx.MockTransport(handle)))
    return seen


def test_a_ready_board_replaces_its_rows_in_snowflake(signed_in: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _scripted(monkeypatch)
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    response = signed_in.post(f"/api/boards/{board_id}/snowflake", json=TARGET)
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["rows"] > 0
    assert out["table"] == "THREATVIZ.PUBLIC.threat_findings"
    assert [str(r.url) for r in seen] == ["https://myorg-myaccount.snowflakecomputing.com/api/v2/statements"] * 6
    statements: list[dict[str, Any]] = [json.loads(r.content) for r in seen]
    assert statements[0]["statement"].startswith("CREATE TABLE IF NOT EXISTS")
    assert all(s["statement"].startswith("CREATE OR REPLACE VIEW") for s in statements[1:4])
    assert statements[4]["bindings"]["1"]["value"] == board_id
    assert len(statements[5]["bindings"]["1"]["value"]) == out["rows"]
    assert seen[0].headers["authorization"] == "Bearer pat-token-for-tests"
    assert all("pat-token-for-tests" not in r.content.decode() for r in seen)


def test_snowflake_errors_reach_the_user(signed_in: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _scripted(monkeypatch, status=404)
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    response = signed_in.post(f"/api/boards/{board_id}/snowflake", json=TARGET)
    assert response.status_code == 502
    assert "Object does not exist" in response.json()["error"]["message"]


@pytest.mark.parametrize("account", ["evil.example.com/x", "a@b", "acct?x=1", ""])
def test_an_account_that_is_not_an_identifier_is_refused(
    signed_in: TestClient, monkeypatch: pytest.MonkeyPatch, account: str
) -> None:
    seen = _scripted(monkeypatch)
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    response = signed_in.post(f"/api/boards/{board_id}/snowflake", json={**TARGET, "account": account})
    assert response.status_code == 422
    assert seen == []


def test_a_board_without_threats_has_nothing_to_send(signed_in: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _scripted(monkeypatch)
    board_id = signed_in.post("/api/boards", json={"title": "Empty"}).json()["id"]
    assert signed_in.post(f"/api/boards/{board_id}/snowflake", json=TARGET).status_code == 409
    assert seen == []
