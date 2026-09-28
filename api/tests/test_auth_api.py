import pytest
from fastapi.testclient import TestClient

from app.auth import service as auth_service
from app.errors import AppError
from tests.conftest import INVITE, PASSWORD, ClientFactory, sign_up


def test_signup_needs_the_invite_code(client: TestClient) -> None:
    response = client.post("/api/auth/signup", json={"username": "bob", "password": PASSWORD, "invite_code": "nope"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_signup_signs_in_and_adds_the_example_board(client: TestClient) -> None:
    body = sign_up(client, "Alice")
    assert body["user"]["username"] == "alice"
    assert "tvd_session" in client.cookies
    boards = client.get("/api/boards").json()
    assert [(b["title"], b["status"], b["example"]) for b in boards] == [("Example: Inbox Helper", "ready", True)]


def test_session_cookie_is_http_only_and_same_site(client: TestClient) -> None:
    response = client.post("/api/auth/signup", json={"username": "carol", "password": PASSWORD, "invite_code": INVITE})
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=lax" in cookie


def test_honeypot_rejects_bots(client: TestClient) -> None:
    body = {"username": "botty", "password": PASSWORD, "invite_code": INVITE, "website": "http://spam.example"}
    assert client.post("/api/auth/signup", json=body).status_code == 400


def test_usernames_are_unique_and_validated(client: TestClient) -> None:
    sign_up(client, "dave")
    again = client.post("/api/auth/signup", json={"username": "DAVE", "password": PASSWORD, "invite_code": INVITE})
    assert again.status_code == 409
    bad = client.post("/api/auth/signup", json={"username": "x y z", "password": PASSWORD, "invite_code": INVITE})
    assert bad.status_code == 400


def test_weak_passwords_are_refused(client: TestClient) -> None:
    short = client.post("/api/auth/signup", json={"username": "erin", "password": "short", "invite_code": INVITE})
    assert short.status_code == 422
    named = client.post(
        "/api/auth/signup", json={"username": "erin", "password": "erin-is-great-99", "invite_code": INVITE}
    )
    assert named.status_code == 400


def test_login_logout_and_me(client: TestClient) -> None:
    sign_up(client, "frank")
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/login", json={"username": "frank", "password": "wrong password"}).status_code == 401
    ok = client.post("/api/auth/login", json={"username": "Frank", "password": PASSWORD})
    assert ok.status_code == 200
    me = client.get("/api/auth/me").json()
    assert me["user"]["username"] == "frank"
    assert me["usage"]["model_calls_limit"] == 60


def test_repeated_failures_lock_the_account(client: TestClient) -> None:
    sign_up(client, "gina")
    client.post("/api/auth/logout")
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "gina", "password": "wrong password"})
    locked = client.post("/api/auth/login", json={"username": "gina", "password": PASSWORD})
    assert locked.status_code == 429
    assert "Retry-After" in locked.headers


def test_signups_close_at_the_account_limit(make_client: ClientFactory) -> None:
    client = make_client(max_users=1)
    sign_up(client, "first")
    second = client.post("/api/auth/signup", json={"username": "second", "password": PASSWORD, "invite_code": INVITE})
    assert second.status_code == 403


def test_tokens_are_shown_once_and_revocable(signed_in: TestClient) -> None:
    created = signed_in.post("/api/tokens", json={"name": "laptop"})
    assert created.status_code == 201
    token = created.json()["token"]
    assert token.startswith("tvd_")
    listed = signed_in.get("/api/tokens").json()
    assert listed[0]["prefix"] == token[:10]
    assert "token" not in listed[0]
    assert signed_in.delete(f"/api/tokens/{listed[0]['id']}").status_code == 204
    assert signed_in.get("/api/tokens").json() == []


def test_a_stranger_on_another_network_cannot_lock_an_account(client: TestClient) -> None:
    sign_up(client, "hana")
    client.post("/api/auth/logout")
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "hana", "password": "wrong password"})
    services = client.app.state.services  # type: ignore[attr-defined]
    signed_in = services.accounts.login  # the real user signs in from a different network
    with services.db.session() as session:
        assert signed_in(session, username="hana", password=PASSWORD, ip="198.51.100.7").user.username == "hana"


