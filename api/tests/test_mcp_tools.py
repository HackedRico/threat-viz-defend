from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult, TextContent

from tests.factories import node, system

# =============================================================================
# Module Overview
# =============================================================================
# Tests for the MCP tools, called the way a coding agent calls them: the `mcp`
# client over streamable HTTP to `/mcp` with a personal token. `call_tool`
# returns whether the call failed and the text the agent would read.


def agent_token(client: TestClient) -> str:
    """A new personal token for the signed-in user."""
    response = client.post("/api/tokens", json={"name": "agent"})
    assert response.status_code == 201, response.text
    token: str = response.json()["token"]
    return token


def call_tool(client: TestClient, token: str, name: str, arguments: dict[str, Any]) -> tuple[bool, str]:
    """Call one tool as a coding agent would and return whether it failed and its text."""

    async def call() -> CallToolResult:
        http = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=client.app), headers={"Authorization": f"Bearer {token}"}
        )
        async with http, Client(streamable_http_client("http://testserver/mcp", http_client=http)) as agent:
            return await agent.call_tool(name, arguments)

    # The app's MCP session manager runs in the test client's event loop, so the call must run there too.
    assert client.portal is not None
    result = client.portal.call(call)
    text = " ".join(block.text for block in result.content if isinstance(block, TextContent))
    return result.is_error, text


def example_board(client: TestClient) -> str:
    """The id of the finished example board every new account gets."""
    board_id: str = next(b["id"] for b in client.get("/api/boards").json() if b["example"])
    return board_id


def empty_board(client: TestClient) -> str:
    """The id of a new board with no material and no map."""
    response = client.post("/api/boards", json={"title": "Payments"})
    assert response.status_code == 201, response.text
    board_id: str = response.json()["id"]
    return board_id


def test_an_agent_quizzes_the_developer_on_a_finished_board(signed_in: TestClient) -> None:
    token = agent_token(signed_in)
    failed, text = call_tool(signed_in, token, "next_quiz_question", {"board_id": example_board(signed_in)})
    assert not failed
    assert text.startswith("Question 1 of ")


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("next_quiz_question", {}),
        ("answer_quiz_question", {"question_id": "threat:T1", "answer": "A"}),
        ("describe_element", {"element_id": "api"}),
    ],
)
def test_tools_that_need_a_map_say_how_to_get_one(signed_in: TestClient, tool: str, arguments: dict[str, str]) -> None:
    token = agent_token(signed_in)
    failed, text = call_tool(signed_in, token, tool, {"board_id": empty_board(signed_in), **arguments})
    assert failed
    assert "This board has no map yet" in text
    assert "confirms the map in the web app" in text


def test_a_map_with_nothing_to_ask_is_not_a_finished_quiz(signed_in: TestClient) -> None:
    token = agent_token(signed_in)
    board_id = empty_board(signed_in)
    lone = system([node("api")], []).model_dump(mode="json")
    assert signed_in.put(f"/api/boards/{board_id}/map", json={"map": lone}).status_code == 200
    failed, text = call_tool(signed_in, token, "next_quiz_question", {"board_id": board_id})
    assert failed
    assert "no quiz questions yet" in text


def test_get_board_lists_the_node_and_flow_ids_describe_element_takes(signed_in: TestClient) -> None:
    token = agent_token(signed_in)
    board_id = example_board(signed_in)
    failed, text = call_tool(signed_in, token, "get_board", {"board_id": board_id})
    assert not failed
    lines = text.splitlines()
    assert "- agent: Triage agent (process)" in lines
    assert "- f4: Web app to API: API requests" in lines
    failed, text = call_tool(signed_in, token, "describe_element", {"board_id": board_id, "element_id": "f4"})
    assert not failed
    assert text.startswith("Web app to API: API requests.")


def test_describe_element_reports_an_id_missing_from_the_map_as_an_error(signed_in: TestClient) -> None:
    token = agent_token(signed_in)
    board_id = example_board(signed_in)
    failed, text = call_tool(signed_in, token, "describe_element", {"board_id": board_id, "element_id": "agent"})
    assert not failed
    assert text.startswith("Triage agent")
    failed, text = call_tool(signed_in, token, "describe_element", {"board_id": board_id, "element_id": "ghost"})
    assert failed
    assert "no node or flow with id ghost" in text
