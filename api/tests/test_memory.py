import json
from typing import Any

import httpx
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.analysis.analyst import LlmAnalyst
from app.domain.models import Answer, OpenGrade
from app.domain.notes import question_note, quiz_note, weak_topics
from app.domain.quiz import QuizQuestion, build_quiz
from app.llm.base import LlmRequest
from app.memory import BackboardApi, BackboardMemory
from app.tables import MemoryPrefsRow
from tests.conftest import ClientFactory, FakeBackboard, sign_up
from tests.factories import inbox

SERVER_KEY = "bb-server-key"

# =============================================================================
# Module Overview
# =============================================================================
# Backboard as the memory layer: the client against a recorded fake, the notes
# memory keeps and reads back, and the whole app with memory on, where asking,
# grading and the quiz order all go through a `FakeBackboard`.


def question(topic: str, kind: str = "multi") -> QuizQuestion:
    """The example's question on `topic`."""
    example = inbox()
    return next(q for q in build_quiz(example.map, example.analysis) if q.topic == topic and q.kind == kind)


def wrong_choice(q: QuizQuestion) -> str:
    """An option outside the key, so the answer grades as wrong."""
    return next(o.id for o in q.options if o.id not in q.answer)


# -----------------------------------------------------------------
# The client against a recorded fake
# -----------------------------------------------------------------


def recorded(replies: list[httpx.Response], seen: list[dict[str, Any]], **options: Any) -> BackboardMemory:
    def handle(request: httpx.Request) -> httpx.Response:
        seen.append({"method": request.method, "path": request.url.path, "body": json.loads(request.content or b"{}")})
        return replies.pop(0)

    client = httpx.Client(base_url="https://bb.test/api", transport=httpx.MockTransport(handle))
    api = BackboardApi(api_key="bb-key", base_url="https://bb.test/api", client=client)
    return BackboardMemory(api, **{"assistant_id": None, **options})


def test_the_first_note_makes_the_assistant_then_keeps_the_note() -> None:
    seen: list[dict[str, Any]] = []
    mem = recorded([httpx.Response(201, json={"operation_id": "op"})], seen, ensure_assistant=lambda: "a1")
    mem.keep("Quiz on the board, topic trust boundaries: they got it wrong.")
    assert [(s["method"], s["path"]) for s in seen] == [("POST", "/api/assistants/a1/memories")]
    assert seen[0]["body"]["content"].startswith("Quiz on the board")
    assert seen[0]["body"]["metadata"] == {"source": "threatviz-defend"}


def test_recall_needs_no_call_before_any_note_exists() -> None:
    seen: list[dict[str, Any]] = []
    assert recorded([], seen).recall("anything") == []
    assert seen == []


def test_recall_searches_the_saved_assistant() -> None:
    seen: list[dict[str, Any]] = []
    found = {"memories": [{"id": "m1", "content": "Missed the email trifecta", "score": 0.9}, {"score": 0.1}]}
    mem = recorded([httpx.Response(200, json=found)], seen, assistant_id="a1")
    assert mem.recall("How does the agent leak mail?") == ["Missed the email trifecta"]
    assert seen[0]["path"] == "/api/assistants/a1/memories/search"
    assert seen[0]["body"]["limit"] == 5


def test_memory_failures_never_break_the_work() -> None:
    seen: list[dict[str, Any]] = []
    mem = recorded([httpx.Response(500, text="down"), httpx.Response(401)], seen, assistant_id="a1")
    assert mem.recall("q") == []
    mem.keep("note")


def test_an_odd_assistant_id_never_reaches_a_url_path() -> None:
    seen: list[dict[str, Any]] = []
    mem = recorded([], seen, assistant_id="../x", ensure_assistant=lambda: "../../users")
    assert mem.recall("q") == []
    mem.keep("note")
    assert seen == []


