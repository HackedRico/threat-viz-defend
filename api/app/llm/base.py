import json
import re
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ValidationError

# =============================================================================
# Module Overview
# =============================================================================
# The one seam every model call goes through. An `Llm` takes an `LlmRequest`,
# a system prompt, user text and a Pydantic schema, and returns a validated
# instance of that schema or raises `LlmError`. `strict_schema` and `parse_json`
# are the helpers every adapter shares.

LlmErrorCode = Literal["not_configured", "auth", "rate_limited", "timeout", "unavailable", "bad_output", "refused"]
JsonMode = Literal["json_schema", "json_object", "prompt"]


class LlmError(Exception):
    """A model call failed; `code` says how, and the message tells the user what to do next."""

    def __init__(self, code: LlmErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class LlmRequest[T: BaseModel]:
    """One structured model call."""

    task: str
    system: str
    user: str
    schema: type[T]


class Llm(Protocol):
    """Anything that turns an `LlmRequest` into a validated instance of its schema."""

    @property
    def label(self) -> str:
        """Provider and model, as shown to users."""
        ...

    def generate[T: BaseModel](self, request: LlmRequest[T]) -> T:
        """Call the model and return schema-valid output, or raise `LlmError`."""
        ...


# =============================================================================
# Shared helpers for adapters
# =============================================================================

_FENCED = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


def strict_schema(schema: type[BaseModel]) -> dict[str, Any]:
    """The JSON Schema for `schema`, with every object closed and every property required."""
    raw = schema.model_json_schema()
    _close_objects(raw)
    return raw


def _close_objects(node: object) -> None:
    """Walk a JSON Schema in place so strict structured output accepts it."""
    if isinstance(node, dict):
        if node.get("type") == "object" and "properties" in node:
            node["additionalProperties"] = False
            node["required"] = list(node["properties"])
        node.pop("default", None)
        for value in node.values():
            _close_objects(value)
    elif isinstance(node, list):
        for item in node:
            _close_objects(item)


def schema_instructions(schema: type[BaseModel]) -> str:
    """Prompt text that asks for JSON matching `schema`, for providers without schema enforcement."""
    compact = json.dumps(strict_schema(schema), separators=(",", ":"))
    return (
        "Reply with one JSON object and nothing else: no prose and no code fences. "
        f"It must match this JSON Schema:\n{compact}"
    )


def parse_json[T: BaseModel](text: str, schema: type[T]) -> T:
    """Parse model text as `schema`, tolerating code fences and prose around one JSON object."""
    stripped = text.strip()
    fenced = _FENCED.match(stripped)
    if fenced:
        stripped = fenced.group(1)
    if not stripped.startswith("{"):
        # Some models wrap the object in a sentence; take the outermost braces.
        start, end = stripped.find("{"), stripped.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("The reply held no JSON object.")
        stripped = stripped[start : end + 1]
    return schema.model_validate_json(stripped)


def repair_message(error: ValidationError | ValueError) -> str:
    """The follow-up that asks a model to fix output that failed validation."""
    if isinstance(error, ValidationError):
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in error.errors()[:10])
    else:
        problems = str(error)
    return (
        f"That reply did not match the schema ({problems}). "
        "Reply again with only the corrected JSON object, keeping every required key."
    )
