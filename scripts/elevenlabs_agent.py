"""Create or update the private ElevenLabs voice coach for ThreatViz Defend, and its client tools."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

ELEVENLABS_API = "https://api.elevenlabs.io"
AGENT_NAME = "ThreatViz Defend coach"
LLM = "gemini-2.5-flash"
MAX_DURATION_SECS = 600
TIMEOUT_SECS = 30.0

# =============================================================================
# Module Overview
# =============================================================================
# Provisions the voice coach in one idempotent run: `TOOLS` are created or
# updated by name, then the agent is created or updated with `agent_body`, by
# ELEVENLABS_AGENT_ID or by name. Run it again after editing the prompt or a
# tool; `--dry-run` prints every request body without calling the API.

PROMPT = """\
You are the ThreatViz Defend coach. You run a whiteboard defense: {{user_name}} defends the threat model of \
{{system_name}} out loud, and you ask the questions.

# The board
{{board_brief}}
The quiz has {{question_count}} questions.

# How to run the session
1. Greet {{user_name}} by name and say you will quiz them on {{system_name}}. Ask whether they want a short tour \
of the board first or want to start the questions.
2. When they want to learn, or ask what a part of the system is, call get_board_brief and teach from it in a few \
short sentences. Call show_on_board with the ids of the parts you are talking about.
3. Otherwise loop: call get_next_question, read the question aloud, and for a choice question read every option \
with its letter. Then wait for their answer.
4. Never reveal or hint at an answer before they have answered. If they ask for it, ask for their best guess first.
5. When they answer, call submit_answer with the question_id. For a choice question pass the letter or letters \
they chose, like "B" or "A,C". For an open question pass their answer in their own words.
6. Read back the result briefly: whether they were right, and one sentence on why. When the result names parts of \
the board, call show_on_board with their ids.
7. When get_next_question reports that every question is answered, stop asking. Sum up their weak spots in two or \
three sentences and say goodbye.

