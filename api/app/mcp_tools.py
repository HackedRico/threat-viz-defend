from collections.abc import Callable
from typing import Annotated, Any

import anyio
from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import AnyHttpUrl, Field
from starlette.applications import Starlette

from app.boards.ingest import agent_material
from app.boards.service import read_analysis, read_map
from app.boards.views import board_summary
from app.context import Services
from app.db import utcnow
from app.domain.briefing import brief
from app.domain.briefing import describe_element as describe_one
from app.domain.quiz import build_quiz
from app.errors import AppError
from app.schemas import AnswerIn

# =============================================================================
# Module Overview
# =============================================================================
# The remote MCP server a coding agent connects to at `/mcp` with a personal
# token. Its tools let the agent read a board, ask about it, report a change it
# just made, and quiz the developer inside the editor. Each tool runs the same
# services the web app uses, as the token's owner, on a worker thread.

INSTRUCTIONS = (
    "Tools for the developer's threat model boards. Call list_boards to find a board id. After you change how "
    "the system is built (new services, routes, data stores, third party APIs, AI tools), call report_change with "
    "a summary and the diff so the board's map stays current. Use get_board or ask_board before designing a change "
    "that touches sensitive data or untrusted input. When the developer asks to be quizzed, use next_quiz_question "
    "and answer_quiz_question, and never reveal an answer before they try."
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
        json_response=True,
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
                analysis = read_analysis(row)
                elements = "\n".join(f"- {n.id}: {n.label} ({n.kind})" for n in system.nodes)
                return f"{brief(system, analysis, max_threats=6)}\n\nStatus: {row.status}.\nElements:\n{elements}"

        return await _as_user(work)

    @mcp.tool(annotations=read_only)
    async def describe_element(
        board_id: board_arg, element_id: Annotated[str, Field(description="A node or flow id from get_board.")]
    ) -> str:
        """Describe one component or flow on a board and the threats pinned to it."""

        def work(user_id: str) -> str:
            with services.db.session() as session:
                row = services.boards.get(session, user_id, board_id)
                system = read_map(row)
                if system is None:
                    raise ToolError("This board has no map yet.")
                return describe_one(system, read_analysis(row), element_id)

        return await _as_user(work)

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
    async def ask_board(
        board_id: board_arg, question: Annotated[str, Field(description="A question about the system's threats.")]
    ) -> str:
        """Ask a question about a finished board, such as what could go wrong if a new route trusts user input."""

        def work(user_id: str) -> str:
            answer = services.boards.ask(user_id, board_id, question[:2000], None)
            return answer.answer + (f"\nRelated ids: {', '.join(answer.highlight)}" if answer.highlight else "")

        return await _as_user(work)

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False))
    async def report_change(
        board_id: board_arg,
        summary: Annotated[str, Field(description="What you changed and why, in one or two sentences.")],
        diff: Annotated[str, Field(description="The unified diff of the change, if you have it.")] = "",
        files: Annotated[list[str], Field(description="Paths of the files you changed.")] = [],  # noqa: B006
    ) -> str:
        """Update the board's map from a change you just made; the developer reviews it in the app."""

        def work(user_id: str) -> str:
            services.limiter.hit(f"agent-change:{user_id}", 30, 3600, "Too many agent changes this hour.")
            material = agent_material("Coding agent", summary[:4000], diff[:200_000], files[:500], utcnow())
            services.boards.add_material(user_id, board_id, material)
            origin = services.settings.public_origin or ""
            return f"The map is being updated. The developer can review it at {origin}/boards/{board_id}."

        return await _as_user(work)

    @mcp.tool(annotations=read_only)
    async def next_quiz_question(board_id: board_arg) -> str:
        """The next whiteboard defense question for the developer, with lettered options when it has any."""

        def work(user_id: str) -> str:
            with services.db.session() as session:
                state = services.quiz.state(session, user_id, board_id)
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
            return (
                f"Question {number} of {len(state.questions)} (id {q.id}). {q.prompt} {options} {how[q.kind]}".strip()
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
                questions = build_quiz(*_board_parts(services, session, user_id, board_id))
            question = next((q for q in questions if q.id == question_id), None)
            if question is None:
                raise ToolError("That question is out of date. Call next_quiz_question again.")
            if question.kind == "open":
                body = AnswerIn(question_id=question_id, text=answer)
            else:
                letters = [ch for ch in answer.upper() if "A" <= ch <= "Z"]
                ids = [question.options[ord(ch) - 65].id for ch in letters if ord(ch) - 65 < len(question.options)]
                body = AnswerIn(question_id=question_id, choice_ids=ids)
            graded = services.quiz.answer(user_id, board_id, body).attempt
            return f"Result: {graded.result}. {graded.feedback} {graded.explanation}"

        return await _as_user(work)


def _board_parts(services: Services, session: Any, user_id: str, board_id: str) -> tuple[Any, Any]:
    """A board's map and analysis, or a tool error when it has no map."""
    row = services.boards.get(session, user_id, board_id)
    system = read_map(row)
    if system is None:
        raise ToolError("This board has no map yet.")
    return system, read_analysis(row)


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
