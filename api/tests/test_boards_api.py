import time
from collections.abc import Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from app.analysis.analyst import DemoAnalyst
from app.boards import ingest
from app.boards.ingest import Material
from app.db import utcnow
from app.domain.models import Answer, OpenGrade, SystemMap, ThreatAnalysis
from app.domain.quiz import QuizQuestion
from app.errors import AppError
from app.llm.base import LlmError
from app.routes import agents as agents_routes
from app.routes import boards as boards_routes
from app.tables import BoardRow, LoginSessionRow, QuizAttemptRow, UsageRow
from tests.conftest import ClientFactory, example_material, sign_up
from tests.factories import inbox


def new_board(client: TestClient, title: str = "My app") -> dict[str, Any]:
    response = client.post("/api/boards", json={"title": title})
    assert response.status_code == 201, response.text
    board: dict[str, Any] = response.json()
    return board


def test_material_draws_a_map_that_waits_for_review(signed_in: TestClient) -> None:
    board = new_board(signed_in)
    response = signed_in.post(f"/api/boards/{board['id']}/sources", json=example_material())
    assert response.status_code == 202
    drawn = signed_in.get(f"/api/boards/{board['id']}").json()
    assert drawn["status"] == "review"
    assert drawn["map"]["name"] == "Inbox Helper"
    assert drawn["sources"][0]["name"] == "notes.md"
    assert any(x["lethal"] for x in drawn["exposure"])
    assert "f4" in drawn["crossings"]
    assert drawn["events"][0]["kind"] == "mapped"


def test_confirm_finds_threats_and_the_quiz_follows(signed_in: TestClient) -> None:
    board = new_board(signed_in)
    signed_in.post(f"/api/boards/{board['id']}/sources", json=example_material())
    assert signed_in.post(f"/api/boards/{board['id']}/confirm").status_code == 202
    ready = signed_in.get(f"/api/boards/{board['id']}").json()
    assert ready["status"] == "ready"
    assert ready["counts"]["critical"] == 1
    assert ready["analysis_version"] == 1

    quiz = signed_in.get(f"/api/boards/{board['id']}/quiz").json()
    assert quiz["mastery"]["answered"] == 0
    first = quiz["questions"][0]
    assert "answer" not in first  # the key stays on the server until the question is answered