# Style
This is spoken, so keep every turn to one or two short sentences in plain words. Never read ids aloud. If a tool \
fails, say so in one sentence and carry on with the next step.
"""

FIRST_MESSAGE = (
    "Hi {{user_name}}. Ready to defend {{system_name}}? "
    "I can walk you through the board first, or we can go straight to the questions."
)

# Values the dashboard uses when the agent is tested there; the web app sends real ones per session.
PLACEHOLDERS = {
    "user_name": "there",
    "system_name": "your system",
    "board_brief": "No board brief was provided.",
    "question_count": "10",
}


# =============================================================================
# Client tools
# =============================================================================


@dataclass(frozen=True)
class ToolSpec:
    """A client tool the browser implements; the agent calls it by name during a conversation."""

    name: str
    description: str
    params: tuple[tuple[str, str], ...]  # (name, description), all strings and all required
    expects_response: bool
    timeout_secs: int | None = None

    def config(self) -> dict[str, Any]:
        """The `tool_config` body ElevenLabs expects for this tool."""
        config: dict[str, Any] = {
            "type": "client",
            "name": self.name,
            "description": self.description,
            "expects_response": self.expects_response,
        }
        if self.expects_response and self.timeout_secs is not None:
            config["response_timeout_secs"] = self.timeout_secs
        if self.params:
            config["parameters"] = {
                "type": "object",
                "properties": {name: {"type": "string", "description": text} for name, text in self.params},
                "required": [name for name, _ in self.params],
            }
        return config


TOOLS = (
    ToolSpec(
        name="get_next_question",
        description="Get the next unanswered quiz question for this board, with its id, kind and lettered options. "
        "Reports when every question has been answered.",
        params=(),
        expects_response=True,
        timeout_secs=10,
    ),
    ToolSpec(
        name="submit_answer",
        description="Grade the developer's answer to one question and return whether it was right, why, and "
        "which parts of the board it concerns.",
        params=(
            ("question_id", "The id of the question being answered, exactly as get_next_question returned it."),
            (
                "answer",
                "For a choice question, the chosen letters separated by commas, like B or A,C. "
                "For an open question, the developer's answer in their own words.",
            ),
        ),
        expects_response=True,
        # Open answers are graded by a model on the server, which can take several seconds.
        timeout_secs=30,
    ),
    ToolSpec(
        name="show_on_board",
        description="Highlight parts of the board the developer is looking at while you talk about them.",
        params=(("ids", "Comma separated node, flow or threat ids to highlight, like n1,f3,t2."),),
        expects_response=False,
    ),
    ToolSpec(
        name="get_board_brief",
        description="Get a short description of the system on the board: its parts, data flows and top threats. "
        "Use it to teach when the developer asks.",
        params=(),
        expects_response=True,
        timeout_secs=10,
    ),
)


# =============================================================================
# The agent
# =============================================================================


def agent_body(tool_ids: Sequence[str]) -> dict[str, Any]:
    """The full agent config: prompt, tools, placeholders, a 10 minute cap, auth on and no client overrides."""
    return {
        "name": AGENT_NAME,
        "conversation_config": {
            "agent": {
                "first_message": FIRST_MESSAGE,
                "language": "en",
                "prompt": {"prompt": PROMPT, "llm": LLM, "tool_ids": list(tool_ids)},
                "dynamic_variables": {"dynamic_variable_placeholders": dict(PLACEHOLDERS)},
            },
            "conversation": {"max_duration_seconds": MAX_DURATION_SECS},
        },
        "platform_settings": {
            # Auth makes the agent private: a browser needs a conversation token minted with the server's key.
            "auth": {"enable_auth": True},
            # A browser must not swap the prompt, first message, language or voice of a private agent.
            "overrides": {
                "conversation_config_override": {
                    "agent": {"first_message": False, "language": False, "prompt": {"prompt": False}},
                    "tts": {"voice_id": False},
                }
            },
        },
    }


# =============================================================================
# The ElevenLabs API
# =============================================================================


class ElevenLabsError(RuntimeError):
    """ElevenLabs answered with an error, or could not be reached."""


class ElevenLabs:
    """A thin JSON client for the conversational AI endpoints."""

    def __init__(self, api_key: str, client: httpx.Client | None = None) -> None:
        if not api_key:
            raise ValueError("api_key must be set; export `ELEVENLABS_API_KEY`")
        self._client = client or httpx.Client(
            base_url=ELEVENLABS_API, timeout=TIMEOUT_SECS, headers={"xi-api-key": api_key}
        )

    def call(self, method: str, path: str, *, params: Mapping[str, str] | None = None, body: object = None) -> Any:
        """Send one request and return the parsed JSON body, raising `ElevenLabsError` on any failure."""
        try:
            response = self._client.request(method, path, params=params, json=body)
        except httpx.HTTPError as exc:
            raise ElevenLabsError(f"{method} {path} failed: {exc}") from exc
        if response.status_code in (401, 403):
            raise ElevenLabsError(
                f"{method} {path} was refused ({response.status_code}). Check `ELEVENLABS_API_KEY` and that the "
                "key has conversational AI access."
            )
        if response.status_code >= 400:
            raise ElevenLabsError(f"{method} {path} answered {response.status_code}: {response.text[:500]}")
        return response.json() if response.content else None

    def find_tool(self, name: str) -> str | None:
        """The id of the client tool called `name`, or `None` when there is none."""
        listing = self.call("GET", "/v1/convai/tools", params={"search": name})
        # Search matches substrings, so `submit_answer` could also return `submit_answer_v2`; match exactly.
        for tool in listing.get("tools", []) if isinstance(listing, dict) else []:
            config = tool.get("tool_config", {})
            if config.get("name") == name and config.get("type") == "client":
                return str(tool["id"])
        return None

    def upsert_tool(self, spec: ToolSpec) -> tuple[str, str]:
        """Create or update one tool by name, returning its id and what was done."""
        existing = self.find_tool(spec.name)
        body = {"tool_config": spec.config()}
        if existing:
            self.call("PATCH", f"/v1/convai/tools/{existing}", body=body)
            return existing, "updated"
        created = self.call("POST", "/v1/convai/tools", body=body)
        return str(created["id"]), "created"

    def find_agent(self, name: str) -> str | None:
        """The id of the one agent called `name`, or `None` when there is none."""
        listing = self.call("GET", "/v1/convai/agents", params={"search": name})
        agents = listing.get("agents", []) if isinstance(listing, dict) else []
        matches = [str(agent["agent_id"]) for agent in agents if agent.get("name") == name]
        if len(matches) > 1:
            raise ElevenLabsError(
                f"{len(matches)} agents are called {name!r}: {', '.join(matches)}. "
                "Set `ELEVENLABS_AGENT_ID` to the one to update."
            )
        return matches[0] if matches else None

    def upsert_agent(self, agent_id: str | None, body: Mapping[str, Any]) -> tuple[str, str]:
        """Update the agent when an id is known or found by name, else create it; return its id and the action."""
        agent_id = agent_id or self.find_agent(AGENT_NAME)
        if agent_id:
            self.call("PATCH", f"/v1/convai/agents/{agent_id}", body=body)
            return agent_id, "updated"
        created = self.call("POST", "/v1/convai/agents/create", body=body)
        return str(created["agent_id"]), "created"

    def agent_warnings(self, agent_id: str, tool_ids: Sequence[str]) -> list[str]:
        """Read the agent back and say what did not stick: auth, or the tool list."""
        agent = self.call("GET", f"/v1/convai/agents/{agent_id}")
        warnings = []
        if not _dig(agent, "platform_settings", "auth", "enable_auth"):
            warnings.append(
                "authentication is off, so anyone with the agent id can talk to it. Turn on "
                "`Enable authentication` in the agent's security settings."
            )
        applied = _dig(agent, "conversation_config", "agent", "prompt", "tool_ids") or []
        if set(applied) != set(tool_ids):
            warnings.append(f"the agent lists tools {applied}, expected {list(tool_ids)}.")
        return warnings


def _dig(data: object, *keys: str) -> Any:
    """Follow nested dict keys, returning `None` when any step is missing."""
    for key in keys:
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data


# =============================================================================
# Command line
# =============================================================================


def build_parser() -> argparse.ArgumentParser:
    """The command line for this script."""
    parser = argparse.ArgumentParser(
        description="Create or update the private ElevenLabs voice coach and its four client tools. "
        "Reads ELEVENLABS_API_KEY, and ELEVENLABS_AGENT_ID when the agent already exists. Safe to run again.",
        epilog="Run it with: cd api && uv run python ../scripts/elevenlabs_agent.py",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print every request body and call nothing; no API key needed"
    )
    return parser


def dry_run(agent_id: str | None) -> int:
    """Print the request bodies a real run would send."""
    for spec in TOOLS:
        print(f"# POST /v1/convai/tools (or PATCH /v1/convai/tools/<id> when {spec.name!r} exists)")
        print(json.dumps({"tool_config": spec.config()}, indent=2))
    target = f"PATCH /v1/convai/agents/{agent_id}" if agent_id else "POST /v1/convai/agents/create (or PATCH by name)"
    print(f"# {target}")
    print(json.dumps(agent_body([f"<id of {spec.name}>" for spec in TOOLS]), indent=2))
    return 0


def provision(api: ElevenLabs, agent_id: str | None) -> int:
    """Upsert the tools and the agent, then print the agent id and any warnings."""
    tool_ids = []
    for spec in TOOLS:
        tool_id, action = api.upsert_tool(spec)
        tool_ids.append(tool_id)
        print(f"tool {spec.name}: {action} ({tool_id})")
    agent_id, action = api.upsert_agent(agent_id, agent_body(tool_ids))
    print(f"agent {AGENT_NAME!r}: {action}")
    for warning in api.agent_warnings(agent_id, tool_ids):
        print(f"warning: {warning}", file=sys.stderr)
    print(f"\nPut this in the API's environment:\nELEVENLABS_AGENT_ID={agent_id}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Parse arguments, then do a dry run or provision for real."""
    args = build_parser().parse_args(argv)
    agent_id = os.environ.get("ELEVENLABS_AGENT_ID") or None
    if args.dry_run:
        return dry_run(agent_id)
    api_key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not api_key:
        print("error: set ELEVENLABS_API_KEY to an ElevenLabs API key, or pass --dry-run.", file=sys.stderr)
        return 2
    try:
        return provision(ElevenLabs(api_key), agent_id)
    except ElevenLabsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (KeyError, TypeError, AttributeError) as exc:
        # These mean ElevenLabs answered in a shape this script does not know, most likely an API change.
        print(
            f"error: unexpected response from ElevenLabs ({exc!r}); rerun with --dry-run to compare.", file=sys.stderr
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
