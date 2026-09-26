import pytest
from fastapi.testclient import TestClient

from app.boards.github import parse_repo_url
from app.config import load_settings
from app.errors import AppError
from tests.conftest import ClientFactory, example_material, sign_up


def test_security_headers_are_on_every_response(client: TestClient) -> None:
    response = client.get("/api/health")
    csp = response.headers["content-security-policy"]
    assert "script-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "wss://livekit.rtc.elevenlabs.io" in csp
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "microphone=(self)" in response.headers["permissions-policy"]


def test_cross_site_writes_are_refused(signed_in: TestClient) -> None:
    forged = signed_in.post("/api/boards", json={"title": "x"}, headers={"Sec-Fetch-Site": "cross-site"})
    assert forged.status_code == 403
    other = signed_in.post("/api/boards", json={"title": "x"}, headers={"Origin": "https://evil.example"})
    assert other.status_code == 403


def test_writes_must_be_json(signed_in: TestClient) -> None:
    response = signed_in.post(
        "/api/boards", content="title=x", headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    assert response.status_code == 415


def test_large_bodies_are_refused(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    huge = {"sources": [{"name": f"f{i}.md", "kind": "text", "text": "x" * 199_000} for i in range(14)]}
    assert signed_in.post(f"/api/boards/{board_id}/sources", json=huge).status_code == 413


def test_unknown_hosts_are_refused(client: TestClient) -> None:
    assert client.get("/api/health", headers={"Host": "attacker.example"}).status_code == 400


def test_agent_routes_need_a_personal_token(signed_in: TestClient) -> None:
    signed_in.cookies.clear()
    assert signed_in.get("/api/agent/boards").status_code == 401
    assert signed_in.get("/api/agent/boards", headers={"Authorization": "Bearer tvd_nope"}).status_code == 401


def test_agent_change_updates_the_board_with_a_token(signed_in: TestClient) -> None:
    token = signed_in.post("/api/tokens", json={"name": "hook"}).json()["token"]
    board = signed_in.post("/api/boards", json={"title": "Agent board"}).json()
    signed_in.cookies.clear()
    headers = {"Authorization": f"Bearer {token}"}
    listed = signed_in.get("/api/agent/boards", headers=headers).json()
    assert board["id"] in {b["id"] for b in listed}
    body = {"agent": "Claude Code", "summary": example_material()["sources"][0]["text"], "diff": "", "files": []}
    response = signed_in.post(f"/api/agent/boards/{board['id']}/changes", json=body, headers=headers)
    assert response.status_code == 202
    assert response.json()["status"] == "review"


def test_mcp_needs_a_token(client: TestClient) -> None:
    response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert response.status_code == 401


def test_voice_is_off_without_configuration(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    response = signed_in.post(f"/api/boards/{board_id}/voice")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "not_configured"


def test_voice_mints_a_token_with_board_context(make_client: ClientFactory) -> None:
    class FakeVoice:
        def conversation_token(self) -> str:
            return "conv-token"

    client = make_client(voice=FakeVoice())
    sign_up(client)
    board_id = client.get("/api/boards").json()[0]["id"]
    session = client.post(f"/api/boards/{board_id}/voice").json()
    assert session["conversation_token"] == "conv-token"
    assert session["dynamic_variables"]["system_name"] == "Inbox Helper"
    assert client.get("/api/config").json()["voice_enabled"] is True
    assert client.get("/api/auth/me").json()["usage"]["voice_sessions_today"] == 1


def test_production_settings_demand_https_and_real_invites() -> None:
    with pytest.raises(ValueError, match="PUBLIC_ORIGIN"):
        load_settings({"APP_ENV": "production"})
    with pytest.raises(ValueError, match="INVITE_CODES"):
        load_settings({"APP_ENV": "production", "PUBLIC_ORIGIN": "https://app.example.com", "INVITE_CODES": "abc"})
    settings = load_settings(
        {"APP_ENV": "production", "PUBLIC_ORIGIN": "https://app.example.com", "INVITE_CODES": "umbc-hack-42"}
    )
    assert settings.cookie_secure
    assert settings.session_cookie == "__Host-tvd_session"
    assert "app.example.com" in settings.allowed_hosts
    assert "localhost" not in settings.allowed_hosts


def test_postgres_urls_use_psycopg() -> None:
    settings = load_settings({"DATABASE_URL": "postgresql://u:p@db:25060/app?sslmode=require"})
    assert settings.database_url.startswith("postgresql+psycopg://")


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/owner/repo/../../x",
        "http://github.com/owner/repo",
        "https://github.com.evil.example/owner/repo",
        "https://github.com/owner",
    ],
)
def test_only_plain_github_repo_urls_parse(url: str) -> None:
    with pytest.raises(AppError):
        parse_repo_url(url)


def test_github_urls_with_a_branch_parse() -> None:
    ref = parse_repo_url("https://github.com/owner/my-repo/tree/main")
    assert ref.archive_url == "https://codeload.github.com/owner/my-repo/tar.gz/main"
