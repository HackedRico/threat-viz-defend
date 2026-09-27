import re
from collections.abc import Callable
from typing import Annotated, Any

import anyio
from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import AnyHttpUrl, Field
from sqlalchemy.orm import Session
from starlette.applications import Starlette

from app.boards.ingest import agent_material
from app.boards.service import current_analysis, read_map
from app.boards.views import board_summary
from app.context import Services, web_app_origin
from app.db import utcnow
from app.domain.briefing import brief
from app.domain.briefing import describe_element as describe_one
from app.domain.models import SystemMap, ThreatAnalysis
from app.domain.notes import TOPIC_NAMES
from app.domain.rules import flow_label
from app.errors import AppError
from app.schemas import AnswerIn, MemoryUse

# =============================================================================
# Module Overview
# =============================================================================
# The remote MCP server a coding agent connects to at `/mcp` with a personal
# token. Its tools let the agent read a board, ask about it, report a change it
# just made, and quiz the developer inside the editor. Each tool runs the same
# services the web app uses, as the token's owner, on a worker thread, so
# Backboard memory takes part here as it does in the web app.

# Separators in a list of option letters, as in `A, C`, `a/c` or `A and C`.
_LETTER_SEPARATORS = re.compile(r"[\s,;/&+]+|\band\b|\bor\b", re.IGNORECASE)
# A capital letter standing alone inside a sentence; a lowercase one is more likely the article "a".
_CAPITAL = re.compile(r"\b([A-Z])\b")

INSTRUCTIONS = (
    "Tools for the developer's threat model boards. Call list_boards to find a board id. After you change how "
    "the system is built (new services, routes, data stores, third party APIs, AI tools), call report_change with "
    "a summary and the diff so the board's map stays current, unless the repository has a .threatviz.json: its "
    "hook already reports every turn's changes, so there call report_change only when the developer asks. Use "
    "get_board or ask_board before designing a change that touches sensitive data or untrusted input. When the "
    "developer asks to be quizzed, use next_quiz_question and answer_quiz_question, and never reveal an answer "
    "before they try."
)


class _PersonalTokens(TokenVerifier):
    """Accepts the app's personal tokens as MCP bearer tokens."""

    def __init__(self, services: Services) -> None:
        self._services = services

    async def verify_token(self, token: str) -> AccessToken | None:
        """The token's owner as an `AccessToken`, or `None` when the token is unknown."""
        return await anyio.to_thread.run_sync(self._lookup, token)

    def _lookup(self, token: str) -> AccessToken | None:
        with self._services.db.session() as session:
            user = self._services.tokens.user_for_token(session, token)
            if user is None:
                return None
            return AccessToken(token=token, client_id=user.id, subject=user.id, scopes=["boards"])


def build_mcp(services: Services) -> tuple[MCPServer, Starlette]:
    """The MCP server and its ASGI app, to mount at the root after every other route."""
    settings = services.settings
    mcp = MCPServer(
        settings.app_name,
        instructions=INSTRUCTIONS,
        token_verifier=_PersonalTokens(services),
        # `issuer_url` is required by the settings type but unused without an OAuth provider, and a
        # `None` resource URL keeps OAuth discovery routes off, which some clients would otherwise follow.
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(settings.public_origin or "http://localhost"), resource_server_url=None
        ),
    )
    _register_tools(mcp, services)
    hosts = [h for host in settings.allowed_hosts for h in (host, f"{host}:*")]
    app = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        # An event stream sends its headers at once. A JSON reply sends nothing until the tool returns, and
        # Claude Code gives up on a response with no headers after 60 seconds, which a model-backed tool can take.
        json_response=False,
        transport_security=TransportSecuritySettings(allowed_hosts=hosts, allowed_origins=[]),
    )
    return mcp, app


