import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.domain.models import ThreatAnalysis
from app.errors import AppError
from app.llm.backboard import BackboardLlm
from app.llm.base import LlmError, LlmRequest
from app.providers import service
from app.providers.netguard import check_base_url
from app.providers.secrets_box import SecretBox
from tests.conftest import ClientFactory, sign_up
from tests.factories import inbox

PUBLIC = "93.184.216.34"


def public_dns(host: str, port: int) -> list[str]:
    return [PUBLIC]


def test_sealed_keys_open_only_for_their_owner() -> None:
    box = SecretBox("x" * 40)
    sealed = box.seal("sk-secret-value", "user-1")
    assert "sk-secret" not in sealed
    assert box.open(sealed, "user-1") == "sk-secret-value"
    with pytest.raises(ValueError, match="decrypted"):
        box.open(sealed, "user-2")
    with pytest.raises(ValueError, match="decrypted"):
        SecretBox("y" * 40).open(sealed, "user-1")


@pytest.mark.parametrize(
    ("url", "addresses"),
    [
        ("http://api.example.com/v1", [PUBLIC]),
        ("https://user:pass@api.example.com/v1", [PUBLIC]),
        ("https://metadata.internal/v1", ["169.254.169.254"]),
        ("https://localhost:11434/v1", ["127.0.0.1"]),
        ("https://10.0.0.5/v1", ["10.0.0.5"]),
        ("https://mixed.example/v1", [PUBLIC, "192.168.1.2"]),
        ("ftp://api.example.com", [PUBLIC]),
    ],
)
def test_private_or_odd_base_urls_are_refused(url: str, addresses: list[str]) -> None:
    with pytest.raises(AppError):
        check_base_url(url, allow_private=False, resolver=lambda host, port: addresses)


def test_public_https_base_urls_pass_and_lose_the_trailing_slash() -> None:
    assert check_base_url("https://api.example.com/v1/", allow_private=False, resolver=public_dns) == (
        "https://api.example.com/v1"
    )
    assert check_base_url("http://localhost:11434/v1", allow_private=True) == "http://localhost:11434/v1"


def provider_body(**changes: Any) -> dict[str, Any]:
    body = {
        "kind": "openai_compatible",
        "base_url": "https://api.example.com/v1",
        "model": "gpt-test",
        "api_key": "sk-user-key-1234",
        "memory": False,
    }
    return {**body, **changes}


def test_provider_settings_round_trip_without_exposing_the_key(make_client: ClientFactory) -> None:
    client = make_client(allow_private_provider_urls=False, resolver=public_dns)
    sign_up(client)
    assert client.get("/api/provider").json()["source"] == "demo"
    saved = client.put("/api/provider", json=provider_body()).json()
    assert saved["source"] == "custom"
    assert saved["key_preview"] == "...1234"
    assert "sk-user-key" not in json.dumps(saved)
    kept = client.put("/api/provider", json=provider_body(model="gpt-other", api_key=None)).json()
    assert kept["model"] == "gpt-other"
    assert kept["key_preview"] == "...1234"
    assert client.delete("/api/provider").status_code == 204
    assert client.get("/api/provider").json()["source"] == "demo"


def test_backboard_needs_a_key_and_every_url_must_be_safe(make_client: ClientFactory) -> None:
    client = make_client(allow_private_provider_urls=False, resolver=lambda host, port: ["127.0.0.1"])
    sign_up(client)
    assert client.put("/api/provider", json=provider_body()).status_code == 400
    backboard_body = provider_body(kind="backboard", model="openai/gpt-4o", api_key=None)
    assert client.put("/api/provider", json=backboard_body).status_code == 400


def test_local_servers_can_be_saved_without_a_key(make_client: ClientFactory) -> None:
    client = make_client(allow_private_provider_urls=True)
    sign_up(client)
    body = provider_body(base_url="http://localhost:11434/v1", model="llama3", api_key=None)
    saved = client.put("/api/provider", json=body).json()
    assert saved["source"] == "custom"
    assert saved["key_preview"] is None


def test_backboard_models_need_a_provider_prefix(make_client: ClientFactory) -> None:
    client = make_client(resolver=public_dns)
    sign_up(client)
    body = provider_body(kind="backboard", base_url="https://app.backboard.io/api", model="gpt-4o")
    assert client.put("/api/provider", json=body).status_code == 400


def test_a_saved_provider_analyzes_the_users_boards(make_client: ClientFactory) -> None:
    client = make_client(resolver=public_dns)
    sign_up(client)
    client.put("/api/provider", json=provider_body())
    chosen = client.app.state.services.providers.for_user(client.get("/api/auth/me").json()["user"]["id"])  # type: ignore[attr-defined]
    assert chosen.own_key
    assert chosen.analyst.label == "gpt-test via api.example.com"


