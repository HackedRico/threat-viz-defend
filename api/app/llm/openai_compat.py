import logging
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

import openai
from pydantic import BaseModel, ValidationError

from app.llm.base import JsonMode, LlmError, LlmRequest, parse_json, repair_message, schema_instructions, strict_schema

# Tasks a person watches a spinner for; every other task runs as a background job.
INTERACTIVE_TASKS = frozenset({"answer", "grade"})
# The longest a person waits on an interactive task, retries and the repair call included.
INTERACTIVE_BUDGET_S = 30.0
# A provider asking for a longer pause than this is treated as down, since a job would sit on it.
MAX_RETRY_WAIT_S = 60.0

# =============================================================================
# Module Overview
# =============================================================================
# `OpenAICompatibleLlm` speaks the Chat Completions API that OpenAI, DigitalOcean
# serverless inference, OpenRouter, Ollama and most gateways share. It asks for
# JSON the strongest way the provider allows, validates it against the request's
# schema, and gives the model one chance to repair output that fails validation.
# It retries busy or failing providers itself, logging each retry, and holds an
# interactive task to `INTERACTIVE_BUDGET_S` so a stalled provider shows an error.

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
        max_retries: int = 2,
        client: openai.OpenAI | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not model:
            raise ValueError("`model` is required; set `LLM_MODEL`.")
        self._model = model
        self._json_mode: JsonMode = json_mode
        self._max_tokens = max_tokens
        self._timeout_s = timeout_s
        self._max_retries = max_retries
        self._sleep = sleep
        self._clock = clock
        self._client = client or openai.OpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout_s,
            # The SDK retries silently and honors a `Retry-After` of up to two minutes; `_create` retries instead.
            max_retries=0,
            # A redirect could lead a checked public base URL to a private address, so none are followed.
            http_client=openai.DefaultHttpxClient(follow_redirects=False),
        )
        host = urlparse(base_url).hostname if base_url else "api.openai.com"
        self._label = f"{model} via {host}"
        # OpenAI's reasoning models reject `max_tokens`; Featherless, vLLM and others ignore `max_completion_tokens`.
        self._cap_field = "max_completion_tokens" if host == "api.openai.com" else "max_tokens"

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
        deadline = self._clock() + INTERACTIVE_BUDGET_S if request.task in INTERACTIVE_TASKS else None
        reply = self._complete(messages, request, deadline)
        try:
            return parse_json(reply, request.schema)
        except (ValidationError, ValueError) as first:
            # Log the kind of failure only: the error text quotes the model's reply, which may echo user code.
            log.warning(
                "[llm] %s output failed validation (%s); asking for a repair.", request.task, type(first).__name__
            )
            messages += [{"role": "assistant", "content": reply}, {"role": "user", "content": repair_message(first)}]
        reply = self._complete(messages, request, deadline)
        try:
            return parse_json(reply, request.schema)
        except (ValidationError, ValueError) as second:
            raise LlmError(
                "bad_output", f"{self._label} returned data in the wrong shape twice. Try again, or use another model."
            ) from second

    def remembers(self, task: str) -> bool:
        """Never: each Chat Completions call stands alone."""
        return False

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

    def _complete(self, messages: list[dict[str, str]], request: LlmRequest[Any], deadline: float | None) -> str:
        """Send one Chat Completions request, finished by `deadline` when set, and return the first choice's text."""
        response_format = self._response_format(request)
        try:
            response = self._create(messages, response_format, request.task, deadline)
        except openai.BadRequestError as exc:
            if response_format is None:
                raise LlmError("unavailable", f"{self._label} rejected the request: {_brief(exc)}") from exc
            # Many compatible servers reject `response_format`; fall back to asking in the prompt from now on.
            log.warning("[llm] %s rejected response_format %s; using prompt-only JSON.", self._label, self._json_mode)
            self._json_mode = "prompt"
            messages[0] = {"role": "system", "content": self._system_prompt(request)}
            return self._complete(messages, request, deadline)
        choice = response.choices[0] if response.choices else None
        content = choice.message.content if choice else None
        if choice is not None and choice.finish_reason == "length":
            # The user cannot change the cap, so the operator hint goes to the log and the user gets what they can do.
            log.warning(
                "[llm] %s hit the output cap of %s tokens; raise `LLM_MAX_TOKENS`.", self._label, self._max_tokens
            )
            raise LlmError("bad_output", f"{self._label} ran out of output tokens. Try again, or pick another model.")
        if choice is not None and getattr(choice.message, "refusal", None):
            raise LlmError("refused", f"{self._label} declined to answer. Rephrase, or try another model.")
        if not content:
            raise LlmError("bad_output", f"{self._label} returned an empty reply. Try again.")
        return str(content)

    def _create(
        self, messages: list[dict[str, str]], response_format: dict[str, Any] | None, task: str, deadline: float | None
    ) -> Any:
        """Make the API call, retrying a busy or failing provider; errors become `LlmError`, `BadRequestError` aside."""
        kwargs: dict[str, Any] = {"model": self._model, "messages": messages}
        if response_format is not None:
            kwargs["response_format"] = response_format
        if self._max_tokens is not None:
            kwargs[self._cap_field] = self._max_tokens
        attempt = 0
        while True:
            left = None if deadline is None else deadline - self._clock()
            if left is not None and left <= 0:
                raise LlmError("timeout", _timeout_message(self._label, deadline))
            try:
                return self._client.chat.completions.create(
                    **kwargs, timeout=self._timeout_s if left is None else min(self._timeout_s, left)
                )
            except openai.BadRequestError:
                raise
            except (openai.AuthenticationError, openai.PermissionDeniedError) as exc:
                raise LlmError("auth", f"{self._label} rejected the API key. Check `LLM_API_KEY`.") from exc
            except openai.NotFoundError as exc:
                raise LlmError("not_configured", f"{self._label} does not know that model. Check `LLM_MODEL`.") from exc
            except (openai.RateLimitError, openai.InternalServerError, openai.APIConnectionError) as exc:
                wait = _retry_wait(exc, attempt)
                fits = deadline is None or self._clock() + wait < deadline
                if attempt >= self._max_retries or wait > MAX_RETRY_WAIT_S or not fits:
                    raise _transient_error(self._label, exc, deadline) from exc
                log.warning(
                    "[llm] %s %s attempt %d failed (%s); retrying in %.1fs.",
                    self._label, task, attempt + 1, type(exc).__name__, wait,
                )  # fmt: skip
                self._sleep(wait)
                attempt += 1
            except openai.APIStatusError as exc:
                raise LlmError("unavailable", f"{self._label} is unavailable right now: {_brief(exc)}") from exc


