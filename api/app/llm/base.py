import json
import re
import types
from dataclasses import dataclass
from typing import Any, Literal, Protocol, Union, get_args, get_origin

from pydantic import BaseModel, ValidationError

# =============================================================================
# Module Overview
# =============================================================================
# The one seam every model call goes through. An `Llm` takes an `LlmRequest`,
# a system prompt, user text and a Pydantic schema, and returns a validated
# instance of that schema or raises `LlmError`. `strict_schema` and `parse_json`
# are the helpers every adapter shares. `parse_json` forgives the slips a model
# makes when only the prompt asks for JSON, such as prose around the object, a
# thinking block, an enum in the wrong case or a null left out, since each slip
# would otherwise cost a repair round that a person sits through.

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
# Reasoning models may think aloud first, braces and all.
_THINKING = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.DOTALL | re.IGNORECASE)
# Supporting lists a model drops when it has nothing for them. The lists that carry a reply, such as a map's
# nodes or an analysis's threats, stay required: filling those would pass off a broken reply as an empty one.
_SPARE_LISTS = frozenset({"how", "code", "refs", "highlight", "assumptions"})


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
    """Parse model text as `schema`: the first JSON object in it that fits, whatever text surrounds it."""
    stripped = _THINKING.sub("", text).strip()
    fenced = _FENCED.match(stripped)
    if fenced:
        stripped = fenced.group(1)
    decoder = json.JSONDecoder()
    invalid: ValidationError | None = None
    start = stripped.find("{")
    while start != -1:
        try:
            value, end = decoder.raw_decode(stripped, start)
        except json.JSONDecodeError:
            # A brace in prose, such as "{like this}", starts no object; the reply's object comes later.
            start = stripped.find("{", start + 1)
            continue
        if isinstance(value, dict):
            try:
                return schema.model_validate(_bend(value, schema))
            except ValidationError as exc:
                # Kept for the repair message: the first whole object is the one the model meant as its reply.
                invalid = invalid or exc
        start = stripped.find("{", end)
    if invalid is not None:
        raise invalid
    raise ValueError("The reply held no JSON object.")


def _bend(value: Any, annotation: Any) -> Any:
    """Bend `value` toward `annotation` where models commonly slip, leaving every real mistake for validation.

    The slips: an enum in another case, a STRIDE category spelled out, a nullable field or a supporting list left
    out, and an extra key. Anything else missing stays missing, since inventing it would hide a broken reply.
    """
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        if not isinstance(value, dict):
            return value
        bent: dict[str, Any] = {}
        for name, field in annotation.model_fields.items():
            if name in value:
                bent[name] = _bend(value[name], field.annotation)
            elif _allows_none(field.annotation):
                bent[name] = None
            elif name in _SPARE_LISTS and get_origin(field.annotation) is list:
                bent[name] = []
        return bent
    origin, args = get_origin(annotation), get_args(annotation)
    if origin is list and isinstance(value, list):
        item = args[0] if args else Any
        return [_bend(each, item) for each in value]
    if origin is Literal and isinstance(value, str):
        wanted = value.strip()
        for option in args:
            if isinstance(option, str) and option.lower() == wanted.lower():
                return option
        # STRIDE letters: a model may write "Tampering" or "Information disclosure" for T or I.
        letters = [a for a in args if isinstance(a, str) and len(a) == 1]
        if len(letters) == len(args) and wanted[:1].upper() in letters:
            return wanted[:1].upper()
        return value
    if origin in (Union, types.UnionType) and value is not None:
        options = [a for a in args if a is not type(None)]
        return _bend(value, options[0]) if len(options) == 1 else value
    return value


def _allows_none(annotation: Any) -> bool:
    """Whether a field's type admits `None`, as `str | None` does."""
    return get_origin(annotation) in (Union, types.UnionType) and type(None) in get_args(annotation)


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
