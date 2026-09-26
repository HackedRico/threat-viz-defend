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
