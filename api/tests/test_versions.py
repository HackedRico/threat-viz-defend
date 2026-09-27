from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import delete, event, func, select

from app.analysis.analyst import DemoAnalyst
from app.boards.ingest import Material
from app.boards.versions import MAX_VERSIONS
from app.domain.models import SystemMap
from app.llm.base import LlmError
from app.tables import MapVersionRow
from tests.conftest import PASSWORD, ClientFactory, example_material, sign_up
from tests.factories import inbox
from tests.test_mcp_tools import agent_token, call_tool

# =============================================================================
# Module Overview
# =============================================================================
# The map history: every map change keeps a version, a confirm pins its threats
# to the newest one, old boards start their history from the map they hold, and
# only the latest `MAX_VERSIONS` are kept.


def board(client: TestClient, board_id: str) -> dict[str, Any]:
    body: dict[str, Any] = client.get(f"/api/boards/{board_id}").json()
    return body


def example_id(client: TestClient) -> str:
    board_id: str = next(b["id"] for b in client.get("/api/boards").json() if b["example"])
    return board_id


def edit(client: TestClient, board_id: str, label: str) -> None:
    system = board(client, board_id)["map"]
    system["nodes"][0]["label"] = label
    assert client.put(f"/api/boards/{board_id}/map", json={"map": system}).status_code == 200


def test_the_example_starts_as_version_1_with_its_threats(signed_in: TestClient) -> None:
    [version] = board(signed_in, example_id(signed_in))["versions"]
    assert version["number"] == 1
    assert version["source"] == "example"
    assert version["counts"]["critical"] == 1
    assert version["nodes"] == 12


def test_each_map_change_is_a_version_and_confirm_pins_threats(signed_in: TestClient) -> None:
    board_id = signed_in.post("/api/boards", json={"title": "Mail"}).json()["id"]
    signed_in.post(f"/api/boards/{board_id}/sources", json=example_material())
    [drawn] = board(signed_in, board_id)["versions"]
    assert drawn["source"] == "upload"
    assert drawn["label"] == "Added notes.md"
    assert drawn["counts"] is None

    signed_in.post(f"/api/boards/{board_id}/confirm")
    edit(signed_in, board_id, "Browser app")
    first, second = board(signed_in, board_id)["versions"]
    assert first["counts"]["critical"] == 1
    assert (second["number"], second["source"], second["counts"]) == (2, "edit", None)

    old = signed_in.get(f"/api/boards/{board_id}/versions/1").json()
    new = signed_in.get(f"/api/boards/{board_id}/versions/2").json()
    assert old["analysis"]["threats"]
    assert new["analysis"] is None
    assert new["map"]["nodes"][0]["label"] == "Browser app"
    assert old["map"]["nodes"][0]["label"] != "Browser app"
    assert any(x["lethal"] for x in old["exposure"])
    assert old["crossings"]


def test_an_agent_change_is_named_by_the_agent(signed_in: TestClient) -> None:
    token = signed_in.post("/api/tokens", json={"name": "hook"}).json()["token"]
    board_id = signed_in.post("/api/boards", json={"title": "Agent"}).json()["id"]
    body = {"agent": "Claude Code", "summary": example_material()["sources"][0]["text"]}
    headers = {"Authorization": f"Bearer {token}"}
    assert signed_in.post(f"/api/agent/boards/{board_id}/changes", json=body, headers=headers).status_code == 202
    [version] = board(signed_in, board_id)["versions"]
    assert version["source"] == "agent"
    assert version["label"].startswith("Claude Code: ")


def test_a_board_from_before_history_starts_from_the_map_it_holds(signed_in: TestClient) -> None:
    board_id = example_id(signed_in)
    db = signed_in.app.state.services.db  # type: ignore[attr-defined]
    with db.session() as session:
        session.execute(delete(MapVersionRow))
    [listed] = board(signed_in, board_id)["versions"]
    assert (listed["number"], listed["counts"]["critical"]) == (1, 1)

    edit(signed_in, board_id, "Browser app")
    first, second = board(signed_in, board_id)["versions"]
    assert (first["source"], first["counts"]["critical"]) == ("earlier", 1)
    assert second["source"] == "edit"
    assert signed_in.get(f"/api/boards/{board_id}/versions/1").json()["analysis"] is not None