def test_a_saved_provider_gets_the_servers_output_cap(
    make_client: ClientFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    built: list[dict[str, Any]] = []

    def record(**kwargs: Any) -> SimpleNamespace:
        built.append(kwargs)
        return SimpleNamespace(label="recorded")

    monkeypatch.setattr(service, "OpenAICompatibleLlm", record)
    client = make_client(resolver=public_dns)
    sign_up(client)
    client.put("/api/provider", json=provider_body())
    client.app.state.services.providers.for_user(client.get("/api/auth/me").json()["user"]["id"])  # type: ignore[attr-defined]
    assert built[0]["max_tokens"] == 16_384


# -----------------------------------------------------------------
# Backboard adapter against a recorded fake
# -----------------------------------------------------------------


def backboard(replies: list[dict[str, Any]], seen: list[dict[str, Any]], **options: Any) -> BackboardLlm:
    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(
            {
                "path": request.url.path,
                "body": json.loads(request.content or b"{}"),
                "key": request.headers.get("x-api-key"),
            }
        )
        return httpx.Response(200, json=replies.pop(0))

    client = httpx.Client(base_url="https://bb.test/api", transport=httpx.MockTransport(handle))
    return BackboardLlm(
        api_key="bb-key", model="openai/gpt-4o", base_url="https://bb.test/api", client=client, **options
    )


REQUEST = LlmRequest("grade", "system rules", "user text", ThreatAnalysis)
GOOD = inbox().analysis.model_dump_json()


def test_backboard_sends_the_model_and_remembers_the_assistant() -> None:
    seen: list[dict[str, Any]] = []
    stored: list[str] = []
    llm = backboard(
        [{"content": GOOD, "thread_id": "t1", "assistant_id": "a1"}], seen, memory=True, on_assistant=stored.append
    )
    assert llm.generate(REQUEST).threats[0].id == "T1"
    body = seen[0]["body"]
    assert (body["llm_provider"], body["model_name"], body["memory"], body["json_output"]) == (
        "openai",
        "gpt-4o",
        "Auto",
        True,
    )
    assert seen[0]["key"] == "bb-key"
    assert stored == ["a1"]


def test_backboard_never_writes_uploaded_material_into_memory() -> None:
    seen: list[dict[str, Any]] = []
    llm = backboard([{"content": GOOD, "assistant_id": "a1"}], seen, memory=True, assistant_id="a1")
    llm.generate(LlmRequest("draft_map", "s", "code", ThreatAnalysis))
    assert seen[0]["body"]["memory"] == "Readonly"
    assert seen[0]["body"]["assistant_id"] == "a1"


def test_backboard_repairs_in_the_same_thread() -> None:
    seen: list[dict[str, Any]] = []
    llm = backboard([{"content": "not json", "thread_id": "t9"}, {"content": GOOD}], seen, memory=False)
    llm.generate(REQUEST)
    assert seen[1]["body"]["thread_id"] == "t9"
    assert seen[0]["body"]["memory"] == "off"


def test_backboard_auth_errors_are_explained() -> None:
    client = httpx.Client(base_url="https://bb.test/api", transport=httpx.MockTransport(lambda r: httpx.Response(401)))
    llm = BackboardLlm(api_key="x", model="openai/gpt-4o", base_url="https://bb.test/api", memory=False, client=client)
    with pytest.raises(LlmError) as info:
        llm.generate(REQUEST)
    assert info.value.code == "auth"


def test_provider_routes_need_a_session(client: TestClient) -> None:
    assert client.get("/api/provider").status_code == 401


def test_a_saved_key_is_not_reused_for_another_host(make_client: ClientFactory) -> None:
    client = make_client(resolver=public_dns)
    sign_up(client)
    client.put("/api/provider", json=provider_body())
    moved = provider_body(base_url="https://attacker.example/v1", api_key=None)
    assert client.put("/api/provider", json=moved).status_code == 400
    assert client.post("/api/provider/test", json=moved).status_code == 400
    assert client.put("/api/provider", json=provider_body(api_key=None, model="gpt-2")).status_code == 200


def test_each_user_gets_one_provider_call_at_a_time() -> None:
    from app.providers.gate import MAX_IN_FLIGHT, provider_slot

    with provider_slot("u1"), pytest.raises(LlmError, match="still answering"), provider_slot("u1"):
        pass
    held = [provider_slot(f"user-{i}") for i in range(MAX_IN_FLIGHT)]
    for slot in held:
        slot.__enter__()
    try:
        with pytest.raises(LlmError, match="Many people"), provider_slot("one-more"):
            pass
    finally:
        for slot in held:
            slot.__exit__(None, None, None)
    with provider_slot("one-more"):
        pass
