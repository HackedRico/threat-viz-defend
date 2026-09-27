// =============================================================================
// Module Overview
// =============================================================================
// The ready-to-paste setup a coding agent needs to reach this deployment: the
// Claude Code command, the Cursor config, and the board id its tools take.
// Every builder is pure so the exact text is tested, not eyeballed.

/** The MCP endpoint for this deployment. */
export function mcpUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

/**
 * The `claude mcp add` command, reading the token from `THREATVIZ_TOKEN` so it stays out of shell history. The
 * `:?` form stops the shell with a message when the token was never exported, instead of saving an empty one.
 */
export function claudeCommand(origin: string): string {
  return `claude mcp add --transport http threatviz ${mcpUrl(origin)} --header "Authorization: Bearer \${THREATVIZ_TOKEN:?run the export line first}"`;
}

/** The hook's one-time setup command for a board, run in the project after copying the script to `.threatviz/`. */
export function hookInit(boardId: string, origin: string): string {
  return `python3 .threatviz/threatviz_hook.py init --board ${boardId} --api-url ${origin.replace(/\/+$/, "")}`;
}

/** The `.cursor/mcp.json` file, reading the token from the `THREATVIZ_TOKEN` environment variable. */
export function cursorConfig(origin: string): string {
  const config = {
    mcpServers: {
      threatviz: {
        url: mcpUrl(origin),
        // Cursor expands `${env:NAME}` itself, so the token never lands in a committed file.
        headers: { Authorization: "Bearer ${env:THREATVIZ_TOKEN}" },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/** The shell line that puts the token where the Cursor config looks for it. */
export function envLine(token: string): string {
  return `export THREATVIZ_TOKEN=${token}`;
}

/** A placeholder shown in snippets until a token is created. */
export const TOKEN_PLACEHOLDER = "<your token>";