def test_the_memory_page_lists_newest_first_and_forgets_everything() -> None:
    seen: list[dict[str, Any]] = []
    listed = {
        "memories": [
            {"id": "m1", "content": "older", "created_at": "2026-09-27T10:00:00Z"},
            {"id": "m2", "content": "newer", "created_at": "2026-09-27T11:00:00Z"},
        ]
    }
    replies = [httpx.Response(200, json=listed), httpx.Response(200, json={"success": True, "message": "ok"})]
    mem = recorded(replies, seen, assistant_id="a1")
    assert [n.content for n in mem.notes()] == ["newer", "older"]
    mem.forget_all()
    assert [(s["method"], s["path"]) for s in seen] == [
        ("GET", "/api/assistants/a1/memories"),
        ("DELETE", "/api/assistants/a1/memories"),
    ]


# -----------------------------------------------------------------
# What memory keeps and reads back
# -----------------------------------------------------------------


def test_notes_stay_one_line_and_name_the_topic_and_result() -> None:
    note = quiz_note("Inbox\nHelper", question("trifecta"), "partial")
    assert "\n" not in note
    assert "topic the lethal trifecta" in note
    assert note.endswith("partly right.")
    assert question_note("Inbox", "Where\ncan mail leak?") == 'On the "Inbox" board they asked: Where can mail leak?'


def test_weak_topics_count_misses_and_ignore_questions_they_got_right() -> None:
    missed_twice = quiz_note("A", question("trifecta"), "wrong")
    notes = [
        missed_twice,
        quiz_note("B", question("trifecta"), "partial"),
        quiz_note("A", question("boundary"), "wrong"),
        quiz_note("A", question("data"), "correct"),
        question_note("A", "Where can mail leak?"),
    ]
    assert weak_topics(notes) == ["trifecta", "boundary"]


def test_a_question_that_says_wrong_is_still_read_by_its_result() -> None:
    tricky = question("data").model_copy(update={"prompt": "What goes wrong if the database leaks?"})
    assert weak_topics([quiz_note("A", tricky, "correct")]) == []
    assert weak_topics([quiz_note("A", tricky, "wrong")]) == ["data"]


def test_reworded_notes_are_read_by_their_words() -> None:
    assert weak_topics(["The developer struggled with trust boundaries on the Inbox board."]) == ["boundary"]
    assert weak_topics(["They explained the lethal trifecta well."]) == []


# -----------------------------------------------------------------
# The app with memory on
# -----------------------------------------------------------------


class RecordingLlm:
    label = "fake"

    def __init__(self, reply: BaseModel) -> None:
        self.reply = reply
        self.requests: list[LlmRequest[Any]] = []

    def generate[T: BaseModel](self, request: LlmRequest[T]) -> T:
        self.requests.append(request)
        return request.schema.model_validate(self.reply.model_dump())


def with_memory(make_client: ClientFactory, fake: FakeBackboard, **options: Any) -> TestClient:
    client = make_client(backboard=fake.transport(), backboard_api_key=SERVER_KEY, **options)
    sign_up(client)
    return client


def example_board(client: TestClient) -> str:
    board_id: str = client.get("/api/boards").json()[0]["id"]
    return board_id


def test_questions_feed_earlier_notes_to_the_model_and_keep_the_new_one(make_client: ClientFactory) -> None:
    fake = FakeBackboard()
    llm = RecordingLlm(Answer(answer="Look at T1.", highlight=["T1"]))
    client = with_memory(make_client, fake, analyst=LlmAnalyst(llm))
    board = example_board(client)
    first = client.post(f"/api/boards/{board}/ask", json={"question": "Where can mail leak?"}).json()
    assert first["memory"] == {"recalled": [], "kept": True}
    assert "<memory>" not in llm.requests[0].user
    second = client.post(f"/api/boards/{board}/ask", json={"question": "And the logs?"}).json()
    assert second["memory"]["recalled"] == ['On the "Example: Inbox Helper" board they asked: Where can mail leak?']
    assert "<memory>" in llm.requests[1].user
    assert "Where can mail leak?" in llm.requests[1].user
    assert {key for _, _, key in fake.calls} == {SERVER_KEY}
    assert len(fake.owners) == 1