def test_development_account_is_ready_at_startup(make_client: ClientFactory) -> None:
    client = make_client(dev_username="devuser", dev_password="local-password-1")
    signed = client.post("/api/auth/login", json={"username": "devuser", "password": "local-password-1"})
    assert signed.status_code == 200
    assert [b["example"] for b in client.get("/api/boards").json()] == [True]


def test_development_account_is_refused_in_production() -> None:
    import pytest

    from app.config import load_settings

    base = {"APP_ENV": "production", "PUBLIC_ORIGIN": "https://api.example.com", "APP_SECRET": "s" * 40}
    with pytest.raises(ValueError, match="DEV_USERNAME"):
        load_settings({**base, "INVITE_CODES": "umbc-hack-42", "DEV_USERNAME": "dev", "DEV_PASSWORD": "x" * 12})


def test_a_right_password_gives_back_its_reserved_failure(client: TestClient) -> None:
    sign_up(client, "hana")
    client.post("/api/auth/logout")
    for _ in range(4):
        client.post("/api/auth/login", json={"username": "hana", "password": "wrong password"})
    for _ in range(3):
        assert client.post("/api/auth/login", json={"username": "hana", "password": PASSWORD}).status_code == 200
    for _ in range(4):
        client.post("/api/auth/login", json={"username": "hana", "password": "wrong password"})
    assert client.post("/api/auth/login", json={"username": "hana", "password": PASSWORD}).status_code == 200


def test_a_busy_sign_in_is_not_counted_as_a_failure(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    sign_up(client, "ines")
    client.post("/api/auth/logout")
    monkeypatch.setattr(auth_service, "_HASH_WAIT_S", 0.01)
    for _ in range(2):
        assert auth_service._HASH_SLOTS.acquire(timeout=1)
    try:
        for _ in range(6):
            busy = client.post("/api/auth/login", json={"username": "ines", "password": PASSWORD})
            assert busy.status_code == 503
    finally:
        for _ in range(2):
            auth_service._HASH_SLOTS.release()
    assert client.post("/api/auth/login", json={"username": "ines", "password": PASSWORD}).status_code == 200


def test_the_right_invite_code_waits_out_a_network_that_guessed_too_often(client: TestClient) -> None:
    for _ in range(20):
        client.post("/api/auth/signup", json={"username": "guess", "password": PASSWORD, "invite_code": "nope-nope"})
    right = client.post("/api/auth/signup", json={"username": "guess", "password": PASSWORD, "invite_code": INVITE})
    assert right.status_code == 429


def test_wrong_invite_codes_from_many_networks_all_count_toward_the_overall_cap(client: TestClient) -> None:
    services = client.app.state.services  # type: ignore[attr-defined]

    def attempt(code: str, ip: str) -> int:
        try:
            with services.db.session() as session:
                services.accounts.signup(
                    session, username="spread", password=PASSWORD, invite_code=code, honeypot="", ip=ip
                )
        except AppError as error:
            return error.status
        return 201

    # Guesses past one network's limit are refused before the code is judged, so they must not use up the overall
    # count either; 15 networks of 20 guesses reach it exactly.
    for network in range(15):
        assert {attempt("nope-nope", f"203.0.113.{network}") for _ in range(25)} == {403, 429}
    assert attempt(INVITE, "198.51.100.7") == 429


def test_a_sign_in_name_holding_a_colon_cannot_reach_another_accounts_lockout(client: TestClient) -> None:
    sign_up(client, "ivy")
    client.post("/api/auth/logout")
    services = client.app.state.services  # type: ignore[attr-defined]
    # Without a check, the per-name limit for "ivy:<ip>" is the key of ivy's tight lockout on that network.
    for _ in range(6):
        client.post("/api/auth/login", json={"username": "ivy:198.51.100.7", "password": "wrong password"})
    with services.db.session() as session:
        assert services.accounts.login(session, username="ivy", password=PASSWORD, ip="198.51.100.7")
