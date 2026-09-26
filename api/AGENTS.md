# Core engine

The hub every other area attaches to ([docs/team.md](../docs/team.md) has the map of spokes). Owner: Ricky. This guide covers how the engine's two workflows run and where each seam is; the root [AGENTS.md](../AGENTS.md) holds the rules that apply everywhere.

## The two workflows

Both end in the same place: a confirmed map with threats and a quiz. A board's `status` tracks where it is: `empty`, `mapping`, `review`, `analyzing`, `ready`.

**Static: a person adds material.**
1. `POST /api/boards/{id}/sources` or `/github` in `app/routes/boards.py` checks the owner and pace, then `app/boards/ingest.py` (`build_material`) drops skipped files, masks secrets and ranks what is left into prompt text. `app/boards/github.py` fetches a repository first.
2. `Boards.add_material` in `app/boards/service.py` spends one model call, sets `mapping` and commits, then queues a job (`_queue_draft`).
3. The job calls `Analyst.draft_map` (`app/analysis/analyst.py`), which fences the material into `DRAFT_MAP_SYSTEM` (`app/analysis/prompts.py`), validates the reply as `SystemMap` and runs `sanitize_map` (`app/domain/rules.py`). The board goes to `review` with `previous_map` kept for the diff.
4. `POST /confirm` runs `find_threats` the same way: `coverage_checklist` and `ai_exposure` decide what to check, the model writes threats, `sanitize_analysis` drops anything not on the map. The board goes to `ready`.
5. `app/quiz_service.py` builds questions from the map and threats with `build_quiz` (`app/domain/quiz.py`); keys come from code, and only open answers go to `Analyst.grade`.

**Dynamic: a coding agent reports a change.**
1. The hook (`integrations/hook/threatviz_hook.py`) posts a diff to `POST /api/agent/boards/{id}/changes` (`app/routes/agents.py`), or an agent calls the `report_change` tool on the MCP server (`app/mcp_tools.py`). Both authenticate with a personal token.
2. `agent_material` in `app/boards/ingest.py` drops secret files from the diff and masks it again.
3. From here it is step 2 of the static workflow with the current map passed in, so the model updates the map instead of redrawing it. The change waits in `review` for a person.

## Seams

| Seam | Where | Rule |
|---|---|---|
| HTTP contract | `app/schemas.py`, `app/domain/models.py` | Change a shape here, then `npm run gen:api` in `web/`. Keep stored boards valid: they are revalidated on read. |
| Model calls | `Llm` in `app/llm/base.py`; `Analyst` in `app/analysis/analyst.py` | Every call goes through an `Analyst`. A new provider kind is an `Llm` adapter plus a branch in `Providers._build`. An adapter that keeps calls as memory says which in `remembers`, so quotes from the material stay out of them. |
| Which model serves a user | `Providers.for_user` in `app/providers/service.py` | A user's saved provider, else the server's; own-key calls pass through `GatedLlm`. |
| Slow work | `Jobs` in `app/jobs.py` | Queue only after the transaction commits, as `Boards._begin` does. |
| Budgets and pace | `Budget` and `RateLimiter` in `app/limits.py` | Every route that calls a model or voice spends first. |
| Settings | `app/config.py` | New variables are validated in `load_settings` and documented in `.env.example`. |

## Adding to the engine

- **A new analysis step**: a prompt and content builder in `app/analysis/prompts.py` using `fence()` and `untrusted()`, a `ModelOutput` schema in `app/domain/models.py`, a method on `Analyst` implemented in `LlmAnalyst` and `DemoAnalyst`, a sanitizer for any ids it returns, then a service method and a route.
- **A new quiz question**: a builder in `app/domain/quiz.py` that computes its key from the map, added to `build_quiz` in teaching order, with a test in `tests/test_quiz.py` against the Inbox Helper example.
- **A new rule**: a pure function in `app/domain/rules.py`, fed to the model through `coverage_checklist` if it should shape threats.
- **A new MCP tool**: in `_register_tools` in `app/mcp_tools.py`, running the same services as the web routes through `_as_user`.

## Checking your work

```bash
uv run pytest && uv run ruff check . && uv run ruff format --check . && uv run mypy
uv run pytest ../integrations/hook/tests
```

The built-in example in `app/examples/inbox_helper/` is the fixture for everything: `tests/factories.py` loads it by name, and the demo analyst replays it, so the whole static workflow runs without a key. Paste `app/examples/inbox_helper/material.md` into a new board to watch it end to end.
