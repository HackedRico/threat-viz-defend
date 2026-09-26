# API reference

The API speaks JSON over HTTPS. Request and response bodies are defined in [api/app/schemas.py](../api/app/schemas.py) and the map and threat shapes in [api/app/domain/models.py](../api/app/domain/models.py). [web/openapi.json](../web/openapi.json) is the generated schema and lists every route below. Outside production the server also serves interactive docs at `/api/docs` and the schema at `/api/openapi.json`.

## Conventions

**Authentication.** Routes use one of two schemes, never both.

| Scheme | Used by | How |
|---|---|---|
| Cookie | The web app | Sign up or sign in sets an HttpOnly session cookie: `__Host-tvd_session` when `COOKIE_SECURE` is on (the production default), `tvd_session` otherwise. It lasts `SESSION_DAYS` days, 7 by default. |
| Bearer | Coding agents, the hook, the MCP server | `Authorization: Bearer tvd_...` with a personal token from `POST /api/tokens`. |

A missing or wrong credential gets `401`. A board that belongs to someone else gets `404`, the same as a board that does not exist.

**Writes.** On cookie routes, every `POST`, `PUT`, `PATCH` and `DELETE` with a body must send `Content-Type: application/json`, or it gets `415`. A request whose `Origin` is not this site or an allowed frontend origin gets `403`, and so does a request the browser labels `Sec-Fetch-Site: cross-site` from an origin not on the list. Request bodies reject unknown keys with `422`. See [security.md](security.md#sessions-and-csrf).

**Size.** A request body over 2,500,000 bytes gets `413`.

**Slow work.** Routes that start a model job answer `202` with the board in `mapping` or `analyzing`. Poll `GET /api/boards/{board_id}` until the status settles. If the job fails, the board returns to its earlier status and `error` holds the message.

## Errors

Every error has the same body:

```json
{"error": {"code": "conflict", "message": "The board is already working. Wait for it to finish, then try again."}}
```

The message is written for the user and says what to do next. `429` responses carry a `Retry-After` header in seconds.

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400, 415 | The request cannot be done as asked, the body is not JSON, or the Host header is unknown |
| `internal_error` | 500 | The server hit an unexpected error; the details are in the server log |
| `invalid_request` | 422 | The body failed validation; the message names the field |
| `unauthorized` | 401 | No valid session or token, or a wrong password |
| `forbidden` | 403 | Signed in but not allowed: bad invite code, sign ups closed, disabled account, cross-site request |
| `not_found` | 404 | No such thing, or it belongs to someone else |
| `conflict` | 409 | Wrong state: the board is busy, has no map yet, or is not in review |
| `rate_limited` | 429 | Too many requests in a window, or a locked account |
| `budget_exhausted` | 429 | Today's model calls, voice sessions or dictations are used up, for the user or for the whole app |
| `payload_too_large` | 413 | The body is over the cap |
| `model_error` | 429, 502, 503 | The model call failed: 429 when the provider rate limits, 503 when it is unreachable, times out, is not configured or rejects the key, 502 when its output was unusable or it refused |
| `voice_error` | 429, 503 | ElevenLabs is busy, unreachable or misconfigured |
| `not_configured` | 503 | The voice coach or dictation is not set up on this server |

## Rate limits and budgets

Rate limits count hits in a sliding window, in memory ([limits.py](../api/app/limits.py)). Budgets count rows in the `usage` table per UTC day and reset at midnight UTC.

| Limit | Key | Allowance | Setting |
|---|---|---|---|
| Sign ups | client IP | 60 per hour | fixed |
| Wrong invite codes | client IP | 20 per hour | fixed |
| Sign in attempts | client IP | 150 per 5 minutes | fixed |
| Failed sign ins | username and network | 5 failures lock that pair for 15 minutes; 50 across all networks lock the username | fixed |
| Personal tokens created | user | 10 per hour, at most 10 tokens held | fixed |
| Provider tests | user | 10 per 5 minutes | fixed |
| Agent changes (REST and MCP together) | user | 30 per hour | fixed |
| Model calls | user | 6 per minute, on any provider | `MODEL_CALLS_PER_MINUTE` |
| Model calls on the server's key | user | 60 per day | `DAILY_MODEL_CALLS` |
| Model calls on the server's key | everyone | 3000 per day | `GLOBAL_DAILY_MODEL_CALLS` |
| Voice sessions | user | 10 per day | `DAILY_VOICE_SESSIONS` |
| Dictations | user | 10 per minute | fixed |
| Dictations | user | 30 per day | `DAILY_DICTATIONS` |
| Accounts | deployment | 300 | `MAX_USERS` |
| Boards | user | 30 | fixed |

One model call is spent by each of: adding material, a GitHub import, an agent change, confirming a map, asking a question, and grading an open quiz answer. The call is spent when the request is accepted, so a job that fails later still counts. Choice questions are graded by code and cost nothing. Calls on a user's own provider key are recorded but only the per-minute limit applies to them.

## Meta

### `GET /api/health`
No auth. Returns `{"ok": true}`. Any Host header is accepted here, for platform health checks.

### `GET /api/config`
No auth. Public facts the sign in page and uploader need.

Response `ConfigOut`: `app_name`, `analyst` (the server model's label), `demo_mode`, `voice_enabled`, `dictation_enabled`, `signup_open`, and `file_policy`: the secret file names and extensions, safe `.env` suffixes, the secret word pattern, config extensions, ignored folders, lockfiles, binary extensions, and the caps `maxFileBytes` (200,000), `maxUploadBytes` (1,500,000) and `maxFiles` (400). The browser and the hook apply this policy before they upload anything.

## Auth

### `POST /api/auth/signup`
No auth. Body `SignupIn`: `username` (3 to 24 characters of letters, digits, dots, dashes and underscores, starting with a letter or digit; stored lowercase), `password` (10 to 128 characters, not a common password, not containing the username), `invite_code`, and `website`, a honeypot that must stay empty.

`201` with `MeOut` and the session cookie. The new account gets a copy of the example board.

Errors: `400` weak password, bad username or filled honeypot. `403` wrong invite code or the account limit reached. `409` username taken. `429` too many sign ups or wrong codes from this network.

### `POST /api/auth/login`
No auth. Body `LoginIn`: `username`, `password`. `200` with `MeOut` and the session cookie.

Errors: `401` wrong username or password, with the same timing whether or not the username exists. `403` disabled account. `429` too many attempts from this network, or the account is locked after repeated failures, with `Retry-After: 900`.

### `POST /api/auth/logout`
Cookie optional. Ends this browser's session and clears the cookie. `204`.

### `GET /api/auth/me`
Cookie. `200` with `MeOut`: `user` (`id`, `username`, `created_at`) and `usage` (`model_calls_today`, `model_calls_limit`, `voice_sessions_today`, `voice_sessions_limit`, `dictations_today`, `dictations_limit`). `model_calls_today` counts calls on the server's key only.

## Personal tokens

### `GET /api/tokens`
Cookie. `200` with a list of `TokenOut`: `id`, `name`, `prefix` (the first 10 characters), `created_at`, `last_used_at`. Never the secret.

### `POST /api/tokens`
Cookie. Body `TokenCreate`: `name` (1 to 60 characters). `201` with `TokenCreated`: `token`, shown in this response only, and `info`, a `TokenOut`. Errors: `409` at 10 tokens, `429` over 10 per hour.

### `DELETE /api/tokens/{token_id}`
Cookie. Revokes the token at once. `204`. Error: `404`.

## Boards

`BoardSummary` holds `id`, `title`, `status`, `example`, `updated_at`, `revision` and `counts` per severity. `BoardOut` adds `sources` (name, kind, bytes and time, never content), `map`, `previous_map`, `analysis`, `analysis_version`, `analyzed_by`, `error`, `created_at`, the newest 40 `events`, and two things the rules work out: `exposure` (per AI node: `private_data`, `untrusted`, `outbound`, `lethal`) and `crossings` (ids of flows that cross a trust boundary). Statuses are `empty`, `mapping`, `review`, `analyzing` and `ready`; [architecture.md](architecture.md#the-board-lifecycle) explains them.

### `GET /api/boards`
Cookie. `200` with the user's boards as `BoardSummary`, most recently changed first.

### `POST /api/boards`
Cookie. Body `BoardCreate`: `title` (1 to 120 characters). `201` with an empty `BoardOut`. Error: `409` at 30 boards.

### `POST /api/boards/example`
Cookie. No body. `201` with a fresh, finished copy of the built-in example. Error: `409` at 30 boards.

### `GET /api/boards/{board_id}`
Cookie. `200` with `BoardOut`. Error: `404`.

### `PATCH /api/boards/{board_id}`
Cookie. Body `BoardPatch`: `title`. `200` with `BoardOut`.

### `DELETE /api/boards/{board_id}`
Cookie. Deletes the board, its activity and its quiz attempts. `204`.

### `POST /api/boards/{board_id}/sources`
Cookie. Body `SourcesIn`: `sources`, 1 to 400 items of `SourceIn`: `name` (up to 300 characters), `kind` (`text`, `file` or `code`), `text` (up to 200,000 characters). Files the policy skips are dropped, credential-shaped values are masked, and the map is drawn, or updated when the board has one.

`202` with `BoardOut` in `mapping`. Errors: `400` when nothing readable was sent, `409` when the board is busy, `413`, `429` budget or per-minute limit. `400` also covers a saved provider whose base URL is no longer allowed.

### `POST /api/boards/{board_id}/github`
Cookie. Body `GithubIn`: `url`, a public repository such as `https://github.com/owner/repo` or `https://github.com/owner/repo/tree/<ref>`. The server downloads the tarball from `codeload.github.com` in a job and draws the map from its text files.

`202` with `BoardOut` in `mapping`. Errors: `400` for any other URL, `409`, `429`. A missing repository or a tarball over 30 MB fails the job and shows in `error`.

### `PUT /api/boards/{board_id}/map`
Cookie. Body `MapIn`: `map`, a full `SystemMap`. The map is sanitized, the old map becomes `previous_map`, and the board goes to `review`. `200` with `BoardOut`. Errors: `400` when no nodes remain, `409` when the board is busy.

### `POST /api/boards/{board_id}/confirm`
Cookie. No body. Accepts the drafted map and starts finding threats. `202` with `BoardOut` in `analyzing`. Errors: `409` unless the board is in `review` with a map, `429`.

### `POST /api/boards/{board_id}/ask`
Cookie. Body `AskIn`: `question` (up to 2,000 characters) and optional `focus`, a node or flow id the user selected. `200` with `Answer`: `answer` (plain text) and `highlight` (ids on the board). Errors: `409` until the board has threats, `429`, `502` or `503` `model_error`.

### `GET /api/boards/{board_id}/brief`
Cookie. `200` with `BriefOut`: `text`, a plain spoken walkthrough of the system, its boundaries, AI exposure and top threats. Error: `409` without a map.

### `GET /api/boards/{board_id}/report.md`
Cookie. `200` with `text/markdown` as an attachment named `threat-model.md`: summary, verdict, components, flows, lethal trifecta, threats, attack paths and assumptions. Model text is escaped so it renders as plain text. Error: `409` without a map.

## Quiz and voice

### `GET /api/boards/{board_id}/quiz`
Cookie. `200` with `QuizOut`: `analysis_version`, `questions` (each `id`, `topic`, `kind`, `prompt`, `options`; never the key), `results` keyed by question id, and `mastery` (`total`, `answered`, `correct`, `partial`, `score` from 0 to 1, `weak_spots`). A board without a map has no questions.

### `POST /api/boards/{board_id}/quiz/answers`
Cookie. Body `AnswerIn`: `question_id`, `choice_ids` (up to 10, for `single` and `multi` questions) or `text` (up to 3,000 characters, for `open` questions).

`200` with `AnsweredOut`: `attempt` and the new `mastery`. `attempt` holds `result` (`correct`, `partial` or `wrong`), `feedback`, `explanation`, `evidence` (quotes from the map), `highlight`, `correct_ids`, `your_ids` and `your_text`.

Errors: `400` with no option picked or an empty open answer, `404` when the question is out of date because the board changed, `409` when the board changed while grading, `429`, `502` or `503` for open answers.

### `DELETE /api/boards/{board_id}/quiz`
Cookie. Forgets every answer on the board. `204`.

### `POST /api/boards/{board_id}/voice`
Cookie. No body. Spends one voice session and returns `VoiceSessionOut`: `conversation_token`, good for one ElevenLabs conversation, and `dynamic_variables`: `user_name`, `system_name`, `board_brief` (up to 1,500 characters) and `question_count`.

Errors: `503` `not_configured` when voice is off, `409` without a map, `429` `budget_exhausted`, `429` or `503` `voice_error`.

### `POST /api/dictation`
Cookie. Body `DictationIn`: `audio`, a recording of up to about 1,500,000 bytes encoded as base64, and `audio_type`, one of `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg` or `audio/wav`. Spends one dictation, sends the clip to ElevenLabs Speech to Text with the server's key, and returns `DictationOut`: `text`, the words heard, up to 2,000 characters, or empty when nobody spoke. Neither the clip nor the text is stored. The web app puts the text in the ask box for the user to read before asking.

Errors: `503` `not_configured` when dictation is off, `400` when `audio` is not base64, is under 1,000 bytes, or ElevenLabs cannot read it, `422` for another format, `429` `rate_limited` or `budget_exhausted`, `429` or `503` `voice_error`.

## Model provider

`ProviderOut` holds `source` (`custom`, `server` or `demo`), `kind`, `base_url`, `model`, `key_preview` (`...` and the last four characters, or null), `memory`, `label` and `updated_at`. The key itself is never returned.

### `GET /api/provider`
Cookie. `200` with `ProviderOut`: the user's saved provider, or the server's default.

### `PUT /api/provider`
Cookie. Body `ProviderIn`: `kind` (`openai_compatible` or `backboard`), `base_url`, `model` (Backboard models as `provider/model`), `api_key` (null keeps the saved key when the kind and base URL are unchanged, and is refused otherwise; an OpenAI-compatible provider may be saved without one), `memory` (Backboard only).

`200` with `ProviderOut`. Errors: `400` when the base URL is not https (plain http only where private addresses are allowed), holds credentials, a query or a fragment, does not resolve, or resolves to a private or local address; also when a new Backboard provider has no key or the model lacks its `provider/` prefix.

### `DELETE /api/provider`
Cookie. Forgets the provider and key; the server's default takes over. `204`.

### `POST /api/provider/test`
Cookie. Body `ProviderIn`. Checks the URL the same way, then lists the endpoint's models (OpenAI-compatible) or its assistants (Backboard). Nothing is saved.

`200` with `ProviderTestOut`: `ok`, `label`, `message` and up to 200 `models`. A rejected key, an unreachable host, or a model the endpoint does not list is `ok: false` with a message, not an HTTP error. With `api_key` null the saved key is used, but only for the same kind and base URL. Errors: `400` for a refused URL, `429` over 10 tests per 5 minutes.

## Coding agents

### `GET /api/agent/boards`
Bearer. `200` with the token owner's boards as `BoardSummary`. The hook uses it to check a board id.

### `POST /api/agent/boards/{board_id}/changes`
Bearer. Body `AgentChangeIn`: `agent` (default `Coding agent`), `summary` (up to 4,000 characters), `diff` (a unified diff, up to 200,000 characters), `files` (up to 500 paths). Diff sections for files the policy skips are dropped, values are masked, and the map is updated from the change.

`202` with `AgentChangeOut`: `board_id`, `status` and `review_url`, a link to the board in the web app (the first `CORS_ORIGINS` entry, else `PUBLIC_ORIGIN`). Errors: `401`, `404`, `409` when the board is busy, `429`.

## MCP tools

`/mcp` is a remote MCP server over streamable HTTP, stateless, with JSON responses. Connect with a personal token as `Authorization: Bearer tvd_...`; without one it answers `401`. Each tool acts as the token's owner. A tool that cannot do what was asked returns a tool error, with `isError` set and a message that says what to do next. App errors, such as a busy board or a spent budget, come back this way with the app's message. On a board with no map yet, `describe_element` and both quiz tools return a tool error that asks the developer to add material and confirm the map in the web app, and `get_board` reports the board's status. [integrations/README.md](../integrations/README.md) has the client setup.

| Tool | Arguments | Does | Spends |
|---|---|---|---|
| `list_boards` | none | Lists boards: id, title, status, threat counts | nothing |
| `get_board` | `board_id` | Describes the system, its trust zones, AI exposure, up to 6 threats with fixes, the status and every node id | nothing |
| `describe_element` | `board_id`, `element_id` | Describes one node or flow and the threats pinned to it | nothing |
| `ask_board` | `board_id`, `question` | Answers a question about a finished board, with related ids | 1 model call |
| `report_change` | `board_id`, `summary`, `diff`, `files` | Updates the map from a change the agent made; the developer reviews it in the app | 1 model call, 1 of 30 agent changes per hour |
| `next_quiz_question` | `board_id` | The next unanswered question with lettered options, or the score when all are answered; a map with no questions is a tool error | nothing |
| `answer_quiz_question` | `board_id`, `question_id`, `answer` | Grades letters such as `A, C` or the developer's own words, and returns the result, feedback and explanation | 1 model call for open questions |

## Examples

These run against a local server started as in the [README](../README.md#quick-start). Writes need the JSON content type.

Create an account and keep the cookie:

```sh
curl -c jar.txt -H 'Content-Type: application/json' \
  -d '{"username":"ada","password":"a long passphrase","invite_code":"local-dev"}' \
  http://localhost:8000/api/auth/signup
```

Start a board, add notes, then poll until the map is drawn:

```sh
BOARD=$(curl -s -b jar.txt -H 'Content-Type: application/json' -d '{"title":"Payments"}' \
  http://localhost:8000/api/boards | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')

curl -b jar.txt -H 'Content-Type: application/json' \
  -d '{"sources":[{"name":"design notes","kind":"text","text":"A React app calls a FastAPI service..."}]}' \
  http://localhost:8000/api/boards/$BOARD/sources

curl -s -b jar.txt http://localhost:8000/api/boards/$BOARD | python3 -c 'import sys, json; d = json.load(sys.stdin); print(d["status"], d["error"])'
```

Once the board is `ready`, read the quiz with `GET /api/boards/$BOARD/quiz` and answer a choice question by its id:

```sh
curl -b jar.txt -H 'Content-Type: application/json' \
  -d '{"question_id":"stride:T2","choice_ids":["I"]}' \
  http://localhost:8000/api/boards/$BOARD/quiz/answers
```

Report a coding agent's change with a personal token:

```sh
curl -H "Authorization: Bearer $THREATVIZ_TOKEN" -H 'Content-Type: application/json' \
  -d '{"agent":"Claude Code","summary":"Added a Redis cache in front of the orders API","diff":"diff --git a/app.py b/app.py\n+import redis","files":["app.py"]}' \
  http://localhost:8000/api/agent/boards/$BOARD/changes
```