def test_only_the_latest_versions_are_kept(signed_in: TestClient) -> None:
    board_id = example_id(signed_in)
    for n in range(MAX_VERSIONS + 5):
        edit(signed_in, board_id, f"Web app {n}")
    versions = board(signed_in, board_id)["versions"]
    assert len(versions) == MAX_VERSIONS
    assert versions[0]["number"] == 7
    assert versions[-1]["number"] == MAX_VERSIONS + 6
    missing = signed_in.get(f"/api/boards/{board_id}/versions/1")
    assert missing.status_code == 404
    assert "no longer kept" in missing.json()["error"]["message"]


def test_versions_belong_to_the_boards_owner_and_go_with_the_board(make_client: ClientFactory) -> None:
    client = make_client()
    sign_up(client, "owner")
    board_id = example_id(client)
    client.post("/api/auth/logout")
    sign_up(client, "stranger")
    assert client.get(f"/api/boards/{board_id}/versions/1").status_code == 404

    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "owner", "password": PASSWORD})
    assert client.delete(f"/api/boards/{board_id}").status_code == 204
    db = client.app.state.services.db  # type: ignore[attr-defined]
    with db.session() as session:
        left = session.scalar(select(func.count()).select_from(MapVersionRow).where(MapVersionRow.board_id == board_id))
    assert left == 0


def test_polling_a_board_never_reads_the_stored_maps(signed_in: TestClient) -> None:
    board_id = example_id(signed_in)
    edit(signed_in, board_id, "Browser app")
    engine = signed_in.app.state.services.db.engine  # type: ignore[attr-defined]
    seen: list[str] = []

    def record(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        assert len(board(signed_in, board_id)["versions"]) == 2
    finally:
        event.remove(engine, "before_cursor_execute", record)
    listing = [s for s in seen if "FROM map_versions" in s]
    assert listing
    assert not any("map_versions.map" in s or "map_versions.analysis" in s for s in listing)


def test_a_github_import_is_a_version_named_by_what_was_read(signed_in: TestClient) -> None:
    board_id = signed_in.post("/api/boards", json={"title": "Repo"}).json()["id"]
    user_id = signed_in.get("/api/auth/me").json()["user"]["id"]
    source = {"id": "s1", "name": "owner/repo", "kind": "github", "bytes": 10, "added_at": "2026-09-27T00:00:00+00:00"}
    fetched = Material(inbox().material, [source], 3)
    boards = signed_in.app.state.services.boards  # type: ignore[attr-defined]
    boards.add_from_fetch(user_id, board_id, lambda: fetched, "Reading owner/repo from GitHub.")
    [version] = board(signed_in, board_id)["versions"]
    assert (version["source"], version["label"]) == ("github", "Added owner/repo")


def test_an_mcp_change_is_an_agent_version(signed_in: TestClient) -> None:
    token = agent_token(signed_in)
    board_id = signed_in.post("/api/boards", json={"title": "MCP"}).json()["id"]
    arguments = {"board_id": board_id, "summary": inbox().material, "diff": "", "files": []}
    failed, _ = call_tool(signed_in, token, "report_change", arguments)
    assert not failed
    [version] = board(signed_in, board_id)["versions"]
    assert version["source"] == "agent"
    assert version["label"].startswith("Coding agent: ")


def test_a_failed_draft_keeps_no_version(make_client: ClientFactory) -> None:
    class Broken(DemoAnalyst):
        def draft_map(self, material: str, current: SystemMap | None) -> SystemMap:
            raise LlmError("timeout", "The model took too long.")

    client = make_client(analyst=Broken())
    sign_up(client)
    board_id = client.post("/api/boards", json={"title": "Broken"}).json()["id"]
    client.post(f"/api/boards/{board_id}/sources", json=example_material())
    failed = board(client, board_id)
    assert failed["error"] == "The model took too long."
    assert failed["versions"] == []


def test_a_restored_example_starts_its_own_history(signed_in: TestClient) -> None:
    restored = signed_in.post("/api/boards/example").json()
    assert [(v["number"], v["source"]) for v in restored["versions"]] == [(1, "example")]
    assert signed_in.get(f"/api/boards/{restored['id']}/versions/1").json()["analysis"]["threats"]
