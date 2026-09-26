import logging
from typing import Any
from urllib.parse import urlparse

import openai
from pydantic import BaseModel, ValidationError

from app.llm.base import JsonMode, LlmError, LlmRequest, parse_json, repair_message, schema_instructions, strict_schema

# =============================================================================
# Module Overview
# =============================================================================
# `OpenAICompatibleLlm` speaks the Chat Completions API that OpenAI, DigitalOcean
# serverless inference, OpenRouter, Ollama and most gateways share. It asks for
# JSON the strongest way the provider allows, validates it against the request's
# schema, and gives the model one chance to repair output that fails validation.

log = logging.getLogger(__name__)


class OpenAICompatibleLlm:
    """An `Llm` backed by any Chat Completions endpoint."""

    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        base_url: str | None = None,
        json_mode: JsonMode = "json_schema",
        timeout_s: float = 120.0,
        max_tokens: int | None = None,
        client: openai.OpenAI | None = None,
    ) -> None:
        if not model:
            raise ValueError("`model` is required; set `LLM_MODEL`.")
        self._model = model
        self._json_mode: JsonMode = json_mode
        self._max_tokens = max_tokens
        self._client = client or openai.OpenAI(api_key=api_key, base_url=base_url, timeout=timeout_s, max_retries=2)
        host = urlparse(base_url).hostname if base_url else "api.openai.com"
        self._label = f"{model} via {host}"

    @property
    def label(self) -> str:
        """Provider and model, as shown to users."""
        return self._label

    def generate[T: BaseModel](self, request: LlmRequest[T]) -> T:
        """Call the model, validate its JSON against `request.schema`, and repair once on failure."""
        messages: list[dict[str, str]] = [
            {"role": "system", "content": self._system_prompt(request)},
            {"role": "user", "content": request.user},
        ]
        reply = self._complete(messages, request)
        try:
            return parse_json(reply, request.schema)
        except (ValidationError, ValueError) as first:
            log.warning("[llm] %s output failed validation; asking for a repair. Reason: %s", request.task, first)
            messages += [{"role": "assistant", "content": reply}, {"role": "user", "content": repair_message(first)}]
        reply = self._complete(messages, request)
        try:
            return parse_json(reply, request.schema)
        except (ValidationError, ValueError) as second:
            raise LlmError(
                "bad_output", f"{self._label} returned data in the wrong shape twice. Try again, or use another model."
            ) from second

    def _system_prompt(self, request: LlmRequest[Any]) -> str:
        """The system prompt, plus the schema in words when the provider will not enforce it."""
        if self._json_mode == "json_schema":
            return request.system
        return f"{request.system}\n\n{schema_instructions(request.schema)}"

    def _response_format(self, request: LlmRequest[Any]) -> dict[str, Any] | None:
        """The `response_format` for the current JSON mode, or `None` to rely on the prompt alone."""
        if self._json_mode == "json_schema":
            return {
                "type": "json_schema",
                "json_schema": {
                    "name": request.schema.__name__,
                    "schema": strict_schema(request.schema),
                    "strict": True,
                },
            }
        if self._json_mode == "json_object":
            return {"type": "json_object"}
        return None

    def _complete(self, messages: list[dict[str, str]], request: LlmRequest[Any]) -> str:
        """Send one Chat Completions request and return the text of the first choice."""
        response_format = self._response_format(request)
        try:
            response = self._create(messages, response_format)
        except openai.BadRequestError as exc:
            if response_format is None:
                raise LlmError("unavailable", f"{self._label} rejected the request: {_brief(exc)}") from exc
            # Many compatible servers reject `response_format`; fall back to asking in the prompt from now on.
            log.warning("[llm] %s rejected response_format %s; using prompt-only JSON.", self._label, self._json_mode)
            self._json_mode = "prompt"
            messages[0] = {"role": "system", "content": self._system_prompt(request)}
            return self._complete(messages, request)
        choice = response.choices[0] if response.choices else None
        content = choice.message.content if choice else None
        if choice is not None and choice.finish_reason == "length":
            raise LlmError("bad_output", f"{self._label} ran out of output tokens. Try less material at once.")
        if choice is not None and getattr(choice.message, "refusal", None):
            raise LlmError("refused", f"{self._label} declined to answer. Rephrase, or try another model.")
        if not content:
            raise LlmError("bad_output", f"{self._label} returned an empty reply. Try again.")
        return str(content)

    def _create(self, messages: list[dict[str, str]], response_format: dict[str, Any] | None) -> Any:
        """Make the API call, translating SDK errors into `LlmError`; `BadRequestError` passes through."""
        kwargs: dict[str, Any] = {"model": self._model, "messages": messages}
        if response_format is not None:
            kwargs["response_format"] = response_format
        if self._max_tokens is not None:
            kwargs["max_completion_tokens"] = self._max_tokens
        try:
            return self._client.chat.completions.create(**kwargs)
        except openai.BadRequestError:
            raise
        except (openai.AuthenticationError, openai.PermissionDeniedError) as exc:
            raise LlmError("auth", f"{self._label} rejected the API key. Check `LLM_API_KEY`.") from exc
        except openai.NotFoundError as exc:
            raise LlmError("not_configured", f"{self._label} does not know that model. Check `LLM_MODEL`.") from exc
        except openai.RateLimitError as exc:
            raise LlmError(
                "rate_limited", f"{self._label} is rate limiting requests. Wait a minute and retry."
            ) from exc
        except openai.APITimeoutError as exc:
            raise LlmError("timeout", f"{self._label} took too long to answer. Try again with less material.") from exc
        except (openai.APIConnectionError, openai.APIStatusError) as exc:
            raise LlmError("unavailable", f"{self._label} is unavailable right now: {_brief(exc)}") from exc


def _brief(exc: Exception) -> str:
    """A one-line, bounded description of an SDK error, safe to show a user."""
    text = " ".join(str(exc).split())
    return text[:200]