def test_choice_answers_are_graded_by_code(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    question = next(
        q for q in signed_in.get(f"/api/boards/{board_id}/quiz").json()["questions"] if q["topic"] == "data"
    )
    right = ["api", "sync", "agent"]
    graded = signed_in.post(
        f"/api/boards/{board_id}/quiz/answers", json={"question_id": question["id"], "choice_ids": right}
    ).json()
    assert graded["attempt"]["result"] == "correct"
    assert set(graded["attempt"]["correct_ids"]) == set(right)
    assert graded["mastery"]["answered"] == 1

    wrong = signed_in.post(
        f"/api/boards/{board_id}/quiz/answers", json={"question_id": question["id"], "choice_ids": ["web"]}
    ).json()
    assert wrong["attempt"]["result"] == "wrong"
    assert "left out" in wrong["attempt"]["feedback"]


def test_open_answers_are_graded_and_reset_clears_progress(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    quiz = signed_in.get(f"/api/boards/{board_id}/quiz").json()
    question = next(q for q in quiz["questions"] if q["topic"] == "attack")
    text = "An email from a sender goes through Gmail, the sync worker and Postgres to the triage agent."
    graded = signed_in.post(f"/api/boards/{board_id}/quiz/answers", json={"question_id": question["id"], "text": text})
    assert graded.status_code == 200
    assert graded.json()["attempt"]["result"] == "correct"
    empty = signed_in.post(f"/api/boards/{board_id}/quiz/answers", json={"question_id": question["id"], "text": " "})
    assert empty.status_code == 400
    assert signed_in.delete(f"/api/boards/{board_id}/quiz").status_code == 204
    assert signed_in.get(f"/api/boards/{board_id}/quiz").json()["mastery"]["answered"] == 0


def test_stale_question_ids_are_refused(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    response = signed_in.post(
        f"/api/boards/{board_id}/quiz/answers", json={"question_id": "threat:T99", "choice_ids": ["x"]}
    )
    assert response.status_code == 404


def test_editing_a_ready_map_sends_it_back_to_review(signed_in: TestClient) -> None:
    board = signed_in.get("/api/boards").json()[0]
    full = signed_in.get(f"/api/boards/{board['id']}").json()
    edited = full["map"]
    edited["nodes"] = [n for n in edited["nodes"] if n["id"] != "logs"]
    saved = signed_in.put(f"/api/boards/{board['id']}/map", json={"map": edited}).json()
    assert saved["status"] == "review"
    assert all(f["target"] != "logs" for f in saved["map"]["flows"])


def test_ask_answers_recorded_questions_with_known_ids(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    question = next(iter(inbox().answers))
    answer = signed_in.post(f"/api/boards/{board_id}/ask", json={"question": question}).json()
    assert "T1" in answer["highlight"]
    assert answer["answer"]


def test_boards_belong_to_their_owner(make_client: ClientFactory) -> None:
    alice = make_client()
    sign_up(alice, "alice")
    board_id = alice.get("/api/boards").json()[0]["id"]
    # A second client on the same app shares its database but not its cookies.
    mallory = TestClient(alice.app)
    sign_up(mallory, "mallory")
    assert mallory.get(f"/api/boards/{board_id}").status_code == 404
    assert mallory.delete(f"/api/boards/{board_id}").status_code == 404
    assert alice.get(f"/api/boards/{board_id}").status_code == 200


def test_signed_out_requests_get_401(client: TestClient) -> None:
    assert client.get("/api/boards").status_code == 401
    assert client.post("/api/boards", json={"title": "x"}).status_code == 401


def test_a_failed_model_call_restores_the_board_and_reports_why(make_client: ClientFactory) -> None:
    class Broken:
        label = "Broken model"

        def draft_map(self, material: str, current: SystemMap | None) -> SystemMap:
            raise LlmError("timeout", "Broken model took too long.")

        def find_threats(self, system: SystemMap) -> ThreatAnalysis:
            raise AssertionError("not called")

        def answer(
            self,
            system: SystemMap,
            analysis: ThreatAnalysis,
            question: str,
            focus: str | None,
            notes: Sequence[str] = (),
        ) -> Answer:
            raise AssertionError("not called")

        def grade(
            self,
            system: SystemMap,
            analysis: ThreatAnalysis | None,
            question: QuizQuestion,
            text: str,
            notes: Sequence[str] = (),
        ) -> OpenGrade:
            raise AssertionError("not called")

    client = make_client(analyst=Broken())
    sign_up(client)
    board = new_board(client)
    client.post(f"/api/boards/{board['id']}/sources", json=example_material())
    after = client.get(f"/api/boards/{board['id']}").json()
    assert after["status"] == "empty"
    assert after["error"] == "Broken model took too long."


def test_demo_mode_explains_it_only_knows_the_example(signed_in: TestClient) -> None:
    board = new_board(signed_in)
    body = {"sources": [{"name": "readme.md", "kind": "text", "text": "A to-do app with a Postgres database."}]}
    signed_in.post(f"/api/boards/{board['id']}/sources", json=body)
    after = signed_in.get(f"/api/boards/{board['id']}").json()
    assert after["status"] == "empty"
    assert "LLM_API_KEY" in after["error"]


def test_the_daily_budget_stops_model_calls(make_client: ClientFactory) -> None:
    client = make_client(daily_model_calls=1)
    sign_up(client)
    board = new_board(client)
    assert client.post(f"/api/boards/{board['id']}/sources", json=example_material()).status_code == 202
    over = client.post(f"/api/boards/{board['id']}/confirm")
    assert over.status_code == 429
    assert over.json()["error"]["code"] == "budget_exhausted"


def test_secret_files_are_skipped_and_values_masked(signed_in: TestClient) -> None:
    board = new_board(signed_in)
    material = example_material()
    material["sources"] += [
        {"name": "app/.env", "kind": "code", "text": "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz"},
        {"name": "app/config.py", "kind": "code", "text": 'password = "hunter2hunter2"'},
    ]
    signed_in.post(f"/api/boards/{board['id']}/sources", json=material)
    events = signed_in.get(f"/api/boards/{board['id']}").json()["events"]
    added = next(e for e in events if e["kind"] == "text")
    assert "masked 1 secret-like values" in added["text"]
    assert "skipped 1 files" in added["text"]


def test_report_escapes_model_text(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    response = signed_in.get(f"/api/boards/{board_id}/report.md")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    assert "## Lethal trifecta" in response.text


def test_brief_and_example_restore(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    assert "lethal trifecta" in signed_in.get(f"/api/boards/{board_id}/brief").json()["text"]
    assert signed_in.post("/api/boards/example").status_code == 201
    assert len(signed_in.get("/api/boards").json()) == 2


def test_github_urls_are_validated(signed_in: TestClient) -> None:
    board = new_board(signed_in)
    bad = signed_in.post(f"/api/boards/{board['id']}/github", json={"url": "https://evil.example/owner/repo"})
    assert bad.status_code == 400


def test_a_stale_session_or_new_token_does_not_lock_sqlite(make_client: ClientFactory, tmp_path: Path) -> None:
    # A file database has one writer at a time, unlike the shared in-memory connection other tests use.
    client = make_client(database_url=f"sqlite:///{tmp_path / 'app.db'}")
    sign_up(client)
    board = new_board(client)
    db = client.app.state.services.db  # type: ignore[attr-defined]
    with db.session() as session:
        session.execute(update(LoginSessionRow).values(last_seen_at=utcnow() - timedelta(minutes=10)))
    started = time.monotonic()
    assert client.post(f"/api/boards/{board['id']}/sources", json=example_material()).status_code == 202
    token = client.post("/api/tokens", json={"name": "hook"}).json()["token"]
    change = {"summary": "Added a cache", "diff": "diff --git a/a.py b/a.py\n+import redis\n", "files": ["a.py"]}
    confirm = client.post(f"/api/boards/{board['id']}/confirm")
    assert confirm.status_code == 202
    response = client.post(
        f"/api/agent/boards/{board['id']}/changes", json=change, headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 202, response.text
    assert time.monotonic() - started < 4


def test_threats_for_an_older_map_are_not_quizzed_or_reported(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    right = {"question_id": "stride:T2", "choice_ids": ["I"]}
    assert signed_in.post(f"/api/boards/{board_id}/quiz/answers", json=right).json()["attempt"]["result"] == "correct"
    edited = signed_in.get(f"/api/boards/{board_id}").json()["map"]
    edited["nodes"] = [n for n in edited["nodes"] if n["id"] != "logs"]
    assert signed_in.put(f"/api/boards/{board_id}/map", json={"map": edited}).status_code == 200

    quiz = signed_in.get(f"/api/boards/{board_id}/quiz").json()
    assert quiz["questions"] == []
    assert quiz["results"] == {}
    assert signed_in.post(f"/api/boards/{board_id}/quiz/answers", json=right).status_code == 404
    assert signed_in.post(f"/api/boards/{board_id}/ask", json={"question": "What first?"}).status_code == 409
    assert "T1" not in signed_in.get(f"/api/boards/{board_id}/report.md").text

    assert signed_in.post(f"/api/boards/{board_id}/confirm").status_code == 202
    fresh = signed_in.get(f"/api/boards/{board_id}/quiz").json()
    assert fresh["questions"]
    assert fresh["mastery"]["answered"] == 0


def test_a_repository_with_nothing_readable_fails_without_a_model_call(signed_in: TestClient) -> None:
    board = new_board(signed_in)
    user_id = signed_in.get("/api/auth/me").json()["user"]["id"]
    boards = signed_in.app.state.services.boards  # type: ignore[attr-defined]
    boards.add_from_fetch(user_id, board["id"], lambda: Material("", [], 0), "Reading owner/repo from GitHub.")
    failed = signed_in.get(f"/api/boards/{board['id']}").json()
    assert failed["status"] == "empty"
    assert "Nothing readable was found" in failed["error"]


def test_confirming_twice_finds_threats_once(signed_in: TestClient) -> None:
    board = new_board(signed_in)
    signed_in.post(f"/api/boards/{board['id']}/sources", json=example_material())
    assert signed_in.post(f"/api/boards/{board['id']}/confirm").status_code == 202
    assert signed_in.post(f"/api/boards/{board['id']}/confirm").status_code == 409
    assert signed_in.get(f"/api/boards/{board['id']}").json()["analysis_version"] == 1


def test_an_answer_graded_while_the_board_changed_is_not_saved(make_client: ClientFactory) -> None:
    holder: dict[str, TestClient] = {}

    class Interrupted(DemoAnalyst):
        def grade(
            self,
            system: SystemMap,
            analysis: ThreatAnalysis | None,
            question: QuizQuestion,
            text: str,
            notes: Sequence[str] = (),
        ) -> OpenGrade:
            # A coding agent's change lands while the model grades.
            with holder["client"].app.state.services.db.session() as session:  # type: ignore[attr-defined]
                session.execute(update(BoardRow).values(status="mapping"))
            return super().grade(system, analysis, question, text, notes)

    client = holder["client"] = make_client(analyst=Interrupted())
    sign_up(client)
    board_id = client.get("/api/boards").json()[0]["id"]
    body = {"question_id": "fix:T1", "text": "Turn off auto send and confirm every email"}
    assert client.post(f"/api/boards/{board_id}/quiz/answers", json=body).status_code == 409
    db = client.app.state.services.db  # type: ignore[attr-defined]
    with db.session() as session:
        assert session.scalar(select(func.count()).select_from(QuizAttemptRow)) == 0


def test_two_requests_that_both_saw_an_idle_board_start_one_job(make_client: ClientFactory) -> None:
    client = make_client()
    sign_up(client)
    services = client.app.state.services  # type: ignore[attr-defined]
    user_id = client.get("/api/auth/me").json()["user"]["id"]
    board_id = client.get("/api/boards").json()[0]["id"]

    def another_request_claims_it_first(row: BoardRow) -> None:
        # Between this request's read and its claim, a coding agent's change starts drawing the board.
        with services.db.session() as session:
            session.execute(update(BoardRow).where(BoardRow.id == board_id).values(status="mapping"))

    with pytest.raises(AppError) as info:
        services.boards._begin(
            user_id, board_id, "find_threats", "analyzing", lambda row, session: None, another_request_claims_it_first
        )
    assert info.value.status == 409
    with services.db.session() as session:
        assert session.scalar(select(func.count()).select_from(UsageRow)) == 0
        assert session.get(BoardRow, board_id).status == "mapping"


class _Voice:
    def __init__(self, measure: Any) -> None:
        self._measure = measure

    def conversation_token(self) -> str:
        self._measure()
        return "one-time-token"


def test_slow_board_routes_hold_no_database_connection_while_they_work(
    make_client: ClientFactory, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A route that kept its request's connection while masking an upload or waiting on an outside host drained the
    # pool: on Postgres, 16 uploads at once all failed after a 30 second wait for a connection.
    held: list[int] = []
    client: TestClient

    def measure() -> None:
        held.append(client.app.state.services.db.engine.pool.checkedout())  # type: ignore[attr-defined]

    client = make_client(database_url=f"sqlite:///{tmp_path / 'pool.db'}", voice=_Voice(measure))
    sign_up(client)

    def measured(real: Any) -> Any:
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            measure()
            return real(*args, **kwargs)

        return wrapped

    monkeypatch.setattr(boards_routes, "build_material", measured(ingest.build_material))
    monkeypatch.setattr(agents_routes, "agent_material", measured(ingest.agent_material))
    monkeypatch.setattr(boards_routes, "push_board", measured(lambda *args: None))
    board_id = client.post("/api/boards", json={"title": "Pool"}).json()["id"]
    assert client.post(f"/api/boards/{board_id}/sources", json=example_material()).status_code == 202
    token = client.post("/api/tokens", json={"name": "hook"}).json()["token"]
    change = {"agent": "claude-code", "summary": "add a cache", "diff": "diff --git a/x b/x\n", "files": ["x"]}
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post(f"/api/agent/boards/{board_id}/changes", json=change, headers=headers).status_code == 202
    example = next(b["id"] for b in client.get("/api/boards").json() if b["example"])
    target = {"account": "myorg", "token": "pat-token-1", "warehouse": "W", "database": "D", "schema_name": "S"}
    assert client.post(f"/api/boards/{example}/snowflake", json=target).status_code == 200
    assert client.post(f"/api/boards/{example}/voice").status_code == 200
    assert held == [0, 0, 0, 0]


def _restart_mid_redraw(client: TestClient, board_id: str) -> str:
    """Leave the board drawing, as a crash or deploy during a job does, then run startup recovery."""
    services = client.app.state.services  # type: ignore[attr-defined]
    with services.db.session() as session:
        session.execute(update(BoardRow).where(BoardRow.id == board_id).values(status="mapping"))
    services.boards.recover_interrupted()
    status: str = client.get(f"/api/boards/{board_id}").json()["status"]
    return status


def test_a_restart_during_a_redraw_never_revives_threats_found_on_an_older_map(signed_in: TestClient) -> None:
    board_id = signed_in.get("/api/boards").json()[0]["id"]
    # Unchanged since its threats were found, the board may go back to ready.
    assert _restart_mid_redraw(signed_in, board_id) == "ready"
    edited = signed_in.get(f"/api/boards/{board_id}").json()["map"]
    edited["nodes"] = [n for n in edited["nodes"] if n["id"] != "logs"]
    assert signed_in.put(f"/api/boards/{board_id}/map", json={"map": edited}).status_code == 200
    # After a hand edit the stored threats describe the older map, so the board goes back to review.
    assert _restart_mid_redraw(signed_in, board_id) == "review"
    assert signed_in.get(f"/api/boards/{board_id}/quiz").json()["questions"] == []
