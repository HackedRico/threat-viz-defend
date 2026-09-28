import json
import socket
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from types import SimpleNamespace
from typing import Any

import httpx
import httpx2
import openai
import pytest
from fastapi.testclient import TestClient

from app.domain.models import Answer
from app.errors import AppError
from app.llm.base import LlmError, LlmRequest
from app.llm.openai_compat import OpenAICompatibleLlm
from app.memory import BackboardApi
from app.providers import netguard, service
from app.providers.netguard import check_base_url
from app.providers.secrets_box import SecretBox
from app.tables import ProviderRow
from tests.conftest import ClientFactory, sign_up

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


def test_every_url_must_be_safe_and_backboard_is_never_the_model(make_client: ClientFactory) -> None:
    client = make_client(allow_private_provider_urls=False, resolver=lambda host, port: ["127.0.0.1"])
    sign_up(client)
    assert client.put("/api/provider", json=provider_body()).status_code == 400
    backboard_body = provider_body(kind="backboard", model="openai/gpt-4o")
    assert client.put("/api/provider", json=backboard_body).status_code == 422


def test_local_servers_can_be_saved_without_a_key(make_client: ClientFactory) -> None:
    client = make_client(allow_private_provider_urls=True)
    sign_up(client)
    body = provider_body(base_url="http://localhost:11434/v1", model="llama3", api_key=None)
    saved = client.put("/api/provider", json=body).json()
    assert saved["source"] == "custom"
    assert saved["key_preview"] is None


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


def test_provider_routes_need_a_session(client: TestClient) -> None:
    assert client.get("/api/provider").status_code == 401


def test_a_provider_saved_when_backboard_could_be_the_model_is_ignored(make_client: ClientFactory) -> None:
    client = make_client(resolver=public_dns)
    sign_up(client)
    user_id = client.get("/api/auth/me").json()["user"]["id"]
    services = client.app.state.services  # type: ignore[attr-defined]
    with services.db.session() as session:
        session.add(
            ProviderRow(
                user_id=user_id,
                kind="backboard",
                base_url="https://app.backboard.io/api",
                model="openai/gpt-4o",
                key_sealed=SecretBox(services.settings.app_secret).seal("bb-old-key", user_id),
                key_last4="-key",
                memory=True,
            )
        )
    assert client.get("/api/provider").json()["source"] == "demo"
    assert services.providers.for_user(user_id).own_key is False
    saved = client.put("/api/provider", json=provider_body(api_key=None)).json()
    assert (saved["source"], saved["key_preview"]) == ("custom", None)


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