def _register_tools(mcp: MCPServer, services: Services) -> None:
    """Declare every tool on `mcp`."""
    read_only = ToolAnnotations(read_only_hint=True)
    board_arg = Annotated[str, Field(description="Board id from list_boards.")]

    @mcp.tool(annotations=read_only)
    async def list_boards() -> list[dict[str, Any]]:
        """List the developer's threat model boards: id, title, status and threat counts."""

        def work(user_id: str) -> list[dict[str, Any]]:
            with services.db.session() as session:
                return [board_summary(r).model_dump(mode="json") for r in services.boards.all_for(session, user_id)]

        return await _as_user(work)

    @mcp.tool(annotations=read_only)
    async def get_board(board_id: board_arg) -> str:
        """Describe a board: what the system is, its trust zones, AI exposure and top threats with fixes."""

        def work(user_id: str) -> str:
            with services.db.session() as session:
                row = services.boards.get(session, user_id, board_id)
                system = read_map(row)
                if system is None:
                    return f"Board {row.title} has no map yet. Its status is {row.status}."
                analysis = current_analysis(row)
                nodes = [f"- {n.id}: {n.label} ({n.kind})" for n in system.nodes]
                flows = [f"- {f.id}: {flow_label(system, f)}" for f in system.flows]
                lines = [f"Status: {row.status}.", "Nodes:", *nodes, "Flows:", *flows]
                return f"{brief(system, analysis, max_threats=6)}\n\n" + "\n".join(lines)

        return await _as_user(work)

    @mcp.tool(annotations=read_only)
    async def describe_element(
        board_id: board_arg, element_id: Annotated[str, Field(description="A node or flow id from get_board.")]
    ) -> str:
        """Describe one component or flow on a board and the threats pinned to it."""

        def work(user_id: str) -> str:
            with services.db.session() as session:
                text = describe_one(*_board_parts(services, session, user_id, board_id), element_id)
            if text is None:
                raise ToolError(
                    f"There is no node or flow with id {element_id} on this map. "
                    "Call get_board for its node and flow ids."
                )
            return text

        return await _as_user(work)

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
    async def ask_board(
        board_id: board_arg, question: Annotated[str, Field(description="A question about the system's threats.")]
    ) -> str:
        """Ask a question about a finished board, such as what could go wrong if a new route trusts user input."""

        def work(user_id: str) -> str:
            answer = services.boards.ask(user_id, board_id, question[:2000], None)
            # A line break in the model's answer could forge the `Related ids` line, so the agent gets it on one
            # line. The web app gets the answer with its breaks, since it shows them as plain text paragraphs.
            ids = f"\nRelated ids: {', '.join(answer.highlight)}" if answer.highlight else ""
            return " ".join(answer.answer.split()) + ids + _memory_line(answer.memory)

        return await _as_user(work)

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False))
    async def report_change(
        ctx: Context,
        board_id: board_arg,
        summary: Annotated[str, Field(description="What you changed and why, in one or two sentences.")],
        diff: Annotated[str, Field(description="The unified diff of the change, if you have it.")] = "",
        files: Annotated[list[str], Field(description="Paths of the files you changed.")] = [],  # noqa: B006
    ) -> str:
        """Update the board's map from a change you just made; the developer reviews it in the app.

        Skip this when the repository has a .threatviz.json: its hook reports each turn's changes on its own, and a
        second report of the same change redraws the map twice. Call it there only when the developer asks.
        """
        origin = web_app_origin(ctx.request_context.request, services.settings)

        def work(user_id: str) -> str:
            with services.db.session() as session:
                services.boards.check_idle(session, user_id, board_id)
            services.limiter.hit(f"agent-change:{user_id}", 30, 3600, "Too many agent changes this hour.")
            paths = [f[:1000] for f in files[:500]]
            material = agent_material("Coding agent", summary[:4000], diff[:200_000], paths, utcnow())
            services.boards.add_material(user_id, board_id, material)
            return f"The map is being updated. The developer can review it at {origin}/boards/{board_id}."

        return await _as_user(work)

    @mcp.tool(annotations=read_only)
    async def next_quiz_question(board_id: board_arg) -> str:
        """The next whiteboard defense question for the developer, with lettered options when it has any."""

        def work(user_id: str) -> str:
            with services.db.session() as session:
                # `Quiz.state` gives a board without a map no questions, which would read as a finished quiz.
                _board_parts(services, session, user_id, board_id)
            focus = services.quiz.focus(user_id, board_id)
            with services.db.session() as session:
                state = services.quiz.state(session, user_id, board_id, focus)
            if not state.questions:
                raise ToolError(
                    "This board has no quiz questions yet. They follow once the developer confirms the map "
                    "in the web app and the threats are found."
                )
            pending = [q for q in state.questions if q.id not in state.results]
            if not pending:
                m = state.mastery
                return f"Every question is answered. Score {round(m.score * 100)} percent over {m.total} questions."
            q = pending[0]
            options = " ".join(f"{chr(65 + i)}) {o.label}." for i, o in enumerate(q.options))
            how = {
                "single": "Pick one letter.",
                "multi": "Pick every letter that applies.",
                "open": "Answer in your own words.",
            }
            number = len(state.questions) - len(pending) + 1
            why = (
                f" Backboard memory: they found {TOPIC_NAMES[q.topic]} hard before, so this comes first."
                if focus is not None and q.topic in focus.topics
                else ""
            )
            return (
                f"Question {number} of {len(state.questions)} (id {q.id}). {q.prompt} {options} {how[q.kind]}".strip()
                + why
            )

        return await _as_user(work)

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False))
    async def answer_quiz_question(
        board_id: board_arg,
        question_id: Annotated[str, Field(description="The id from next_quiz_question.")],
        answer: Annotated[
            str, Field(description="Letters such as `A, C` for choice questions, or the developer's words.")
        ],
    ) -> str:
        """Grade the developer's answer and return the feedback and explanation to show them."""

        def work(user_id: str) -> str:
            with services.db.session() as session:
                _board_parts(services, session, user_id, board_id)
                question = next(
                    (q for q in services.quiz.questions(session, user_id, board_id) if q.id == question_id), None
                )
            if question is None:
                raise ToolError("That question is out of date. Call next_quiz_question again.")
            if question.kind == "open":
                body = AnswerIn(question_id=question_id, text=answer)
            else:
                letters = _option_letters(answer, len(question.options))
                if not letters:
                    last = chr(64 + len(question.options))
                    raise ToolError(f"Answer with the option letters from A to {last}, such as `A, C`.")
                body = AnswerIn(
                    question_id=question_id, choice_ids=[question.options[ord(ch) - 65].id for ch in letters]
                )
            answered = services.quiz.answer(user_id, board_id, body)
            graded = answered.attempt
            # Folded to one line, so a line break in model feedback cannot pose as another `Result:` line.
            text = " ".join(f"Result: {graded.result}. {graded.feedback} {graded.explanation}".split())
            return text + _memory_line(answered.memory)

        return await _as_user(work)