def test_a_missed_topic_comes_first_in_the_next_quiz(make_client: ClientFactory) -> None:
    fake = FakeBackboard()
    client = with_memory(make_client, fake)
    first = example_board(client)
    assert client.get(f"/api/boards/{first}/quiz").json()["focus"] is None
    trifecta = question("trifecta")
    body = {"question_id": trifecta.id, "choice_ids": [wrong_choice(trifecta)]}
    answered = client.post(f"/api/boards/{first}/quiz/answers", json=body).json()
    assert answered["attempt"]["result"] == "wrong"
    assert answered["memory"] == {"recalled": [], "kept": True}
    assert "topic the lethal trifecta" in fake.kept()[0]
    second = client.post("/api/boards/example").json()["id"]
    later = client.get(f"/api/boards/{second}/quiz").json()
    assert later["focus"]["topics"] == ["trifecta"]
    assert later["focus"]["notes"] == fake.kept()
    assert later["questions"][0]["topic"] == "trifecta"


def test_grading_recalls_notes_and_never_keeps_the_developers_words(make_client: ClientFactory) -> None:
    fake = FakeBackboard()
    llm = RecordingLlm(OpenGrade(verdict="partial", feedback="Close.", highlight=[]))
    client = with_memory(make_client, fake, analyst=LlmAnalyst(llm))
    board = example_board(client)
    boundary = question("boundary")
    client.post(
        f"/api/boards/{board}/quiz/answers",
        json={"question_id": boundary.id, "choice_ids": [wrong_choice(boundary)]},
    )
    fix = question("fix", "open")
    answered = client.post(
        f"/api/boards/{board}/quiz/answers",
        json={"question_id": fix.id, "text": "my secret thoughts on the design"},
    ).json()
    assert answered["memory"]["kept"] is True
    assert "topic trust boundaries" in answered["memory"]["recalled"][0]
    assert "<memory>" in llm.requests[0].user
    assert fake.kept()[-1].endswith("partly right.")
    assert not any("secret thoughts" in note for note in fake.kept())


def test_memory_turned_off_keeps_and_recalls_nothing(make_client: ClientFactory) -> None:
    fake = FakeBackboard()
    client = with_memory(make_client, fake)
    assert client.get("/api/memory").json()["active"] is True
    off = client.put("/api/memory/enabled", json={"enabled": False}).json()
    assert (off["enabled"], off["active"], off["source"]) == (False, False, "server")
    board = example_board(client)
    asked = client.post(f"/api/boards/{board}/ask", json={"question": "What should I fix first, and why?"}).json()
    assert asked["memory"] is None
    assert client.get(f"/api/boards/{board}/quiz").json()["focus"] is None
    assert fake.calls == []


def test_the_memory_page_lists_notes_and_forgets_them(make_client: ClientFactory) -> None:
    fake = FakeBackboard()
    client = with_memory(make_client, fake)
    board = example_board(client)
    client.post(f"/api/boards/{board}/ask", json={"question": "Where can mail leak?"})
    listed = client.get("/api/memory/notes").json()
    assert listed["source"] == "server"
    assert [n["content"] for n in listed["notes"]] == fake.kept()
    assert client.delete("/api/memory/notes").status_code == 204
    assert client.get("/api/memory/notes").json()["notes"] == []


