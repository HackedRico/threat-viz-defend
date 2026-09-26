# ThreatViz Defend

ThreatViz Defend draws a threat model of your system from its code and docs, then quizzes you until you can defend that model at a whiteboard.

It is for developers who ship code that a coding agent helped write, and who need to explain how that code can be attacked and what stops it. It does not tell you a system is secure. It shows you where to look, why, and checks that you understood.

It is a hosted, invite-only web app. Coding agents such as Claude Code and Cursor can connect to it, so the map keeps up with the code as it changes.

**Live:** `<deployed URL goes here>`

## hackUMBC 2026

ThreatViz Defend is our entry for [hackUMBC 2026](https://hackumbc-2026.devpost.com/). We wrote all of its code during the event, from Sat 2026-09-26 12:00 ET to Sun 2026-09-27 11:45 ET.

**Demo video:** `<video link goes here>`

### Submission checklist

| Requirement | Where |
|---|---|
| Public GitHub repository | This repo |
| Demo video, at least 30 seconds | Linked above and on the Devpost entry |
| In-person demo, 3 to 5 minutes | A judge signs in and answers the voice quiz about the app's own threat model |
| Devpost entry created by Sun 11:00 ET, final by 11:45 ET | [hackumbc-2026.devpost.com](https://hackumbc-2026.devpost.com/) |
| One submission, at most four members | See [Team](#team) |

### Tracks

| Track | How ThreatViz Defend enters it | Status |
|---|---|---|
| Cybersecurity Application | A defensive tool for developers: evidence-cited threat models, STRIDE, boundary and lethal trifecta coverage decided by code, and a quiz that checks the developer understood them. The app's own threat model, every control and the known limits are in [docs/security.md](docs/security.md). | Built |
| Best Use of ElevenLabs | The voice coach runs the Defend quiz out loud through a private ElevenLabs agent, and dictation turns spoken questions into text with ElevenLabs Speech to Text. The server mints a short-lived conversation token per signed-in user, so the agent id alone is useless to a scraper. | Built |
| Best Use of DigitalOcean | The API, the web app and a Managed Postgres database run on App Platform from [.do/app.yaml](.do/app.yaml). [docs/deploy.md](docs/deploy.md) covers the setup. | Built |
| Best Domain Name from GoDaddy Registry | The domain is registered through GoDaddy Registry, with DNS pointing at App Platform. | `<domain goes here>` |
| Best Use of Backboard | Any user can route analysis through Backboard, and add Backboard memory to any provider so progress carries across sessions. | Built |
| Most Engaging Demo | A judge speaks with the voice coach, live, about how this app could be attacked. | Demo day |
| Best Overall, 1st and 2nd | The whole path runs end to end: material in, map confirmed, threats found, quiz passed, and coding agents keep the map current. | Demo day |

### Access and teardown

The hosted app is for event attendees only. Sign up takes a username, a password and an invite code we hand out in person, and every model and voice route spends from a daily budget per user, so bots cannot burn the credits. After judging we destroy the deployment, its database with every attendee account, the DNS records and every key. The repo stays public.

### Team

| Member | Area |
|---|---|
| Ricky | Core engine: the API, static and dynamic workflows, coding agent and model provider integrations |
| MD | Diagrams: how the model draws the map and how the canvas shows it |
| Eman | Voice: the ElevenLabs coach |
| Jonathan | Hosting and credits: DigitalOcean, the GoDaddy domain, platform accounts |

[docs/team.md](docs/team.md) maps each area to its folders.

## How it works

1. **Add material.** Paste design notes, add files, pick a whole code folder, or paste a public GitHub repository URL. Files that may hold credentials are skipped in the browser, and credential-shaped values are masked on the server.
2. **Check the map.** A language model draws a data flow diagram: external entities, processes, data stores, flows and trust boundaries. Every element cites the evidence it came from. You fix names, kinds, boundaries and flags, delete what is wrong, then confirm the map.
3. **Read the threats.** Rules in code decide what each element must be checked for: STRIDE per element, every flow that crosses a trust boundary, and the lethal trifecta on AI components (sensitive data, untrusted content and a way to send data out). The model then writes the 5 to 8 threats that matter most, each pinned to a map element, plus attack paths and a verdict on what to fix first.
4. **Defend it.** The Defend tab asks up to 7 questions about your own system: which flows cross a boundary, who reads sensitive data, where the worst threat happens, the STRIDE category of another top threat, how to break the trifecta, then two open questions in your own words. Code computes every answer key from the map. Only the open answers go to a model for grading. You get an explanation, the evidence behind it and a mastery score. A voice coach can run the same quiz out loud when the server has it set up.
5. **Keep it current.** Make a personal token and connect Claude Code or Cursor through the MCP server at `/mcp`, or install the hook. When the agent changes how the system is built, the board redraws its map and waits for you to review it.

## Design choices

- **Map first, threats second.** Threats are pinned to map elements, so a wrong map would give wrong threats.
- **Rules decide coverage, the model writes.** The STRIDE checklist, boundary crossings and trifecta come from code, so coverage never depends on the model.
- **Quiz keys come from code.** A model never decides what the right answer to a choice question is.
- **Every model reply is validated and cleaned.** Replies must match a JSON schema, get one repair attempt, then pass sanitizers that drop ids the map does not contain.
- **Uploaded content is not stored.** Only each source's name, kind and size are kept, so there is less to leak.
- **Model output renders as plain text.** A poisoned upload cannot inject HTML or links into the page or the exported report.
- **The analysis model has no tools.** It can read untrusted material, but it cannot act, so our own pipeline has no lethal trifecta.
- **Invite codes and daily budgets.** The server's model bill has a ceiling per user and overall.
- **Bring your own model.** Each user can point analysis at their own OpenAI-compatible endpoint or at Backboard, and add Backboard memory to any of them.
- **Admin by command line only.** There is no admin page for an attacker to reach from the web.

## Quick start

You need Python 3.12 with [uv](https://docs.astral.sh/uv/) and Node 24.

One command starts both halves, creates `.env` on the first run and installs what is missing:

```sh
./scripts/dev.sh
```

Or run each half in its own terminal. Start the API on port 8000:

```sh
cp .env.example .env          # once; the API reads the repo-root .env on its own
cd api
uv sync
uv run uvicorn app.main:app_from_env --factory --port 8000
```

In a second terminal, start the web app:

```sh
cd web
npm install
npm run dev
```

Open http://localhost:5173, choose **Sign in** on the home page, and use the development account from `.env` (`DEV_USERNAME` and `DEV_PASSWORD`). The server creates it at startup, with the example board, and resets it to that password if you change it. To try sign up instead, choose **Create an account** with the invite code `local-dev`. Development creates a SQLite database in `api/data/app.db`.

On a deployed server, `DEV_USERNAME` is refused; an operator creates accounts without an invite code with `uv run python -m app.cli create-user <name>`, which prompts for the password.

### Demo mode

With no model configured, the server runs in demo mode. Every new account gets a finished example board ("Example: Inbox Helper") that you can explore, ask recorded questions about, and quiz yourself on. Demo mode cannot map your own material, and it grades open quiz answers by keyword.

### Use a real model

Pick one:

- **Server default.** In the repo-root `.env`, set `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`, then restart the API.

- **Your own provider.** Open the account menu, choose **Model provider**, and save an OpenAI-compatible base URL, model and key, or a Backboard key. Under **Memory**, a Backboard key lets any of them remember your progress. This works in demo mode too, and only for your account.

### Run with Docker

`docker compose up --build` starts Postgres and one container that serves the API and the built web app together at http://localhost:8080. It reads `.env` from the repo root. [docs/deploy.md](docs/deploy.md) covers production.

### Admin commands

There is no admin page. On the server, from `api/`:

```sh
uv run python -m app.cli users              # list accounts
uv run python -m app.cli disable <name>     # block an account and end its sessions
uv run python -m app.cli enable <name>
uv run python -m app.cli delete <name>      # delete an account and everything it owns
uv run python -m app.cli stats              # counts of accounts, boards and usage records
```

### Checks

```sh
cd api && uv run pytest && uv run ruff check . && uv run mypy
cd web && npm run typecheck && npm test && npm run build
```

After changing `api/app/schemas.py` or a route, run `npm run gen:api` in `web/` to regenerate the TypeScript types.

## Docs

| Doc | What it covers |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Every screen and control, step by step, and troubleshooting |
| [docs/architecture.md](docs/architecture.md) | Components, the board lifecycle, model calls, rules, quiz, storage and the frontend |
| [docs/api.md](docs/api.md) | Every endpoint and MCP tool, errors, rate limits and budgets |
| [docs/security.md](docs/security.md) | What we protect, every control, our own threat model and known limits |
| [docs/deploy.md](docs/deploy.md) | Deploying to DigitalOcean App Platform |
| [integrations/README.md](integrations/README.md) | Connecting Claude Code and Cursor: MCP server and hook |
| [AGENTS.md](AGENTS.md) | Commands, contracts and rules for anyone changing the code |
| [docs/team.md](docs/team.md) | Who owns each area, how the areas attach to the core engine, and how to work in parallel |
| [docs/conventions.md](docs/conventions.md) | Code style, tests, docs, commits and pull requests |

## Project layout

```
threat-viz-defend/
├── api/                          Python API server
│   ├── app/
│   │   ├── main.py               builds the app: routes, MCP server, web app, error shape
│   │   ├── config.py             settings from the environment, validated at startup
│   │   ├── schemas.py            the HTTP contract
│   │   ├── web.py                request guard: host, CSRF, JSON-only writes, headers
│   │   ├── limits.py             rate limiter and daily budgets
│   │   ├── mcp_tools.py          the remote MCP server for coding agents
│   │   ├── quiz_service.py       quiz state and grading
│   │   ├── voice.py              ElevenLabs conversation tokens and speech to text
│   │   ├── cli.py                admin commands
│   │   ├── routes/               one module per area of the API
│   │   ├── domain/               pure logic: models, rules, quiz, masking, report
│   │   ├── analysis/             prompts and the Analyst
│   │   ├── llm/                  model adapters: OpenAI-compatible, Backboard
│   │   ├── providers/            per-user providers, key encryption, URL guard
│   │   ├── boards/               board lifecycle, ingest, GitHub importer
│   │   ├── auth/                 accounts, sessions, personal tokens
│   │   └── examples/             the built-in example board
│   ├── tests/
│   └── pyproject.toml
├── web/                          React and TypeScript app
│   ├── src/
│   │   ├── api/                  typed client and generated schema types
│   │   ├── auth/                 home page, sign in and create account
│   │   ├── shell/                sidebar, routing, session, account menu
│   │   ├── board/                canvas, layout, inspector, intake, panels
│   │   ├── quiz/                 Defend tab and text quiz
│   │   ├── voice/                voice coach
│   │   ├── settings/             coding agents and model provider
│   │   └── styles/               design tokens
│   ├── openapi.json              the API schema the types come from
│   └── package.json
├── integrations/                 hook and config examples for coding agents
├── docs/                         the docs listed above
├── .do/app.yaml                  App Platform spec
├── Dockerfile
├── docker-compose.yml
├── .env.example                  every server setting
└── AGENTS.md
```

## Tech stack

FastAPI, Pydantic, SQLAlchemy (SQLite or Postgres), argon2, the OpenAI Python SDK, the MCP Python SDK, React 19, Vite, ELK for layout, Rough.js for the hand-drawn look, zustand, and the ElevenLabs React SDK for voice.