def _board_parts(
    services: Services, session: Session, user_id: str, board_id: str
) -> tuple[SystemMap, ThreatAnalysis | None]:
    """A board's map and analysis, or a tool error saying how to get a map when it has none."""
    row = services.boards.get(session, user_id, board_id)
    system = read_map(row)
    if system is None:
        raise ToolError(
            "This board has no map yet. "
            "Try again after the developer adds material and confirms the map in the web app."
        )
    return system, current_analysis(row)


def _option_letters(answer: str, count: int) -> list[str]:
    """The option letters in a choice answer, or none when it names a letter out of range or no letter at all."""
    tokens = [token for token in _LETTER_SEPARATORS.split(answer.strip()) if token]
    if tokens and all(len(token) == 1 and token.isalpha() for token in tokens):
        # Letters alone, in either case: `a, c` or `B`.
        letters = [token.upper() for token in tokens]
    else:
        # A sentence such as "B, because it is a boundary": only capitals count, and "I" is the pronoun
        # unless the question has that many options.
        letters = [ch for ch in _CAPITAL.findall(answer) if ch != "I" or count >= 9]
    picked = list(dict.fromkeys(letters))
    if any(ord(ch) - 65 >= count for ch in picked):
        return []
    return picked


def _memory_line(memory: MemoryUse | None) -> str:
    """A closing line on what Backboard memory did, so the agent can say memory took part; empty when it is off."""
    if memory is None:
        return ""
    count = len(memory.recalled)
    recalled = f"recalled {count} note{'' if count == 1 else 's'} from earlier sessions and " if count else ""
    return f"\nBackboard memory {recalled}kept a note of this for next time."


async def _as_user[T](work: Callable[[str], T]) -> T:
    """Run `work` for the token's owner on a worker thread, turning app errors into tool errors."""
    token = get_access_token()
    if token is None or token.subject is None:
        raise ToolError("Connect with a personal token: `Authorization: Bearer tvd_...`.")
    user_id = token.subject
    try:
        return await anyio.to_thread.run_sync(work, user_id)
    except AppError as exc:
        # The agent can act on the app's message, such as a busy board or a used-up budget.
        raise ToolError(exc.message) from exc
