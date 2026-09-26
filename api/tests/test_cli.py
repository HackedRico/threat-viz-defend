from pathlib import Path

import pytest

from app.cli import main
from app.config import Settings
from app.jobs import InlineJobs
from app.main import create_app
from tests.conftest import INVITE, PASSWORD


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
