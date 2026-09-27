import { test } from "node:test";
import assert from "node:assert/strict";

import { claudeCommand, cursorConfig, envLine, hookInit, mcpUrl } from "./snippets.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks the exact setup text a developer pastes into their coding agent.

test("builds the Claude Code command", () => {
  assert.equal(
    claudeCommand("https://tv.example.com/"),
    'claude mcp add --transport http threatviz https://tv.example.com/mcp --header "Authorization: Bearer ${THREATVIZ_TOKEN:?run the export line first}"',
  );
});

test("builds the Cursor config with an env reference, not the token", () => {
  const config = JSON.parse(cursorConfig("http://localhost:5173"));
  assert.deepEqual(config, {
    mcpServers: { threatviz: { url: "http://localhost:5173/mcp", headers: { Authorization: "Bearer ${env:THREATVIZ_TOKEN}" } } },
  });
  assert.equal(mcpUrl("https://a.b//"), "https://a.b/mcp");
  assert.equal(envLine("tvd_x"), "export THREATVIZ_TOKEN=tvd_x");
});

test("the hook setup command names the board and the API origin, never the page's", () => {
  assert.equal(
    hookInit("b-1", "https://api.example.com/"),
    "python3 .threatviz/threatviz_hook.py init --board b-1 --api-url https://api.example.com",
  );
});
