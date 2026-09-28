# Contributing to ThreatViz Defend

Thanks for helping. Bug reports, fixes, docs and new ideas are all welcome. This page covers how to run the app, how to make a change, and what a pull request needs before it merges.

Everyone who takes part agrees to the [code of conduct](CODE_OF_CONDUCT.md). To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Before you start

- **Small fixes**, such as a typo, a broken link or a one-line bug, can go straight to a pull request.
- **Anything bigger**, such as a new feature, a new model provider or a change to how the map or quiz works, starts with an issue. Say what problem it solves, so we can agree on the approach before you spend time on it.
- Look through the [open issues](https://github.com/HackedRico/threat-viz-defend/issues) first. If one matches, say there that you are working on it.

## Run it locally

You need Python 3.12 with [uv](https://docs.astral.sh/uv/), Node 24 with npm, and git.

```sh
git clone https://github.com/HackedRico/threat-viz-defend.git
cd threat-viz-defend
./scripts/dev.sh
```

The script creates `.env` from `.env.example`, installs both halves, and starts the API on http://localhost:8000 and the web app on http://localhost:5173. Sign in with `DEV_USERNAME` and `DEV_PASSWORD` from `.env`, or create an account with the invite code `local-dev`.

Without a model key the app runs in demo mode: it maps only the built-in example, "Example: Inbox Helper", and answers only its recorded questions. To try your own code, either set `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY` in `.env` and restart, or save your own OpenAI-compatible endpoint under Settings, **Model provider**. Any service that speaks the Chat Completions API works, including a local Ollama.

Voice, dictation and memory are optional. [.env.example](.env.example) lists every setting and what turns each feature on.

## Find your way around

ThreatViz Defend is two programs: a Python FastAPI server in `api/` that owns every rule, model call and piece of storage, and a React and TypeScript app in `web/` that draws what the API returns.

```
threat-viz-defend/
├── api/                  Python API server
│   ├── app/
│   │   ├── main.py       builds the app: routes, MCP server, web app, error shape
│   │   ├── config.py     settings from the environment, validated at startup
│   │   ├── schemas.py    the HTTP contract
│   │   ├── routes/       one module per area of the API
│   │   ├── domain/       pure logic: models, rules, quiz, masking, report
│   │   ├── analysis/     prompts and the Analyst
│   │   ├── llm/          the OpenAI-compatible model adapter
│   │   ├── boards/       board lifecycle, ingest, GitHub importer, versions
│   │   ├── providers/    per-user providers and memory, key encryption, URL guard
│   │   ├── auth/         accounts, sessions, personal tokens
│   │   └── examples/     the built-in example board
│   └── tests/
├── web/                  React and TypeScript app
│   └── src/
│       ├── api/          typed client and generated schema types
│       ├── auth/         home page, sign in and create account
│       ├── shell/        sidebar, routing, session, account menu
│       ├── board/        canvas, layout, inspector, intake, panels, exports
│       ├── quiz/         Defend tab and text quiz
│       ├── voice/        voice coach and dictation
│       ├── settings/     coding agents, model provider and memory
│       └── styles/       design tokens
├── integrations/         hook and config examples for coding agents
├── demo/                 the click to play demo
├── docs/                 guides, diagrams and the pitch deck
├── scripts/              dev.sh and the voice agent setup
└── .do/app.yaml          DigitalOcean App Platform spec
```

| To learn | Read |
|---|---|
| What goes where, the contracts and the security rules | [AGENTS.md](AGENTS.md) |
| How the pieces fit: board lifecycle, model calls, rules, quiz, storage | [docs/architecture.md](docs/architecture.md) |
| How the engine's two workflows run, file by file | [api/AGENTS.md](api/AGENTS.md) |
| How a map becomes a drawing | [web/src/board/AGENTS.md](web/src/board/AGENTS.md) |
| The voice coach and dictation | [web/src/voice/AGENTS.md](web/src/voice/AGENTS.md) |
| Hosting and deployment | [.do/AGENTS.md](.do/AGENTS.md) and [docs/deploy.md](docs/deploy.md) |
| Every control and our own threat model | [docs/security.md](docs/security.md) |
| Code areas and who reviews them | [docs/team.md](docs/team.md) |

The `AGENTS.md` files are written for coding agents and people alike. If you work with Claude Code, Cursor or another agent, it reads them on its own.

## Make a change

1. Fork the repo and branch from `main`. Name the branch `<type>/<short-topic>`, such as `fix/quiz-empty-answer` or `feat/gitlab-import`.
2. Keep the change to one area where you can. A change to a seam, such as `api/app/schemas.py` or the map prompt, needs review from that area's owner in [docs/team.md](docs/team.md).
3. Follow [docs/conventions.md](docs/conventions.md). The short version:
   - Every file opens with a Module Overview banner, every export has a one-line doc comment, and comments say why, never what.
   - Python is typed and `mypy --strict` clean. TypeScript is strict, with no `any` outside an SDK boundary.
   - Docs, UI copy, commits and PRs use plain words, sentence case and straight quotes, and never an em dash or en dash.
4. Add tests. A bug fix starts with a test that fails on the bug. Tests never call a real model, voice service or the network: use `DemoAnalyst`, scripted fakes, `InlineJobs` and the `make_client` fixture in `api/tests/conftest.py`.
5. Update the doc that describes the behavior you changed, in the same pull request.
6. If you changed `api/app/schemas.py`, `api/app/domain/models.py` or a route, run `npm run gen:api` in `web/` and commit the regenerated `web/openapi.json` and `web/src/api/schema.d.ts`.

Ask in the issue before you add a dependency, change a default in `api/app/config.py`, change a table in `api/app/tables.py`, or change what leaves the user's machine or reaches a model. Those changes affect everyone who runs the app.

## Run the checks

CI runs these on every pull request, and a change is done when both halves pass.

```sh
cd api
uv run pytest
uv run ruff check . && uv run ruff format --check . && uv run mypy
uv run pytest ../integrations/hook/tests

cd ../web
npm run typecheck && npm test && npm run build
```

CI also fails when `web/openapi.json` is out of date, and builds both Docker images.

## Keep the security rules

The app reads untrusted code and docs and sends them to a model, so its security rules are part of every change. [docs/security.md](docs/security.md) explains each one. Never weaken one to make a test pass:

- Untrusted text enters a prompt only through `fence()`, and every system prompt names its untrusted blocks.
- Model output renders as plain text. No `dangerouslySetInnerHTML`, and no Markdown to HTML.
- Uploads are masked and never stored. Files the policy skips are never read.
- API keys never reach the browser or the logs.
- Never commit `.env`, a database or a real key. The repo is public.

## Open a pull request

- Title it as a [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): description`, lowercase, present tense, no trailing period. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `chore`. Scopes: `api`, `web`, `voice`, `diagrams`, `integrations`, `deploy`, `docs`.
- Fill in the template: what changed, why, how a reviewer can check it, and any risk.
- Commit as each piece works, and say why in the commit body.
- Keep pull requests small enough to review in one sitting. A stacked pull request, opened against another branch still in review, is fine; retarget it to `main` once the lower one merges.

## License

ThreatViz Defend is licensed under the [Apache License 2.0](LICENSE). By contributing, you agree that your contribution is licensed under the same terms.
