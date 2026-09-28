# Architecture

ThreatViz Defend is one Python API and one React app. The API owns every rule, every model call and all storage. The browser draws what the API returns and never reimplements a rule.

## Components

```
                   cookie + JSON                        SQL
  Browser  ------------------------------>  API  ---------------->  Postgres or SQLite
  (React app)                            (FastAPI)
     |                                      |
     | WebRTC with a one-time token         +--> model: DigitalOcean serverless inference,
     v                                      |    or the user's own OpenAI-compatible endpoint
  ElevenLabs agent                          +--> Backboard (memory: recall and keep notes)
                                            +--> codeload.github.com (repository tarballs)
                                            +--> api.elevenlabs.io (mints conversation tokens)
  Coding agent (Claude Code, Cursor)        |
     |   MCP over HTTP, bearer token        |
     +------------------------------------->+  /mcp
     |   hook posts diffs, bearer token     |
     +------------------------------------->+  /api/agent/boards/{id}/changes
```

| Component | Talks to | How |
|---|---|---|
| Browser | API | JSON over HTTPS with an HttpOnly session cookie. It polls a board every 1.5 seconds while the server works on it and every 5 seconds otherwise, and polls the board list every 15 seconds, only while the tab is visible. |
| API | Database | SQLAlchemy. SQLite in development and tests, Postgres in production. |
| API | Model provider | The server's default model, or the provider the user saved. See [Provider seam](#provider-seam). |
| API | Backboard | The memory layer around the model: searches a user's notes before an answer or grade, and keeps a note after every question and quiz answer. With `BACKBOARD_API_KEY` for everyone, or with a user's own key. See [Memory](#memory). |
| API | GitHub | Downloads one tarball per import from `codeload.github.com`. |
| API | ElevenLabs | Asks for a one-conversation token for the private voice agent, and sends dictated questions to Speech to Text. The ElevenLabs key never leaves the server. |
| Browser | ElevenLabs | Starts a WebRTC voice session with that token. The agent calls tools in the browser, which call the API. |
| Coding agent | API | The remote MCP server at `/mcp`, or the hook in [integrations/](../integrations/README.md), both with a personal token. |

[main.py](../api/app/main.py) builds the app. `create_app` wires settings, the database, the analyst, Backboard memory, the job runner and the voice clients into `Services` ([context.py](../api/app/context.py)), mounts the JSON routes from [routes/](../api/app/routes/), serves the built web app when `STATIC_DIR` is set, and mounts the MCP app last because it matches every path. Every request first passes `RequestGuard` in [web.py](../api/app/web.py), which checks the Host header, the body size, cross-site writes and content type, and adds the security headers. [docs/security.md](security.md) describes each check.

Every error leaves the API as `{"error": {"code", "message"}}`. Routes raise `AppError` from [errors.py](../api/app/errors.py), and the handlers in `main.py` turn validation errors and unexpected exceptions into the same shape.

## The board lifecycle

A board holds one system's threat model. Its status says what it is waiting for.

| Status | Meaning | Next |
|---|---|---|
| `empty` | No material yet | Add material: `mapping` |
| `mapping` | A job is drawing or updating the map | Success: `review`. Failure: back to the status before |
| `review` | A drafted map waits for a person | Confirm: `analyzing`. Edit: stays `review`. Add material: `mapping` |
| `analyzing` | A job is finding threats on the confirmed map | Success: `ready`. Failure: back to `review` |
| `ready` | Map and threats are done; the quiz is available | Edit the map or add material: `review` or `mapping` |

[boards/service.py](../api/app/boards/service.py) owns every transition.

- **Background jobs.** Drawing a map or finding threats can take up to the model timeout (`LLM_TIMEOUT_S`, 120 seconds by default), so those routes answer `202` with the board in its busy status. `Boards._begin` checks the board is idle, picks the user's analyst, claims the board with one conditional write so two requests that both saw it idle cannot both start a job, spends one model call from the budget, and commits, and only then hands the work to a `Jobs` runner ([jobs.py](../api/app/jobs.py)). Committing first matters: a job that wrote the board inside the open transaction would deadlock on SQLite. `ThreadJobs` runs jobs on a pool of 8 threads, which also caps concurrent background model calls. Tests use `InlineJobs`. Questions and the grading of open answers run inside the request instead, so the model client holds them to 30 seconds, retries included. The client retries a busy or failing provider itself, honoring its `Retry-After` up to 60 seconds, backing off longer for background jobs, and logs each retry as `[llm] ... retrying in Ns`. A timeout is not retried.
- **Failure.** A failed job, or a job whose final save fails, puts the board back to the stable status it had before (`empty`, `review` or `ready`), stores the message in `board.error`, and adds a `failed` line to the activity log. The browser shows the error in a banner.
- **Restart recovery.** On startup `recover_interrupted` finds boards left in `mapping` or `analyzing`, returns one left `analyzing` to `review` and one left `mapping` to the status its stored map and analysis allow, and records "The server restarted while this was running. Try again."
- **Hand edits.** `PUT /api/boards/{id}/map` runs the map through `sanitize_map`, keeps the old map as `previous_map` so review can mark what changed, and sets the board to `review`. The old threats stay stored until the next confirm replaces them. Only a `ready` board's threats describe its map, so the browser shows them only then, and the server reads them through `current_analysis`: the quiz, questions, brief, report, voice and MCP tools ignore them on any other status.
- **How each part works.** Every node carries `how`, 2 to 4 points naming the library, algorithm, protocol or method it uses, and `code`, up to 4 `path`, `line` and `symbol` references into the material, so a developer can defend the part at a whiteboard without a follow-up question. `sanitize_map` caps both. Maps stored before these fields existed read them as empty lists, and a copy of the built-in example saved then gets them from the example by node id when it is read.
- **Versions.** [boards/versions.py](../api/app/boards/versions.py) keeps each map a board holds in `map_versions`: `record_change` runs wherever the map changes (the example, a draft job's save and a hand edit) and `attach_analysis` pins a confirm's threats to the newest version. A board made before history was kept lists its map as version 1 without writing, and its first change saves that map as version 1 before the new one. Only the latest `MAX_VERSIONS` (30) stay. The board is polled, so listing reads only small columns (number, source, label, part and threat counts); the map and threats are deferred and loaded by `open_version` for one version at a time.
- **Updates.** New material on a board that has a map sends the current map to the model as `<current_map>`, with the instruction to keep ids that still exist and change only what the material contradicts.
- **Revision.** Every change bumps `revision`, so the browser knows when to refetch and can warn when someone else, such as a coding agent, changed a map while the user had unsaved edits.

## Model calls

Every model call goes through an `Analyst` ([analysis/analyst.py](../api/app/analysis/analyst.py)) with a prompt from [analysis/prompts.py](../api/app/analysis/prompts.py).

| Task | Triggered by | Prompt's job | Untrusted blocks | Output schema | Cleaned by |
|---|---|---|---|---|---|
| `draft_map` | Adding material, a GitHub import, an agent change | Draw or update the data flow diagram, citing evidence for every node and flow, and saying how each node works and where its code is | `<material>`, `<current_map>` | `SystemMap` | `sanitize_map`, then a check that the map has nodes |
| `find_threats` | Confirming a map | Consider every checklist line, write the 5 to 8 threats that matter most, 1 to 3 attack paths and a verdict | `<map>`, `<checklist>`, `<ai_exposure>` | `ThreatAnalysis` | `sanitize_analysis` |
| `answer` | Ask, and the MCP `ask_board` tool | Answer in 1 to 3 sentences from the map and threats only, with ids to highlight | `<map>`, `<threats>`, `<focus>`, `<question>` | `Answer` | `only_known` on highlights |
| `grade` | An open quiz answer | Judge the developer's own words as solid, partial or missed against the expected elements and rubric | `<map>`, `<threats>`, `<question>`, `<expected>`, `<rubric>`, `<answer>` | `OpenGrade` | `only_known` on highlights |

`find_threats` also gets a `<style_example>`: the built-in example's verdict, worst threat and worst attack path, to copy for style only. It is read from `app/examples/` rather than written into the prompt, so every generated board reads like the example the UI is designed around: a verdict that starts "Fix <component> first:", and plain sentences that name components by their labels.

**Fencing.** Untrusted text enters a prompt only through `fence(tag, body)`. It wraps the body in a named block after `neutralize` escapes anything that looks like one of our own block tags, so a document cannot close its block and speak as instructions. Every system prompt ends with `untrusted(...)`, which names the blocks that hold data and tells the model to ignore instructions inside them.

**Material.** [boards/ingest.py](../api/app/boards/ingest.py) builds the `<material>` block. It drops files the file policy skips, masks credential-shaped values, and when there is too much, keeps what says most about architecture: pasted text first, then READMEs and design docs, manifests, deploy files, API specs, entry points, route and service folders, then other source files, with tests, fixtures, examples and generated types last. READMEs and docs together stop at 40,000 characters, so a well documented project still sends its code, and the name of a picked folder, such as `api/`, never ranks every file in it. The GitHub importer ranks every file in the archive the same way before reading any. A code folder also gets a file tree. Each line of a code file gets its number, as `12| `, so the map can point at `path:line`; prose and pasted text do not. Masking runs first, so the numbers never break a line-anchored pattern. The block is capped at 150,000 characters and each file at 24,000. Agent changes become material the same way through `agent_material`, which also drops whole diff sections for files that should never be read.

**Schema validation.** The Pydantic models in [domain/models.py](../api/app/domain/models.py) double as the JSON Schemas the model fills. Every key is required and unknown keys are rejected, which strict structured output needs. [llm/base.py](../api/app/llm/base.py) holds the helpers every adapter shares:

- `strict_schema` closes every object and marks every property required.
- `parse_json` accepts a reply wrapped in code fences or a sentence and validates it against the schema. It reads a reply in time linear in its length, since a user's own provider writes that text, and refuses one over 500,000 characters or nested deeper than the JSON decoder allows.
- `repair_message` lists what failed. Each adapter sends it once in the same conversation and gives up with `LlmError("bad_output")` if the second reply also fails.

`OpenAICompatibleLlm` asks for JSON the strongest way the provider allows: `json_schema` with `strict: true` for OpenAI, `json_object`, or the schema written into the system prompt. If a provider rejects `response_format`, it falls back to the prompt for the rest of its life. Only a 400 that names `response_format`, JSON or a schema does this; any other 400, such as a prompt over the context length, fails that one call and leaves structured output on for the next. A reply cut off at the token limit, a refusal and an empty reply each raise `LlmError`.

**Sanitizers.** [domain/rules.py](../api/app/domain/rules.py) makes model output consistent with the map before anything is stored:

- `sanitize_map` turns ids into safe lowercase slugs, drops duplicate ids, flows whose ends are missing or equal, and boundaries with no members, and caps the map at 30 nodes, 60 flows and 10 boundaries. It folds every text field onto one line, because coding agents read map text line by line in the MCP tools' replies.
- `sanitize_analysis` drops threats pinned to an element the map lacks, sorts by severity, keeps 10, renumbers them `T1`, `T2` and so on, keeps only attack path steps that are nodes on the map, and keeps 5 paths. Like `sanitize_map`, it folds every text field onto one line: threat titles, summaries and fixes, attack path stories and the verdict all reach agents inside lines of the MCP tools' replies.
- `only_known` drops highlight ids that are not a node, flow or threat on the board.

Text fields are clipped to fixed lengths on the way through.

## The rules engine

[domain/rules.py](../api/app/domain/rules.py) is pure code with no I/O. It decides coverage before the model sees the map.

- **STRIDE per element.** External entities get S and R. Processes get all six. Stores get T, I and D.
- **Trust boundary crossings.** A flow crosses when its two ends sit in different boundaries, counting "outside every boundary" as a zone of its own. Crossing flows get S, T, I and D and a note to check how the receiver knows the sender. Internal flows get T, I and D.
- **AI exposure and the lethal trifecta.** For every node marked `ai`, `ai_exposure` walks the flows upstream and downstream, stopping at external entities. Sensitive nodes upstream are its private data. External entities upstream that are not themselves AI are untrusted input. External entities downstream that are not AI are ways out. The node has the lethal trifecta when it has private data and some untrusted source differs from some way out.
- **The checklist.** `coverage_checklist` turns all of this into one line per element, adding OWASP LLM checks for AI components. `find_threats` receives it as `<checklist>`.

The same functions feed `BoardOut.exposure` and `BoardOut.crossings` ([boards/views.py](../api/app/boards/views.py)), the quiz, the spoken brief ([domain/briefing.py](../api/app/domain/briefing.py)) and the Markdown report ([domain/report.py](../api/app/domain/report.py)).

## The quiz engine

[domain/quiz.py](../api/app/domain/quiz.py) builds the questions from the current map and analysis. Code computes every answer key. A question is left out when the map cannot support it.

| Order | Topic | Kind | Asks | Key |
|---|---|---|---|---|
| 1 | `boundary` | multi | Which of these flows cross a trust boundary? | The crossing flows among the options |
| 2 | `data` | multi | Which components receive data from the first element marked sensitive that sends data anywhere? | The targets of flows leaving it |
| 3 | `threat` | single | Where on the map does the most severe threat happen? | The threat's element |
| 4 | `stride` | single | Which STRIDE category is the second most severe threat? | The threat's STRIDE letter |
| 5 | `trifecta` | single or multi | Which flow, removed alone, breaks the trifecta? If none can, which parts are its ways out? | Worked out by removing each flow and rerunning `ai_exposure` |
| 6 | `attack` | open | Something malicious comes from an external source: what path does it take, and what harm could it do? | The steps, hops and threats of the worst attack path that starts at an external entity, with its story and threat titles as the rubric. Without such a path, the first untrusted source of an AI component |
| 7 | `fix` | open | How would you stop the most severe threat? | The threat's element and id, with its fixes as the rubric |

Questions about flows and components show at most 5 options (4 for the `threat` question), always keep room for one wrong option, and list options in map order so position gives nothing away. The `stride` question shows all six categories. `grade_choice` returns `correct`, `partial` (some right picks) or `wrong`. Open answers go to the analyst's `grade`, and its verdict maps solid to `correct`, partial to `partial` and missed to `wrong`.

[quiz_service.py](../api/app/quiz_service.py) stores each attempt with the board's `analysis_version`. Questions are rebuilt from every new analysis, so only attempts on the current version count. Mastery is `(correct + 0.5 * partial) / total`, and its weak spots are the elements behind every answer that was not fully correct. The answer key and explanation reach the browser only after the question is answered. With memory on, `Quiz.focus` moves the topics a developer missed before to the front; see [Memory](#memory).

## Provider seam

```
Llm protocol           OpenAICompatibleLlm      any Chat Completions endpoint
(llm/base.py)

Analyst protocol       LlmAnalyst               wraps an Llm, runs the sanitizers
(analysis/analyst.py)  DemoAnalyst              replays the built-in example, grades by keyword

AnalystSource          Providers.for_user       the user's saved provider, else the server's analyst
(providers/service.py) FixedAnalyst             one analyst for everyone, used by tests

MemorySource           MemorySettings.for_user  the user's Backboard memory while it is on
(memory.py)            NoMemory                 no memory, used by tests
```

- `Llm.generate(request)` takes a task name, a system prompt, the user text and a schema, and returns a validated instance or raises `LlmError` with a code: `not_configured`, `auth`, `rate_limited`, `timeout`, `unavailable`, `bad_output` or `refused`. `parse_json` takes the first JSON object in the reply that fits the schema, whatever prose, notes or thinking blocks surround it, and bends the slips a model makes without schema enforcement: an enum in another case, a STRIDE category spelled out, a null or supporting list left out, an extra key. Anything else still fails and gets one repair round.
- `OpenAICompatibleLlm` ([llm/openai_compat.py](../api/app/llm/openai_compat.py)) uses the OpenAI SDK against any base URL. With `LLM_CONCURRENCY` set, calls to the server's model queue for a slot, so a provider that serves one call at a time never sees two: a background job waits up to 10 minutes for its turn, a question or grade up to its 30 second budget. A timeout is reported at once rather than resent.
- `DemoAnalyst` runs when the server has no `LLM_API_KEY` and `LLM_MODEL`. It maps only text that contains the example's material, finds threats only on the example map, answers only recorded questions, and grades open answers by the words they share with the expected elements and rubric.
- `Providers.for_user(user_id)` returns `Chosen(analyst, own_key)`. With a saved provider it checks the base URL again, decrypts the key, and builds the adapter; `own_key=True` means the call spends the user's key, so only the per-minute limit applies. Without one it returns the server's analyst.

## Memory

Backboard is the memory layer around the model calls; it never makes one. [memory.py](../api/app/memory.py) holds `BackboardMemory`, one Backboard assistant per user reached through Backboard's memory API only, and [providers/memory.py](../api/app/providers/memory.py) holds `MemorySettings`, which decides whose account that is and whether memory is on.

- **Whose account.** A user's own Backboard key, sealed like a provider key, when they saved one; else the server's `BACKBOARD_API_KEY`; else none. The assistant is created on the first note and its id is saved, in `memories` for an own key and in `memory_prefs` for the server's. A lock around creation keeps two notes kept at once from making two assistants.
- **Recall.** Before `Boards.ask` and before `Quiz.answer` grades an open answer, `recall` searches the user's notes with the question and passes up to five to the analyst, which fences them into the prompt as `<memory>`. The prompts say to use them only to pitch the reply, never as facts about the system, and never to change a verdict.
- **Keep.** After every question and every quiz answer, choice questions included, a note goes to Backboard on a background job, so Backboard never slows the reply. [domain/notes.py](../api/app/domain/notes.py) writes them: the board's title and the question, or the quiz topic, the question and whether it was right, partly right or wrong. Uploads, maps and the developer's own answer text never go in.
- **Focus.** `Quiz.focus` recalls notes about missed questions, reads them back into quiz topics with `weak_topics`, and the quiz orders those topics first. It is cached per board and analysis for 20 minutes so the order holds still through one sitting, and dropped when the quiz starts over. The web quiz, the MCP quiz tools and the voice coach's brief all use it.
- **Showing it.** Answers and grades carry `memory` (`recalled` notes and whether one was `kept`), and the quiz carries `focus`. The web app shows both; MCP tools add a line saying what memory did.
- **Failures.** A Backboard error is logged and the call goes on without memory. Only the memory page reports one, as `503 memory_error`.

## Voice coach

[voice.py](../api/app/voice.py) mints a WebRTC conversation token for the private ElevenLabs agent with the server's key. `POST /api/boards/{id}/voice` spends one voice session and returns the token plus a short spoken brief of the board as dynamic variables. With memory on, the brief starts with the topics the developer found hard before. The browser ([web/src/voice/](../web/src/voice/AGENTS.md)) starts the session and registers four client tools: `get_next_question`, `submit_answer`, `show_on_board` and `get_board_brief`. `submit_answer` posts to the same quiz route as the text quiz, so grading happens on the server either way.

Dictation uses the same key through `ElevenLabsTranscriber` in the same file. The mic beside **Ask** records a clip with `MediaRecorder` and posts it as base64 JSON to `POST /api/dictation`, which spends one dictation in its own short transaction, then sends the clip to ElevenLabs Speech to Text outside it, as asking does with the model. The text comes back to the ask box and nothing is stored. Because the browser only talks to the API, dictation needs no CSP change on either hosting layout.

## Coding agents

- **MCP server.** [mcp_tools.py](../api/app/mcp_tools.py) serves stateless streamable HTTP at `/mcp`, answering with an event stream so headers go out at once; Claude Code gives up on a response without headers after 60 seconds, which a model-backed tool can take. A token verifier accepts personal tokens and passes the owner's user id to each tool. Tools run the same services the web app uses, as that user, on a worker thread, and turn `AppError` into a tool error the agent can read. [docs/api.md](api.md#mcp-tools) lists the tools.
- **Agent route.** `POST /api/agent/boards/{id}/changes` takes a summary, a diff and a file list and treats them as new material.
- **Hook.** [integrations/hook/threatviz_hook.py](../integrations/hook/threatviz_hook.py) runs in Claude Code or Cursor. On each stop it snapshots the worktree, diffs it against the last reported snapshot, skips files the server's file policy skips, masks secrets, and posts the change only when it touches architecture. See [integrations/README.md](../integrations/README.md).

## Storage

[tables.py](../api/app/tables.py) defines every table. The API creates missing tables on startup; there is no migration step.

| Table | Holds |
|---|---|
| `users` | Username, argon2id password hash, disabled flag, created and last login times |
| `login_sessions` | SHA-256 hash of each session cookie, owner, created, last seen and expiry times |
| `api_tokens` | Token name, SHA-256 hash, first 10 characters, created and last used times |
| `boards` | Title, status, source records, the map, the previous map, the analysis, analysis version, which model analyzed it, the last error, revision |
| `board_events` | Activity log lines |
| `map_versions` | Each map a board has held: number, what made it, a label, the map, the threats found on it, and part and threat counts |
| `quiz_attempts` | Each answer: picked option ids or the typed text, the result and the feedback |
| `usage` | One row per model call, voice session or dictation, for budgets |
| `providers` | A user's provider kind, base URL, model, the API key sealed with AES-GCM and its last four characters. The `memory` and `assistant_id` columns are unused, kept so older databases load; a row with the old `backboard` kind is ignored |
| `memories` | A user's own Backboard key for memory, sealed with AES-GCM, its last four characters and the Backboard assistant id in their account |
| `memory_prefs` | A user's memory switch, and their Backboard assistant id in the server's account |

Stored: maps and analyses as JSON, validated again when read. A stored value that no longer validates is logged and treated as missing. Also stored: source records, activity lines, quiz answers including open answers in the user's words.

Never stored: the content of uploads, pasted text, GitHub files or agent diffs. After the model call only each source's name, kind and size remain. Raw passwords, session secrets, personal tokens and plain API keys are never stored either.

Deleting a board deletes its events and quiz attempts. Deleting an account through the CLI deletes everything it owns.

## Frontend

The web app in [web/src/](../web/src/) is React 19 with Vite. There is no router library; [shell/route.ts](../web/src/shell/route.ts) maps three screens to paths: `/`, `/boards/{id}` and `/settings` or `/settings/provider`. Before sign in, [auth/authView.ts](../web/src/auth/authView.ts) picks the screen instead: the home page at `/`, the account forms at `/signin` and `/signup`, and the sign in form for any other path, so a link into the app opens once the visitor signs in.

| Folder | Holds |
|---|---|
| `api/` | The typed client (`openapi-fetch`), the generated `schema.d.ts`, aliases in `types.ts`, and error handling |
| `auth/` | The home page with its replay of the example board, sign in and create account |
| `shell/` | App layout, sidebar, account menu with usage meters, routing, polling |
| `board/` | The board screen: intake, the drawing state, the canvas, the ELK layout, the inspector, the ask bar under the canvas, the review panel, the ready panel with threats, paths, defend and activity, and the export menu |
| `quiz/` | The Defend tab and the text quiz |
| `voice/` | The voice coach, loaded only when used |
| `settings/` | Connect a coding agent and model provider |
| `styles/` | Design tokens and base styles |

The canvas lays out the map with ELK, loaded on first use, both top to bottom and left to right, and draws whichever shows larger in its space as SVG with Rough.js. The same drawing serves both workflows: a map drafted from material and a map updated from a coding agent's diff. A small zustand store holds what the user is pointing at: the selected element and the ids lit by an answer, a quiz result, the voice coach or an attack path. The voice coach's tools light the map through that store from outside React. The same store keeps which way round the canvas draws the map, so an export draws it that way too.

Exports draw the map in the browser, since only the browser has its layout. `MapScene` in [MapCanvas.tsx](../web/src/board/MapCanvas.tsx) draws the marks for the canvas and for `MapPicture`, which the PDF report and the image files use, so every export matches the board. The PDF is `PaperReport`, mounted beside the app and printed alone by the browser's print dialog. The PNG and SVG files come from [exportImage.ts](../web/src/board/exportImage.ts), which inlines each element's computed style and embeds the fonts. Only the Markdown report comes from the server.

## Contract flow

```
api/app/schemas.py + api/app/domain/models.py      Pydantic models
        |  uv run python -m app.openapi
        v
web/openapi.json                                   OpenAPI schema, committed
        |  openapi-typescript
        v
web/src/api/schema.d.ts                            generated TypeScript, never edited
        |
        v
web/src/api/types.ts, web/src/api/client.ts        aliases and typed calls
```

`npm run gen:api` in `web/` runs both steps. CI regenerates `openapi.json` and fails when the committed copy is stale, so a changed route or body breaks the TypeScript build instead of the running app.
