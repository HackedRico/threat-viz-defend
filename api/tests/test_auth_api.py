from fastapi.testclient import TestClient

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
