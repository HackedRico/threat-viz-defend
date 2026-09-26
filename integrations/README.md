# Coding agent integrations

Connect Claude Code or Cursor to a ThreatViz Defend board in one of two ways. Both authenticate with a personal
token (`tvd_...`) that you create in the web app under Settings, "Connect a coding agent".

| | MCP server | Hook |
| --- | --- | --- |
| Runs | when the agent decides to call a tool | on every prompt and at the end of every turn |
| Good for | asking about the board, quizzing you in the editor | keeping the board's map current without anyone remembering to |
| Sends | what the agent passes to a tool | the diff of architectural changes since the last report |

They work well together: MCP for asking and quizzing, the hook for keeping the map current.

## Environment variables

| Variable | Used by | Value |
| --- | --- | --- |
| `THREATVIZ_API_URL` | both | API origin, like `https://api.example.com`. Plain `http` only works for localhost. |
| `THREATVIZ_TOKEN` | both | Your personal token. Only ever read from the environment, never from a file. |
| `THREATVIZ_BOARD_ID` | hook | Board id. Optional once `init` has written `.threatviz.json`. |

Export them in the shell profile that starts your editor. Cursor started from the Dock or Start menu does not see
shell variables, so start it from a terminal with `cursor .`.

## MCP server

The server lives at `<api origin>/mcp` (streamable HTTP, bearer token). Its tools: `list_boards`, `get_board`,
`describe_element`, `ask_board`, `report_change`, `next_quiz_question` and `answer_quiz_question`. Try asking the
agent "quiz me on my threat model board".

### Claude Code

```sh
claude mcp add --transport http threatviz "$THREATVIZ_API_URL/mcp" --header "Authorization: Bearer $THREATVIZ_TOKEN"
```

This writes the expanded token into your Claude Code config. To keep the token out of every file, copy
[`claude-code/mcp.example.json`](claude-code/mcp.example.json) to `.mcp.json` in your repo instead: Claude Code
fills in `${THREATVIZ_API_URL}` and `${THREATVIZ_TOKEN}` when it starts, so the file is safe to commit. Check the
connection with `/mcp`.

### Cursor

Copy [`cursor/mcp.example.json`](cursor/mcp.example.json) to `.cursor/mcp.json`. Cursor fills in
`${env:THREATVIZ_API_URL}` and `${env:THREATVIZ_TOKEN}` from its environment.

## Hook

[`hook/threatviz_hook.py`](hook/threatviz_hook.py) is one file that needs Python 3.10+ and git 2.26+, nothing else.

1. In your repo, copy it in: `mkdir -p .threatviz && cp <this repo>/integrations/hook/threatviz_hook.py .threatviz/`
2. Link the repo to a board:

   ```sh
   export THREATVIZ_TOKEN=tvd_...
   python3 .threatviz/threatviz_hook.py init --board <board id> --api-url https://api.example.com
   ```

   `init` checks the token and the board, writes `.threatviz.json` (`api_url` and `board_id`, safe to commit),
   and records the current state as the base, so only changes from now on are reported.
3. Register the hook in one editor:
   - Claude Code: merge [`claude-code/settings.example.json`](claude-code/settings.example.json) into
     `.claude/settings.json`. `init` prints the same snippet.
   - Cursor: copy [`cursor/hooks.example.json`](cursor/hooks.example.json) to `.cursor/hooks.json` and replace the
     path, or paste the output of `python3 .threatviz/threatviz_hook.py print-config cursor`.

Cursor can also load the hooks in `.claude/settings.json`. If you use both editors on one repo, configure the hook
in one place only, or every turn is posted twice.

### What it does each turn

- On prompt submit it saves the prompt, masked, to `.git/threatviz/prompts.json`. Only the last 5 are kept.
- On stop it returns at once and carries on in the background. It snapshots the worktree through a temporary
  index into `refs/threatviz/pending`, without touching your index, branch, stash or files, and diffs it against
  `refs/threatviz/base` (or `HEAD` the first time).
- It skips the post when nothing changed, or when the change looks non-architectural. It counts as architectural
  when it touches a manifest, Dockerfile, compose file, infrastructure code or env example, or adds lines about
  HTTP clients, routes, env vars, databases, queues, model SDKs or auth.
- Otherwise it posts the diff, with the saved prompts as the summary. The board redraws its map and the change
  waits in review.
- On `202` the base moves to the snapshot and the prompts are cleared. On `409` (board busy), `429` or any error
  the base stays, so the next turn's diff includes this change too.

Other commands: `status` shows the config, base and last outcome; `print-config claude|cursor` prints the hooks
config for that editor.

## What leaves your machine

- The hook sends the unified diff of changed files since the last report (at most 180,000 characters), their
  paths, your last prompts (up to 5, 750 characters each) and the agent's name. It sends nothing for changes it
  skips.
- Files the server's file policy skips are never sent: env files and other credential stores, private keys,
  lockfiles, binaries, and vendored or generated folders such as `node_modules`. The hook reads the policy from
  `GET /api/config` and falls back to a built in list. Skipped files are left out of the snapshot and filtered from
  both sides of the diff, so even a committed `.env` never appears. Files over the size cap are left out too.
- Credential-shaped values in the diff and prompts (keys, tokens, passwords in assignments, URL passwords, bearer
  tokens, private key blocks) are masked before posting, and the server masks them again on arrival.
- The token goes only to `THREATVIZ_API_URL`, over https unless it is localhost, and the hook never follows
  redirects.
- The MCP server receives only what the agent puts in a tool call.
- Snapshots stay in your repo's local git objects. To remove all hook state:
  `git update-ref -d refs/threatviz/base; git update-ref -d refs/threatviz/pending; rm -rf .git/threatviz`

## Troubleshooting

Start with `python3 .threatviz/threatviz_hook.py status`. The hook is silent by design, so `last run` is where
it reports.

| Symptom | Fix |
| --- | --- |
| `last run: never` | The hook found no config in the editor's environment, usually a missing `THREATVIZ_TOKEN`. Export it and restart the editor from that shell. |
| `skipped: no architectural change` | Expected for UI or refactor work. To report anyway, ask the agent to call `report_change` over MCP. |
| `kept: the board is busy` | The board was mapping or analyzing. The next turn retries with this change folded in. |
| `kept: the token was rejected` | The token was revoked. Create a new one in Settings and export it. |
| `kept: board not found` | Wrong board id. Run `init` again. |
| `error: could not reach ...` | Check `THREATVIZ_API_URL` and that the API is up. |
| `API url must use https` | Plain `http` is only allowed for localhost, since the token travels with every request. |
| The same change appears twice | Both Claude Code and Cursor hooks are configured for the repo. Remove one. |
| `locked: yes` for a long time | A run was killed. The lock expires after 5 minutes, or delete `.git/threatviz/lock`. |
| MCP answers `401` | The token was missing from the editor's environment when it started, or was revoked. |

To run the hook by hand and see the outcome:

```sh
echo '{"hook_event_name": "Stop", "cwd": "'"$PWD"'"}' | THREATVIZ_HOOK_FOREGROUND=1 python3 .threatviz/threatviz_hook.py
python3 .threatviz/threatviz_hook.py status
```

The hook's tests run from the API's environment: `cd api && uv run pytest ../integrations/hook/tests`.