def test_a_users_own_key_holds_their_memory_instead(make_client: ClientFactory) -> None:
    fake = FakeBackboard()
    client = with_memory(make_client, fake)
    saved = client.put("/api/memory", json={"api_key": "bb-own-key-9876"}).json()
    assert (saved["source"], saved["key_preview"], saved["active"]) == ("own", "...9876", True)
    assert "bb-own" not in json.dumps(saved)
    client.post(f"/api/boards/{example_board(client)}/ask", json={"question": "Where can mail leak?"})
    assert {key for _, _, key in fake.calls} == {"bb-own-key-9876"}
    assert client.put("/api/memory", json={"api_key": None}).json()["key_preview"] == "...9876"
    assert client.delete("/api/memory").status_code == 204
    assert client.get("/api/memory").json()["source"] == "server"


def test_without_a_backboard_key_memory_says_how_to_turn_it_on(make_client: ClientFactory) -> None:
    client = make_client()
    sign_up(client)
    view = client.get("/api/memory").json()
    assert (view["source"], view["active"], view["enabled"]) == ("none", False, True)
    assert "BACKBOARD_API_KEY" in view["message"]
    assert client.get("/api/memory/notes").json() == {"source": "none", "notes": []}
    asked = client.post(f"/api/boards/{example_board(client)}/ask", json={"question": "Why?"}).json()
    assert asked["memory"] is None


def test_two_notes_at_once_share_one_assistant(make_client: ClientFactory) -> None:
    fake = FakeBackboard()
    client = with_memory(make_client, fake)
    user_id = client.get("/api/auth/me").json()["user"]["id"]
    memories = client.app.state.services.memory  # type: ignore[attr-defined]
    first, second = memories.for_user(user_id), memories.for_user(user_id)
    first.keep("one")
    second.keep("two")
    assert len(fake.owners) == 1
    assert fake.kept() == ["one", "two"]


def test_memory_routes_need_a_session(make_client: ClientFactory) -> None:
    client = make_client()
    assert client.get("/api/memory").status_code == 401
    assert client.get("/api/memory/notes").status_code == 401


def test_a_backboard_outage_on_the_memory_page_is_explained(make_client: ClientFactory) -> None:
    down = httpx.MockTransport(lambda request: httpx.Response(503, text="maintenance"))
    client = make_client(backboard=down, backboard_api_key=SERVER_KEY)
    sign_up(client)
    user_id = client.get("/api/auth/me").json()["user"]["id"]
    with client.app.state.services.db.session() as session:  # type: ignore[attr-defined]
        session.add(MemoryPrefsRow(user_id=user_id, enabled=True, assistant_id="asst-1"))
    response = client.get("/api/memory/notes")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "memory_error"


class FakeVoice:
    def conversation_token(self) -> str:
        return "one-time-token"


def test_the_voice_coach_hears_what_memory_says_to_ask_first(make_client: ClientFactory) -> None:
    fake = FakeBackboard()
    client = with_memory(make_client, fake, voice=FakeVoice())
    first = example_board(client)
    trifecta = question("trifecta")
    body = {"question_id": trifecta.id, "choice_ids": [wrong_choice(trifecta)]}
    client.post(f"/api/boards/{first}/quiz/answers", json=body)
    second = client.post("/api/boards/example").json()["id"]
    brief = client.post(f"/api/boards/{second}/voice").json()["dynamic_variables"]["board_brief"]
    assert brief.startswith("From memory: in earlier sessions they found the lethal trifecta hard")


def test_the_voice_coach_is_told_only_the_questions_the_quiz_will_serve(make_client: ClientFactory) -> None:
    client = make_client(voice=FakeVoice())
    sign_up(client)
    board_id = client.get("/api/boards").json()[0]["id"]
    edited = client.get(f"/api/boards/{board_id}").json()["map"]
    client.put(f"/api/boards/{board_id}/map", json={"map": edited})
    # In review the quiz serves nothing, so a coach told there are questions would promise ones it cannot ask.
    assert client.get(f"/api/boards/{board_id}/quiz").json()["questions"] == []
    started = client.post(f"/api/boards/{board_id}/voice").json()
    assert started["dynamic_variables"]["question_count"] == "0"
