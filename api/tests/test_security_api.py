from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from app.boards.github import parse_repo_url
from app.config import load_settings
from app.errors import AppError
from app.limits import RateLimiter
from app.tables import BoardRow
from tests.conftest import INVITE, PASSWORD, ClientFactory, example_material, sign_up


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


def test_a_streamed_body_must_be_json_too(signed_in: TestClient) -> None:
    def chunks() -> Iterator[bytes]:
        yield b'{"title": "streamed"}'

    # A chunked body carries no Content-Length, which is not the same as carrying no body.
    for headers in ({}, {"Content-Type": "text/plain"}):
        streamed = signed_in.build_request("POST", "/api/boards", content=chunks(), headers=headers)
        assert streamed.headers["transfer-encoding"] == "chunked"
        assert signed_in.send(streamed).status_code == 415


def test_large_bodies_are_refused(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    huge = {"sources": [{"name": f"f{i}.md", "kind": "text", "text": "x" * 199_000} for i in range(14)]}
    assert signed_in.post(f"/api/boards/{board_id}/sources", json=huge).status_code == 413


def test_unknown_hosts_are_refused_except_for_health_checks(client: TestClient) -> None:
    assert client.get("/api/config", headers={"Host": "attacker.example"}).status_code == 400
    assert client.get("/api/health", headers={"Host": "10.244.0.7:8080"}).status_code == 200


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
    # With no web origin configured, as in a local run, the link uses the origin the hook called.
    assert response.json()["review_url"] == f"http://testserver/boards/{board['id']}"


def test_agent_review_links_use_the_configured_web_app(make_client: ClientFactory) -> None:
    client = make_client(cors_origins=("https://app.example.com",))
    sign_up(client)
    token = client.post("/api/tokens", json={"name": "hook"}).json()["token"]
    board = client.post("/api/boards", json={"title": "Agent board"}).json()
    body = {"agent": "Claude Code", "summary": example_material()["sources"][0]["text"], "diff": "", "files": []}
    headers = {"Authorization": f"Bearer {token}"}
    response = client.post(f"/api/agent/boards/{board['id']}/changes", json=body, headers=headers)
    assert response.status_code == 202, response.text
    assert response.json()["review_url"] == f"https://app.example.com/boards/{board['id']}"


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


def test_production_settings_demand_https_real_invites_and_a_secret() -> None:
    base = {"APP_ENV": "production", "PUBLIC_ORIGIN": "https://api.example.com", "APP_SECRET": "s" * 40}
    with pytest.raises(ValueError, match="PUBLIC_ORIGIN"):
        load_settings({"APP_ENV": "production"})
    with pytest.raises(ValueError, match="INVITE_CODES"):
        load_settings({**base, "INVITE_CODES": "abc"})
    with pytest.raises(ValueError, match="APP_SECRET"):
        load_settings({**base, "APP_SECRET": "", "INVITE_CODES": "umbc-hack-42"})
    with pytest.raises(ValueError, match="CORS_ORIGINS"):
        load_settings({**base, "INVITE_CODES": "umbc-hack-42", "CORS_ORIGINS": "http://app.example.com"})
    settings = load_settings({**base, "INVITE_CODES": "umbc-hack-42", "CORS_ORIGINS": "https://app.example.com/"})
    assert settings.cookie_secure
    assert settings.session_cookie == "__Host-tvd_session"
    assert "api.example.com" in settings.allowed_hosts
    assert "localhost" not in settings.allowed_hosts
    assert settings.cors_origins == ("https://app.example.com",)
    assert not settings.allow_private_provider_urls


def test_samesite_none_needs_secure_cookies() -> None:
    with pytest.raises(ValueError, match="COOKIE_SECURE"):
        load_settings({"COOKIE_SAMESITE": "none"})


def test_a_listed_frontend_origin_may_call_with_cookies(make_client: ClientFactory) -> None:
    client = make_client(cors_origins=("https://app.example.com",))
    sign_up(client)
    headers = {"Origin": "https://app.example.com", "Sec-Fetch-Site": "same-site"}
    created = client.post("/api/boards", json={"title": "x"}, headers=headers)
    assert created.status_code == 201
    assert created.headers["access-control-allow-origin"] == "https://app.example.com"
    assert created.headers["access-control-allow-credentials"] == "true"
    stranger = client.post("/api/boards", json={"title": "x"}, headers={"Origin": "https://evil.example"})
    assert stranger.status_code == 403
    assert "access-control-allow-origin" not in stranger.headers


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


def test_ipv6_clients_share_a_limit_per_64() -> None:
    from app.context import network_key

    assert network_key("2001:db8:1:2:aaaa::1") == network_key("2001:db8:1:2:bbbb::9") == "2001:db8:1:2::/64"
    assert network_key("203.0.113.9") == "203.0.113.9"
    assert network_key("::ffff:203.0.113.9") == "203.0.113.9"


def test_uploads_to_someone_elses_board_stop_before_any_work(signed_in: TestClient) -> None:
    body = {"sources": [{"name": "k.txt", "kind": "text", "text": "-----BEGIN PRIVATE KEY-----\n" * 5000}]}
    assert signed_in.post("/api/boards/not-a-board/sources", json=body).status_code == 404


def test_retries_on_a_busy_board_do_not_use_up_agent_changes(signed_in: TestClient) -> None:
    token = signed_in.post("/api/tokens", json={"name": "hook"}).json()["token"]
    board = signed_in.post("/api/boards", json={"title": "Agent board"}).json()
    db = signed_in.app.state.services.db  # type: ignore[attr-defined]
    with db.session() as session:
        session.execute(update(BoardRow).where(BoardRow.id == board["id"]).values(status="mapping"))
    headers = {"Authorization": f"Bearer {token}"}
    body = {"summary": example_material()["sources"][0]["text"]}
    for _ in range(31):
        busy = signed_in.post(f"/api/agent/boards/{board['id']}/changes", json=body, headers=headers)
        assert busy.status_code == 409
    with db.session() as session:
        session.execute(update(BoardRow).where(BoardRow.id == board["id"]).values(status="empty"))
    assert signed_in.post(f"/api/agent/boards/{board['id']}/changes", json=body, headers=headers).status_code == 202


def test_the_web_app_leaves_mcp_to_the_mcp_server(make_client: ClientFactory, tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<!doctype html><title>app</title>")
    client = make_client(static_dir=tmp_path)
    assert client.get("/mcp").status_code == 401
    assert client.get("/boards/abc").text.startswith("<!doctype html>")
    assert client.get("/mcpserver-notes").status_code == 200
    assert client.get("/api/nope").status_code == 404


def test_a_streamed_body_over_the_cap_gets_413(signed_in: TestClient) -> None:
    def chunks() -> Iterator[bytes]:
        for _ in range(30):
            yield b" " * 100_000

    response = signed_in.post("/api/boards", content=chunks(), headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_voice_sessions_cannot_start_in_a_burst(make_client: ClientFactory) -> None:
    class FakeVoice:
        def conversation_token(self) -> str:
            return "conv-token"

    client = make_client(voice=FakeVoice())
    sign_up(client)
    board_id = client.get("/api/boards").json()[0]["id"]
    statuses = [client.post(f"/api/boards/{board_id}/voice").status_code for _ in range(3)]
    assert statuses == [200, 200, 429]


def test_a_short_window_flood_does_not_erase_a_lockout() -> None:
    now = [0.0]
    limiter = RateLimiter(clock=lambda: now[0])
    for _ in range(5):
        limiter.hit("login-fail:gina:1.2.3.4", 5, 900, "")
    now[0] = 400.0
    for n in range(50_001):
        limiter.hit(f"signup:{n}", 60, 60, "")
    assert limiter.count("login-fail:gina:1.2.3.4", 900) == 5


def test_nul_characters_never_reach_the_database(signed_in: TestClient) -> None:
    # Postgres text columns refuse NUL outright, so any that got through would turn a write into a 500 there.
    created = signed_in.post("/api/boards", json={"title": "pay\u0000ments"})
    assert created.status_code == 201
    assert created.json()["title"] == "payments"
    board_id = created.json()["id"]
    assert signed_in.get("/api/boards/a%00b").status_code == 400
    example = next(b for b in signed_in.get("/api/boards").json() if b["example"])
    system = signed_in.get(f"/api/boards/{example['id']}").json()["map"]
    system["nodes"][0]["label"] = "Web\u0000 app"
    edited = signed_in.put(f"/api/boards/{example['id']}/map", json={"map": system}).json()
    assert "\u0000" not in edited["map"]["nodes"][0]["label"]
    assert signed_in.get(f"/api/boards/{board_id}").status_code == 200


def test_a_request_that_loses_an_insert_race_gets_a_409_not_a_500(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two sign ups for one name, or two first saves of a provider, both insert; the loser hit a unique constraint.
    def lost_race(*args: object, **kwargs: object) -> None:
        raise IntegrityError("INSERT INTO users ...", {}, Exception("UNIQUE constraint failed: users.username"))

    monkeypatch.setattr(client.app.state.services.accounts, "signup", lost_race)  # type: ignore[attr-defined]
    raced = client.post("/api/auth/signup", json={"username": "sam", "password": PASSWORD, "invite_code": INVITE})
    assert raced.status_code == 409
    assert raced.json()["error"]["code"] == "conflict"
    assert "UNIQUE" not in raced.text
