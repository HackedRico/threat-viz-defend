from pathlib import Path

import pytest

from app.cli import main
from app.config import Settings
from app.jobs import InlineJobs
from app.main import create_app
from tests.conftest import INVITE, PASSWORD, FakeBackboard


def test_admin_can_disable_and_delete_accounts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    url = f"sqlite:///{tmp_path / 'app.db'}"
    monkeypatch.setenv("DATABASE_URL", url)
    from fastapi.testclient import TestClient

    settings = Settings(database_url=url, static_dir=None, invite_codes=(INVITE,))
    with TestClient(create_app(settings, jobs=InlineJobs())) as client:
        client.post("/api/auth/signup", json={"username": "zoe", "password": PASSWORD, "invite_code": INVITE})
        assert main(["disable", "zoe"]) == 0
        assert client.get("/api/auth/me").status_code == 401
        assert client.post("/api/auth/login", json={"username": "zoe", "password": PASSWORD}).status_code == 403
        assert main(["users"]) == 0
        assert "disabled" in capsys.readouterr().out
        assert main(["delete", "zoe", "--yes"]) == 0
        assert main(["enable", "zoe"]) == 1


def test_create_user_makes_an_account_without_an_invite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'app.db'}")
    answers = iter(["organizer-pass-42", "organizer-pass-42"])
    monkeypatch.setattr("getpass.getpass", lambda prompt="": next(answers))
    assert main(["create-user", "Organizer"]) == 0
    assert "organizer is ready" in capsys.readouterr().out
    mismatched = iter(["organizer-pass-42", "something-else-9"])
    monkeypatch.setattr("getpass.getpass", lambda prompt="": next(mismatched))
    assert main(["create-user", "other"]) == 1


def test_a_password_reset_signs_everyone_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    url = f"sqlite:///{tmp_path / 'app.db'}"
    monkeypatch.setenv("DATABASE_URL", url)
    settings = Settings(database_url=url, static_dir=None, invite_codes=(INVITE,))
    with TestClient(create_app(settings, jobs=InlineJobs())) as client:
        client.post("/api/auth/signup", json={"username": "yuki", "password": PASSWORD, "invite_code": INVITE})
        token = client.post("/api/tokens", json={"name": "hook"}).json()["token"]
        answers = iter(["brand-new-pass-1", "brand-new-pass-1"])
        monkeypatch.setattr("getpass.getpass", lambda prompt="": next(answers))
        assert main(["create-user", "yuki"]) == 0
        assert client.get("/api/auth/me").status_code == 401
        assert client.get("/api/agent/boards", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_deleting_an_account_deletes_its_backboard_notes_too(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    url = f"sqlite:///{tmp_path / 'app.db'}"
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("BACKBOARD_API_KEY", "server-bb-key")
    fake = FakeBackboard()
    settings = Settings(database_url=url, static_dir=None, invite_codes=(INVITE,), backboard_api_key="server-bb-key")
    with TestClient(create_app(settings, jobs=InlineJobs(), backboard=fake.transport())) as client:
        client.post("/api/auth/signup", json={"username": "zoe", "password": PASSWORD, "invite_code": INVITE})
        board = client.get("/api/boards").json()[0]
        client.post(f"/api/boards/{board['id']}/ask", json={"question": "What happens if Postgres leaks?"})
        assert fake.kept()
        # The notes live on Backboard, outside the database, so deleting the rows alone left them there.
        assert main(["delete", "zoe", "--yes"], backboard=fake.transport()) == 0
    assert fake.kept() == []
