# Team and areas

The core engine is the hub. Every other area is a spoke that touches it at one seam: a route, a schema, a setting or a protocol. A spoke never reaches into another spoke; it goes through the engine. So four people, each with a coding agent, can build at once, and the engine is where the pieces are put together.

```text
                            Diagrams (MD)
                     map prompt, canvas drawing
                                  │
                    BoardOut and DRAFT_MAP_SYSTEM
                                  │
     Voice (Eman)                 │                 Coding agents
   ElevenLabs coach               │                 hook and MCP
           │                      │                       │
  quiz, voice routes              │               /mcp, /api/agent
           │                      │                       │
           │             ┌────────┴────────┐              │
           └─────────────┤   Core engine   ├──────────────┘
                         │     (Ricky)     │
           ┌─────────────┤ static, dynamic ├──────────────┐
           │             │ rules, quiz, API│              │
           │             └─────────────────┘              │
  config.py settings                          Llm and Memory protocols
           │                                              │
  Hosting (Jonathan)                             Model and memory
DigitalOcean, GoDaddy,                           OpenAI compatible,
        credits                                 Backboard memory
```

## The engine and its seams

The engine turns material into a map, a confirmed map into threats, and threats into a quiz. It has two workflows that end in the same place:

- **Static**: a person adds material (paste, files, a folder, a GitHub repo). The map is drafted, reviewed, confirmed, then threats are found.
- **Dynamic**: a coding agent reports a change (hook or MCP). The map is updated from the diff and waits in review, then the same confirm path runs.

[api/AGENTS.md](../api/AGENTS.md) walks both workflows file by file. Each spoke touches the engine at exactly one seam:

| Spoke | Owner | Seam into the engine | What crosses it |
|---|---|---|---|
| Diagrams | MD | `BoardOut` in `api/app/schemas.py`, and `DRAFT_MAP_SYSTEM` in `api/app/analysis/prompts.py` | The map to draw, the rules' findings, and the instructions that shape the map |
| Voice | Eman | `GET /api/boards/{id}/quiz`, `POST .../quiz/answers`, `POST .../voice`, `GET .../brief`, `POST /api/dictation` | Questions, answers, grades, a short-lived voice token, and dictated text |
| Hosting | Jonathan | `api/app/config.py` settings and `/api/health` | Environment variables in, a health check out |
| Coding agents | Ricky | `/mcp` tools and `POST /api/agent/boards/{id}/changes` | Diffs and summaries in, board facts out |
| Model providers | Ricky | The `Llm` protocol in `api/app/llm/base.py` | One structured request in, one validated object out |
| Memory | Ricky | The `Memory` protocol in `api/app/memory.py` | A query in and earlier notes out, or one new note in |

When a spoke needs something the seam does not carry, change the seam, not the other side of it: the engine owner adds the field, route or setting, and the spoke reads it.

## Owners

| Owner | Area | Folders | Area guide |
|---|---|---|---|
| Ricky | Core engine: static and dynamic workflows, the API, integration of every spoke | `api/`, `integrations/`, `web/src/api/`, `web/src/shell/`, `web/src/settings/`, `web/src/quiz/` | [api/AGENTS.md](../api/AGENTS.md) |
| MD | Diagrams: how the map is drawn by the model and on the canvas | `web/src/board/` | [web/src/board/AGENTS.md](../web/src/board/AGENTS.md) |
| Eman | Voice agent: the ElevenLabs coach | `web/src/voice/`, `scripts/elevenlabs_agent.py`, `api/app/voice.py` | [web/src/voice/AGENTS.md](../web/src/voice/AGENTS.md) |
| Jonathan | Hosting and credits: DigitalOcean, the GoDaddy domain, platform accounts | `Dockerfile`, `.do/`, `.github/`, `docker-compose.yml`, `docs/deploy.md` | [.do/AGENTS.md](../.do/AGENTS.md) |

Shared files sit on a seam, so the engine owner approves them. Change one in your own branch and name the approver in the PR:

| Shared file | Approver | Why it is shared |
|---|---|---|
| `api/app/schemas.py`, `api/app/domain/models.py` | Ricky | The contract every spoke reads; the web types are generated from it |
| `api/app/analysis/prompts.py` (`DRAFT_MAP_SYSTEM`) | Ricky, with MD | The map prompt decides what the diagram contains |
| `api/app/config.py`, `.env.example` | Ricky, with Jonathan | Every deployment setting is read here |
| `web/src/styles/tokens.css` | MD | Colors, fonts and spacing for every screen |
| `AGENTS.md`, `docs/` | Ricky | Every agent reads them |

## Adding a new spoke

A new platform or feature, such as a new model provider, attaches the same way:

1. Decide its seam. A model service is a provider adapter in `api/app/llm/` wired through `api/app/providers/service.py`. A data service is a module under `api/app/` that reads the tables, never uploaded content. A new screen reads existing routes.
2. Ricky adds or approves the seam: the route, schema field or setting.
3. The spoke's owner builds behind it in their own folder, with its own area guide.
4. Every rule in [docs/security.md](security.md) still holds, and the spoke gets a line in the tables above.

## Working in parallel

1. One branch per piece of work, named `<type>/<short-topic>`, such as `feat/diagram-direction` or `fix/voice-ios-audio`. Separate git worktrees let one person run several agents at once.
2. Branch from `main`. When your work needs a branch still in review, branch from it and open your PR against it: a stacked PR. Retarget it to `main` after the lower one merges.
3. Keep a PR to one area. A PR that changes a seam or another owner's folder names that owner as reviewer in its description.
4. Pull `main` into your branch before you ask for review, and again when CI reports a stale `web/openapi.json`.
5. A PR is done when CI is green, the doc for the changed behavior is updated, and the description says how to check it.

## Credits and accounts

Jonathan holds the platform accounts and credits: DigitalOcean, the GoDaddy domain, ElevenLabs and Backboard. Keys go into the host's environment settings or a teammate's local `.env`, never into the repository, a PR, an issue or a chat message. Ask Jonathan for a key; he rotates them after the event.