def _retry_wait(exc: Exception, attempt: int) -> float:
    """Seconds to wait before retrying: the provider's `Retry-After` when it sent one, else a short backoff."""
    backoff = min(0.5 * 2.0**attempt, 8.0)
    # Only status errors carry a response; a dropped connection or a timeout has none.
    header = exc.response.headers.get("retry-after") if isinstance(exc, openai.APIStatusError) else None
    try:
        return max(0.0, float(header)) if header is not None else backoff
    except ValueError:
        # An HTTP-date `Retry-After` is rare from model hosts; treat it as a normal backoff.
        return backoff


def _transient_error(label: str, exc: Exception, deadline: float | None) -> LlmError:
    """The `LlmError` for a busy, slow or unreachable provider once retrying stops."""
    if isinstance(exc, openai.RateLimitError):
        return LlmError("rate_limited", f"{label} is rate limiting requests. Wait a minute and retry.")
    if isinstance(exc, openai.APITimeoutError):
        return LlmError("timeout", _timeout_message(label, deadline))
    return LlmError("unavailable", f"{label} is unavailable right now: {_brief(exc)}")


def _timeout_message(label: str, deadline: float | None) -> str:
    """What to do after a timeout: less material helps a map or threats job, while a question just needs a retry."""
    advice = "Try again in a moment." if deadline is not None else "Try again with less material."
    return f"{label} took too long to answer. {advice}"


def _brief(exc: Exception) -> str:
    """A one-line, bounded description of an SDK error, safe to show a user."""
    text = " ".join(str(exc).split())
    return text[:200]