@pytest.mark.parametrize("address", ["64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "fec0::1"])
def test_private_addresses_inside_ipv6_are_refused(address: str) -> None:
    with pytest.raises(AppError):
        check_base_url("https://api.example.com/v1", allow_private=False, resolver=lambda host, port: [address])


def test_a_unicode_host_is_checked_under_the_name_the_client_connects_to() -> None:
    asked: list[str] = []

    def record(host: str, port: int) -> list[str]:
        asked.append(host)
        return [PUBLIC]

    # getaddrinfo would look this name up as strasse.example, but httpx, and so the OpenAI SDK, connects to the
    # IDNA 2008 name. Two names an attacker controls could then point at a public and a private address.
    check_base_url("https://straße.example/v1", allow_private=False, resolver=record)
    assert asked == ["xn--strae-oqa.example"]
    # The OpenAI SDK connects through its own copy of httpx, so pin the check to what the SDK itself would reach.
    sdk = openai.OpenAI(api_key="k", base_url="https://straße.example/v1")
    assert asked == [sdk.base_url.raw_host.decode("ascii")]
    with pytest.raises(AppError) as invalid:
        check_base_url(f"https://{'ß' * 70}.example/v1", allow_private=False, resolver=record)
    assert invalid.value.status == 400


def test_malformed_urls_and_names_are_400_not_500() -> None:
    with pytest.raises(AppError) as bracket:
        check_base_url("https://[::1/v1", allow_private=False, resolver=public_dns)
    assert bracket.value.status == 400

    def idna_refuses(host: str, port: int) -> list[str]:
        raise UnicodeError("label too long")

    with pytest.raises(AppError) as label:
        check_base_url(f"https://{'a' * 70}.example/v1", allow_private=False, resolver=idna_refuses)
    assert label.value.status == 400


def test_a_slow_lookup_gives_up(monkeypatch: pytest.MonkeyPatch) -> None:
    def stall(*args: object, **kwargs: object) -> list[object]:
        time.sleep(1)
        return []

    monkeypatch.setattr(socket, "getaddrinfo", stall)
    monkeypatch.setattr(netguard, "DNS_TIMEOUT_S", 0.1)
    with pytest.raises(OSError, match="took too long"):
        netguard.resolve("slow.example", 443)


def test_a_lookup_that_finishes_before_its_callback_is_added_does_not_hang(monkeypatch: pytest.MonkeyPatch) -> None:
    # An IP literal resolves in microseconds, so the future can be done before `resolve` registers its cleanup.
    class Instant:
        def submit(self, fn: Any, *args: Any, **kwargs: Any) -> Future[Any]:
            done: Future[Any] = Future()
            done.set_result(fn(*args, **kwargs))
            return done

    def literal(host: str, *args: object, **kwargs: object) -> list[tuple[Any, ...]]:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (host, 443))]

    monkeypatch.setattr(socket, "getaddrinfo", literal)
    monkeypatch.setattr(netguard, "_lookups", Instant())
    answers: list[list[str]] = []
    # Twice, since a lock left held would stall every later lookup; daemon threads fail the test rather than hang it.
    for _ in range(2):
        worker = threading.Thread(target=lambda: answers.append(netguard.resolve(PUBLIC, 443)), daemon=True)
        worker.start()
        worker.join(timeout=2)
        assert not worker.is_alive(), "resolve deadlocked on its own lock"
    assert answers == [[PUBLIC], [PUBLIC]]


def test_parallel_lookups_of_one_host_share_one_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def slow(host: str, *args: object, **kwargs: object) -> list[tuple[Any, ...]]:
        calls.append(host)
        time.sleep(0.3)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]

    monkeypatch.setattr(socket, "getaddrinfo", slow)
    with ThreadPoolExecutor(max_workers=6) as pool:
        answers = list(pool.map(lambda _: netguard.resolve("shared.example", 443), range(6)))
    assert answers == [["93.184.216.34"]] * 6
    assert calls == ["shared.example"]


def test_a_key_holding_a_character_keys_never_have_is_refused_before_it_is_saved(make_client: ClientFactory) -> None:
    client = make_client(allow_private_provider_urls=False, resolver=public_dns)
    sign_up(client)
    # A zero-width space from a copy and paste saved fine before, then failed every call as the key went into a header.
    for body in (provider_body(api_key="sk-user​-key-1234"), provider_body(api_key="sk-user key-1234")):
        refused = client.put("/api/provider", json=body)
        assert refused.status_code == 422
        assert "Paste it again" in refused.json()["error"]["message"]
    assert client.put("/api/memory", json={"api_key": "bb-​key-1234"}).status_code == 422


def test_a_saved_key_that_cannot_go_in_a_header_fails_as_an_auth_error_not_a_crash() -> None:
    sent: list[object] = []

    def answer(request: object) -> httpx2.Response:
        sent.append(request)
        return httpx2.Response(200, json={})

    sdk_client = httpx2.Client(transport=httpx2.MockTransport(answer))
    client = openai.OpenAI(
        api_key="sk-\u200bkey", base_url="https://api.example.com/v1", max_retries=0, http_client=sdk_client
    )
    llm = OpenAICompatibleLlm(model="m", api_key="sk-\u200bkey", json_mode="json_schema", client=client)
    with pytest.raises(LlmError) as model_error:
        llm.generate(LlmRequest("answer", "system", "user", Answer))
    assert model_error.value.code == "auth"
    backboard_transport = httpx.MockTransport(lambda request: httpx.Response(200, json={}))
    backboard = BackboardApi(api_key="bb-\u200bkey", base_url="https://bb.test/api", transport=backboard_transport)
    with pytest.raises(LlmError) as memory_error:
        backboard.request("GET", "/assistants")
    assert memory_error.value.code == "auth"
    assert sent == []
