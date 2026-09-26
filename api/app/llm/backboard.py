import logging
from collections.abc import Callable
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ValidationError

from app.llm.base import LlmError, LlmRequest, parse_json, repair_message, schema_instructions

# =============================================================================
# Module Overview
# =============================================================================
# `BackboardLlm` routes model calls through Backboard, a hosted layer that adds
# long-term memory in front of thousands of models. Each user gets one Backboard
# assistant, so what they struggled with in past quizzes carries into later
# grading and answers. Material and threat steps only read memory: uploaded
# code is never written into it.

log = logging.getLogger(__name__)

MemoryMode = Literal["Auto", "Readonly", "off"]
# Tasks whose exchanges are worth remembering: the developer's own questions and quiz answers.
_REMEMBER_TASKS = frozenset({"answer", "grade"})


class BackboardLlm:
    """An `Llm` that sends each call through Backboard's thread and memory API."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str,
        memory: bool,
        assistant_id: str | None = None,
        on_assistant: Callable[[str], None] | None = None,
        timeout_s: float = 120.0,
        client: httpx.Client | None = None,
    ) -> None:
        provider, _, name = model.partition("/")
        if not provider or not name:
            raise ValueError("Write the Backboard model as `provider/model`, such as `openai/gpt-4o`.")
        self._provider = provider
        self._model = name
        self._memory = memory
        self._assistant_id = assistant_id
        self._on_assistant = on_assistant
        self._headers = {"X-API-Key": api_key}
        self._client = client or httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout_s, follow_redirects=False)
        self._label = f"{model} via Backboard" + (" with memory" if memory else "")

    @property
    def label(self) -> str:
        """Model and routing layer, as shown to users."""
        return self._label

    def generate[T: BaseModel](self, request: LlmRequest[T]) -> T:
        """Send one message on a fresh thread of the user's assistant, validate, and repair once in the same thread."""
        body: dict[str, Any] = {
            "content": request.user,
            "system_prompt": f"{request.system}\n\n{schema_instructions(request.schema)}",
            "llm_provider": self._provider,
            "model_name": self._model,
            "memory": self._memory_mode(request.task),
            "json_output": True,
            "stream": False,
        }
        if self._assistant_id:
            body["assistant_id"] = self._assistant_id
        reply = self._send(body)
        try:
            return parse_json(str(reply.get("content") or ""), request.schema)
        except (ValidationError, ValueError) as first:
            log.warning("[backboard] %s output failed validation; asking for a repair.", request.task)
            retry = {**body, "content": repair_message(first), "thread_id": reply.get("thread_id")}
        second = self._send(retry)
        try:
            return parse_json(str(second.get("content") or ""), request.schema)
        except (ValidationError, ValueError) as exc:
            raise LlmError("bad_output", f"{self._label} returned data in the wrong shape twice. Try again.") from exc

    def check(self) -> str:
        """Confirm the key works by listing assistants; return a short status line."""
        response = self._request("GET", "/assistants")
        count = len(response) if isinstance(response, list) else 0
        return f"Backboard accepted the key ({count} assistants on the account)."

    def _memory_mode(self, task: str) -> MemoryMode:
        """Write memory only for exchanges about the developer's understanding; otherwise read at most."""
        if not self._memory:
            return "off"
        return "Auto" if task in _REMEMBER_TASKS else "Readonly"

    def _send(self, body: dict[str, Any]) -> dict[str, Any]:
        """Post one message and remember the assistant Backboard created or used."""
        reply = self._request("POST", "/threads/messages", body)
        if not isinstance(reply, dict):
            raise LlmError("bad_output", f"{self._label} returned an unexpected reply. Try again.")
        assistant = reply.get("assistant_id")
        if isinstance(assistant, str) and assistant and assistant != self._assistant_id:
            self._assistant_id = assistant
            if self._on_assistant is not None:
                self._on_assistant(assistant)
        return reply

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        """Call Backboard and translate HTTP failures into `LlmError`."""
        try:
            response = self._client.request(method, path, json=body, headers=self._headers)
        except httpx.TimeoutException as exc:
            raise LlmError("timeout", f"{self._label} took too long to answer. Try again with less material.") from exc
        except httpx.HTTPError as exc:
            raise LlmError("unavailable", f"{self._label} is unreachable right now.") from exc
        if response.status_code in (401, 403):
            raise LlmError("auth", "Backboard rejected the API key. Check it under Model provider.")
        if response.status_code == 429:
            raise LlmError("rate_limited", "Backboard is rate limiting requests. Wait a minute and retry.")
        if response.status_code == 404:
            raise LlmError(
                "not_configured", "Backboard does not know that endpoint or model. Check the base URL and model."
            )
        if response.status_code >= 400:
            raise LlmError("unavailable", f"Backboard answered {response.status_code}: {response.text[:200]}")
        try:
            return response.json()
        except ValueError as exc:
            raise LlmError("bad_output", "Backboard returned something that is not JSON.") from exc
