# AGENTS.md

ThreatViz Defend is two programs in two languages. `api/` is a Python FastAPI server and `web/` is a React and TypeScript app. Each language owns the half it fits best; pick by where the code runs, never by habit. The [README](README.md) says what the product does and [docs/architecture.md](docs/architecture.md) explains how.

## Commands

```bash
./scripts/dev.sh                                               # from the repo root: API on :8000 and web on :5173, Ctrl+C stops both

# api/ (Python 3.12, uv)
uv sync                                                        # install
uv run uvicorn app.main:app_from_env --factory --port 8000     # dev server, demo mode, invite code local-dev
uv run pytest                                                  # every test; add -k name for one
uv run ruff check . && uv run ruff format --check . && uv run mypy
uv run python -m app.cli users                                 # admin: users, disable, enable, delete, stats

# web/ (Node 24, npm)
npm install && npm run dev                                     # http://localhost:5173, proxies /api to :8000
npm run typecheck && npm test && npm run build
npm run gen:api                                                # after any change to api/app/schemas.py or a route
```

A change is done when both halves pass their checks. CI runs the same commands and fails when `web/openapi.json` is stale.

## Where things go

| Change | Place |
|---|---|
| Rules, quiz questions, masking, reports: pure logic | `api/app/domain/`, no I/O, tested directly |
| Anything a model does | `api/app/analysis/` (prompts and `Analyst`) |
| A new model provider kind | an adapter in `api/app/llm/` that satisfies `Llm`, wired in `api/app/providers/service.py` |
| A new endpoint | `api/app/routes/<area>.py`, its bodies in `api/app/schemas.py`, then `npm run gen:api` |
| Voice coach | `web/src/voice/` and `scripts/elevenlabs_agent.py`; the server side is `api/app/voice.py` |
| Coding agent integrations | `api/app/mcp_tools.py`, `api/app/routes/agents.py`, `integrations/` |
| Deployment | `Dockerfile`, `.do/app.yaml`, `.env.example`, [docs/deploy.md](docs/deploy.md) |

## Contracts

- `api/app/schemas.py` is the HTTP contract and `api/app/domain/models.py` the map and threat shapes. `web/src/api/schema.d.ts` is generated from them; never edit it or redeclare an API shape in `web/`. Alias generated types once in `web/src/api/types.ts`.
- Shapes a model fills subclass `ModelOutput`: every key required, `None` for missing, never a default. Strict structured output rejects optional keys.
- Anything that holds ids from the model goes through the sanitizers in `api/app/domain/rules.py`, which drop ids the map does not contain.
- Boards store maps and analyses as JSON and validate them on read. A schema change must keep stored rows valid or the board silently loses its map.
- The quiz's answer keys come from code in `api/app/domain/quiz.py`. Only open answers go to a model for grading.
- Slow model work runs through `Jobs` after the request's transaction commits (`Boards._begin`). Queue a job inside an open transaction and SQLite deadlocks.

## Security rules

[docs/security.md](docs/security.md) explains each one. Keep them all; never weaken one to pass a test.

- Untrusted text (uploads, agent diffs, answers, earlier model output) enters a prompt only through `fence()` in `api/app/analysis/prompts.py`, and every system prompt names its untrusted blocks with `untrusted()`.
- Model output renders as plain text. No `dangerouslySetInnerHTML`, no Markdown to HTML. The report escapes model text with `_md`.
- Uploaded content is masked (`mask_secrets`) and never stored; only source names and sizes are. Files the policy skips are never read, in the browser or on the server.
- API keys never reach the browser or the logs. Users' keys are sealed with `SecretBox`; responses show the last four characters at most.
- A URL a user supplies passes `check_base_url` in `api/app/providers/netguard.py` when saved and again when used. The GitHub importer fetches only from GitHub's archive host.
- Cookie routes require JSON bodies and same-site or allowlisted origins (`RequestGuard` in `api/app/web.py`). Model and voice routes spend from `Budget` in `api/app/limits.py`.
- Never commit `.env`, a database or a real key. The repo is public.

## Code style

- Every file opens with a Module Overview banner after its imports, and every public function has a one-line doc comment. Comments say why, never what.
- Python: type every signature, `mypy --strict` clean, errors raised through the helpers in `api/app/errors.py` with a message that tells the user what to do next.
- TypeScript: strict, no `any` outside SDK boundaries, CSS beside each component, colors and fonts only from `web/src/styles/tokens.css`. Pure logic lives in `.ts` modules with `node:test` tests beside them.
- Tests never call a real model, voice service or network: use `DemoAnalyst`, scripted fakes, `InlineJobs` and the `make_client` fixture in `api/tests/conftest.py`.

## Writing and commits

- Docs and UI copy: plain words, sentence case headings, straight quotes, and never an em dash or en dash. Use a comma or a period.
- A behavior change updates the doc that describes it: [docs/user-guide.md](docs/user-guide.md) for screens, [docs/api.md](docs/api.md) for endpoints, [docs/security.md](docs/security.md) for controls, `.env.example` and [docs/deploy.md](docs/deploy.md) for configuration.
- Commits follow Conventional Commits, lowercase, no trailing period, no AI attribution. Scopes: `api`, `web`, `integrations`, `docs`.

## Ask first

Ask before adding a dependency, changing a default in `api/app/config.py`, changing a table in `api/app/tables.py`, or changing what leaves the user's machine or reaches a model.
