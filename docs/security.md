# Security

This page describes how ThreatViz Defend protects the people who use it, what it does with their code, and where its protections stop. Every control below names the code that enforces it, so you can check the claim. The [known limits](#known-limits) section lists what we do not protect against.

ThreatViz Defend never says a system is secure. The threats it shows are written by a language model from a map a person checked, and the exported report tells the reader to check every finding against its evidence.

## What we protect

| Asset | Why it matters |
|---|---|
| Accounts and sessions | A stolen session reads a user's boards and spends their budget |
| Users' code and design docs | Uploads describe how a system is built and may contain secrets |
| Maps, threat models and quiz answers | They describe a system's weak points |
| Users' model provider API keys | They cost the user money and may reach other data at that provider |
| Personal tokens | They let a coding agent act for the user |
| The server's own model key and budget | Every model call on the server's key costs the operator money |
| The ElevenLabs key | Voice minutes cost the operator money |

## Abuse controls

The app is invite-only, and the expensive parts are metered. All limits live in [limits.py](../api/app/limits.py) and [auth/service.py](../api/app/auth/service.py); [api.md](api.md#rate-limits-and-budgets) lists every number.

- **Invite codes.** Sign up needs a code from `INVITE_CODES`. Codes are compared in constant time. Production refuses codes shorter than 6 characters, and an empty list closes sign ups. A wrong code counts against a limit of 20 per hour per network.
- **Honeypot.** The sign up form has a `website` field that people never see. A request that fills it is refused and the source IP is logged.
- **Per-network limits, kept loose on purpose.** At a venue everyone can share one public IP, so per-IP limits are high: 60 sign ups per hour and 150 sign in attempts per 5 minutes. The invite code is the real gate. The client IP comes from the header named by `CLIENT_IP_HEADER` (App Platform's `do-connecting-ip`) only when `TRUST_PROXY` is on; otherwise it is the socket peer. IPv6 clients are counted by their /64, since one client usually holds a whole /64, and wrong invite codes also have a ceiling across all networks, 300 per hour.
- **Account lockout.** After 5 failed sign ins for one username from one network in 15 minutes, that pair is locked for 15 minutes, even with the right password. A looser ceiling of 50 failures per username across all networks stops a distributed guess. Keying the tight limit on the network means a stranger cannot lock someone else out from elsewhere. A success clears the count.
- **Account cap.** Sign ups stop at `MAX_USERS` accounts, 300 by default.
- **Daily budgets.** Each user may make `DAILY_MODEL_CALLS` model calls (60), start `DAILY_VOICE_SESSIONS` voice sessions (10) and dictate `DAILY_DICTATIONS` questions (30, 10 a minute at most) per UTC day on the server's keys. All users together may make `GLOBAL_DAILY_MODEL_CALLS` model calls (3000). The `usage` table records every spend, so budgets survive a restart.
- **Per-minute limit.** Each user may make `MODEL_CALLS_PER_MINUTE` model calls (6) per minute, including calls on their own provider key.
- **Other caps.** 30 boards per user, 10 personal tokens per user, 10 new tokens per hour, 10 provider tests per 5 minutes, 30 agent changes per hour, one background job per board at a time, and 4 background model jobs running at once across the server.
- **Request size.** `RequestGuard` in [web.py](../api/app/web.py) refuses a body over 2,500,000 bytes, by `Content-Length` and again while the body streams in. Request schemas cap every string and list, and reject unknown keys.
- **Admin.** There is no admin page. Operators run [cli.py](../api/app/cli.py) on the host to list, disable, enable or delete accounts. Disabling an account deletes all its sessions, and a disabled account's tokens stop working.

## Sessions and CSRF

- **Session cookie.** Sign in creates a 32-byte random secret. Only its SHA-256 hash is stored, so a database leak cannot be replayed as a session. The cookie is `HttpOnly`, `Path=/`, `SameSite=Lax` by default, and lasts `SESSION_DAYS` days (7). In production it is `Secure` and named `__Host-tvd_session`; the prefix makes browsers refuse it unless it is Secure, host-only and on `/`. Sign out deletes the session row. `COOKIE_SAMESITE=none` is refused unless the cookie is also Secure.
- **JSON-only writes.** A `POST`, `PUT` or `PATCH` with a body to a cookie route must be `Content-Type: application/json`, or it gets `415`. An HTML form cannot send that type, and a cross-origin script cannot send it without a CORS preflight.
- **Origin check.** A write to a cookie route that carries an `Origin` header must come from `PUBLIC_ORIGIN` or a `CORS_ORIGINS` entry, or it gets `403`. Outside production, `localhost` origins also pass.
- **Fetch metadata.** A write labeled `Sec-Fetch-Site: cross-site` is refused unless its origin is on the list.
- **CORS allowlist.** CORS is on only when `CORS_ORIGINS` is set. It allows exactly those origins with credentials, never `*`, and only the `Content-Type` request header. Production requires every entry to be https.
- **Host check.** Requests whose `Host` is not `PUBLIC_ORIGIN`'s host or an `ALLOWED_HOSTS` entry get `400`, which blocks DNS rebinding against the API. Only `/api/health` is exempt, for the platform's health checker.
- **Token routes.** `/api/agent/*` and `/mcp` take a bearer token instead of a cookie. A browser never attaches that header on its own, so request forgery cannot reach them, and the CSRF checks skip them.

## Headers

`RequestGuard` adds these to every API response:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'` plus the ElevenLabs API and LiveKit hosts; `media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`, when cookies are Secure |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Permissions-Policy` | `microphone=(self), camera=(), geolocation=(), payment=()` |

No inline scripts are allowed. The voice SDK's audio worklets are served from our own origin under `/vendor/elevenlabs/`, so the policy needs no `blob:` scripts. When the web app is built for a separate static host, [vite.config.ts](../web/vite.config.ts) puts the same policy, minus `frame-ancestors`, in a `<meta>` tag, adding the API origin to `connect-src`. Production turns off the interactive API docs and the OpenAPI endpoint.

## Passwords

- Hashed with argon2id (argon2-cffi defaults: 64 MiB memory, 3 passes, 4 lanes). A hash made with older parameters is rehashed on the next sign in.
- At most two hashes run at once. A burst of sign ins waits for a slot, and after 5 seconds gets `503`, so parallel requests cannot exhaust the server's memory.
- Sign in with an unknown username still verifies against a throwaway hash, so response time does not reveal which usernames exist. Both cases return the same message.
- A new password must be 10 to 128 characters, not on a short list of common passwords, and must not contain the username.
- Sign up says a username is taken only after the invite code checks out, so listing usernames needs a valid code.

## Personal tokens

- A token is `tvd_` followed by 32 random bytes. Only its SHA-256 hash is stored, with its first 10 characters for display.
- The token is shown once, in the response that creates it. The web app says so and offers a copy button.
- Revoking deletes the row, and the token stops working on the next request.
- A token reaches only `/api/agent/*` and the MCP tools. It cannot manage tokens, change the model provider, delete boards or reach any cookie route.
- The `tvd_` prefix lets secret scanners spot a leaked token, and our own masking redacts it from uploads.
- The Cursor setup the app shows reads the token from `THREATVIZ_TOKEN` rather than writing it into a committed file, and the hook's `.threatviz.json` holds no secrets.

## Users' API keys

[providers/secrets_box.py](../api/app/providers/secrets_box.py) seals each saved key with AES-256-GCM. The key is SHA-256 of `APP_SECRET`, each seal uses a random 96-bit nonce, and the owner's user id is bound in as associated data, so a sealed key copied onto another account will not decrypt. A database dump alone reveals no key.

- `APP_SECRET` must be at least 32 characters, and production refuses to start without it. Changing it makes every saved key unreadable; users then save their keys again.
- Keys never leave the server. Responses show `...` and the last four characters at most. The form never refills a saved key; leaving the field empty keeps it.
- Keys are never logged.

## Server-side request forgery

The server makes outbound requests to three kinds of address. Two are fixed; one is user supplied.

**User provider base URLs** ([providers/netguard.py](../api/app/providers/netguard.py)). `check_base_url` runs when a provider is saved, when it is tested, and again before every use, because DNS can change after a save.

- Only `https` is allowed. Plain `http` is allowed only where private addresses are.
- No username or password in the URL, no query string and no fragment.
- Every address the host resolves to must be globally routable and not multicast. One private address among public ones fails the check.
- `ALLOW_PRIVATE_PROVIDER_URLS` lets a deployment call local models such as Ollama. It defaults to on in development and off in production.
- Error messages from the provider are cut to 200 characters before they reach the user.

**The GitHub importer** ([boards/github.py](../api/app/boards/github.py)).

- `parse_repo_url` accepts only `https://github.com/<owner>/<repo>` with an optional `/tree/<ref>`, checked by a strict pattern, and refuses `..`.
- The server fetches only `https://codeload.github.com/...`, with redirects off and a 30 second timeout. The user never picks the host.
- The download stops at 30 MB. The archive is read in memory and never written to disk. Only regular files are read, so links in the archive are ignored. Each file is capped at 200 KB, the total at 4 MB and 400 files, and only UTF-8 text is kept. The file policy applies to every path.

**Fixed hosts.** Backboard (`BACKBOARD_BASE_URL`) and ElevenLabs are called with redirects off.

**Saved keys stay with their host.** A saved key is reused only for the same provider kind and base URL. Changing either needs the key typed again, so someone holding a session cannot redirect a user's key to their own server. Model clients never follow redirects, so a public base URL cannot bounce a request to a private address.

## Prompt injection

Uploads, agent diffs, questions and quiz answers are untrusted, and any of them can contain text written to steer a model. The defenses are layered so that a successful injection changes only words a person then reads.

- **Fencing.** Untrusted text enters a prompt only through `fence()` in [analysis/prompts.py](../api/app/analysis/prompts.py). It escapes anything that looks like one of our block tags, so a document cannot close its block and speak as instructions.
- **Untrusted blocks named.** Every system prompt ends with `untrusted(...)`, which names the blocks that hold data and tells the model to ignore instructions in them, including text claiming to come from the user, the developer or the system. The map prompt also asks the model to note such instructions in the map's assumptions.
- **Structured output only.** Every reply must validate against a strict schema. There is no free text channel to act on.
- **Sanitizers.** Ids the map does not contain are dropped from threats, paths and highlights, and every text field is clipped. A reply cannot point the page at anything that is not on the board. `sanitize_map` and `sanitize_analysis` also fold each text field of a map and its threats, attack paths and verdict onto one line, and `ask_board` folds its answer the same way, so no text a model wrote can add a line that poses as another node, flow, threat or id list in the plain text the MCP tools return.
- **A person reviews the map.** Threats are only found on a map the user has checked and confirmed.
- **Answer keys from code.** Injected text cannot change which quiz answer is right. Only open answers are graded by a model, and that grade affects only the user's own score.
- **Plain text rendering.** The web app renders all model output as React text. It never uses `dangerouslySetInnerHTML` and never turns Markdown into HTML.
- **Escaped report.** The Markdown export escapes every character that could form a link, image, HTML tag or heading in model text, so a poisoned upload cannot plant a phishing link in a report someone else opens.
- **No tools on the analysis model.** The model that reads untrusted material cannot call tools, browse or send anything. It reads sensitive data and untrusted content, but it has no way out, so our own pipeline does not have the lethal trifecta.
- **Voice tools check their input.** The voice agent's client tools treat every parameter as untrusted, match letters to known options, and only light ids that exist on the board.

## Secrets in uploads

- **The browser skips secret files before reading them.** It fetches the server's file policy from `GET /api/config` and applies it to names and sizes before any content is read. Skipped: `.env` and `.env.*` except `.example`, `.sample`, `.template`, `.dist` and `.defaults`; files such as `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, `credentials` and SSH private keys; extensions such as `.pem`, `.key`, `.p12`, `.tfstate` and `.tfvars`; config files whose names contain `secret`, `credential` or `service-account`; `.envrc`, `kubeconfig`, `.kube/config`, `.docker/config.json` and `.ppk`, `.gpg` and `.asc` files; lockfiles, binaries, and vendored or generated folders. The intake screen lists every skipped file and the reason.
- **The server skips them again.** [boards/ingest.py](../api/app/boards/ingest.py) applies the same policy from [domain/masking.py](../api/app/domain/masking.py) to every file, GitHub path and agent file list, and drops whole diff sections for skipped files.
- **The server masks values.** `mask_secrets` replaces private key blocks, assignments to names like `api_key`, `secret`, `token` or `password`, passwords in URLs, bearer tokens, Slack and Discord webhooks, and known key formats (OpenAI and Anthropic, Stripe, AWS access key ids, Google API keys, GitHub, GitLab and npm tokens, Slack tokens, SendGrid, our own `tvd_` tokens and JWTs), quoted passwords with spaces, HTTP Basic credentials, kubeconfig key data, Docker registry auth and Azure account keys. PGP and PEM private key blocks are removed by a forward-only scan, and every regex repeat has an upper bound, so masking stays linear in the text's length. An upload is checked against its board's owner and a per-user pace (20 uploads per 10 minutes) before any masking runs. The activity log says how many values were masked.
- **Nothing unmasked is stored or sent.** The model sees only masked text. After the call, only each source's name, kind and size are kept.
- **The hook filters on the developer's machine.** It applies the server's policy to the diff, masks values before posting, refuses plain `http` except to localhost, and never follows redirects.

## Data sent to third parties

| Party | Receives | When |
|---|---|---|
| The server's model provider (`LLM_BASE_URL`) | Masked material, maps, threats, questions to the analyst and open quiz answers | For users without their own provider |
| The user's own provider | The same | For that user |
| Backboard | The same, and with memory on, the user's questions and quiz answers with their replies are kept as memory of the user's assistant | For users who pick Backboard as their provider |
| Backboard memory | The user's questions to the analyst and the open quiz questions as search queries, and notes of those questions with each quiz verdict. Never uploads, maps or the user's answer text | For users who save a memory key with their own model |
| ElevenLabs | The user's voice, the transcript, the username, the system name, a short brief of the board, and the quiz questions and feedback the tools return | During a voice session |
| ElevenLabs | A recording of the question the user dictates, up to a minute, through the API with the server's key | When the user presses the mic beside **Ask** |
| GitHub | A request for the named public repository, from the server's IP | During an import |

## Data retention

- **Kept until deleted:** accounts, boards with their maps, analyses, source records and activity, quiz answers including open answers in the user's own words, personal tokens, saved providers and usage records. A user can delete boards, revoke tokens, remove their provider and start a quiz over. Deleting an account takes an operator, and deletes everything the account owns.
- **Never kept:** the content of uploads, pasted text, GitHub files and agent diffs, and dictated recordings and their text.
- **Sessions** stop working after `SESSION_DAYS`. Expired rows stay in the table.
- **Server logs** hold usernames at sign up, the IP of a request that filled the honeypot, job failure messages, and, when a model reply fails validation, a short excerpt of that reply.
- **The event deployment**, including its database, is torn down after the event.

## Our own threat model

The map below is how we see our own system. Each row is a STRIDE threat, what stops it, and what is left.

| Component | STRIDE | Threat | Mitigation | Residual risk |
|---|---|---|---|---|
| Sign up and sign in | S | Password guessing | argon2id, lockout per username and network, a per-username ceiling, per-IP limit | Weak passwords outside the common list still pass |
| Sign up and sign in | D | Mass sign ups drain budgets | Invite code, honeypot, per-IP limit, account cap, per-user budgets | A leaked invite code lets anyone in until the cap |
| Sign up and sign in | D | Locking a known user out | The tight lockout is per network; only 50 failures from many networks lock the username | Someone on the same network, such as a shared venue, can still lock a user for 15 minutes |
| Sign up and sign in | I | Finding which usernames exist | Equal-time sign in, taken-check after the invite code | A code holder can test names at sign up |
| Session cookie | S | Stolen session | HttpOnly, Secure, `__Host-`, hashed at rest, expiry | A session lives up to 7 days; no "sign out everywhere" |
| Cookie routes | T | Cross-site request forgery | SameSite, JSON-only writes, Origin and Sec-Fetch-Site checks, CORS allowlist | None known |
| Web app | T | Stored XSS through model output | Plain text rendering, strict CSP with no inline script | `style-src 'unsafe-inline'` allows injected styles if markup ever got through |
| Web app | T | Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` on API-served pages | A separate static host must send its own frame headers |
| Boards | I | Reading another user's board | Every query filters by owner; others' boards return 404 | None known |
| Ingest | I | Secrets in uploads reach the model or the database | Skip in browser and server, masking, content never stored | Pattern-based masking misses secrets in unusual shapes |
| Model pipeline | T | Prompt injection rewrites the map or threats | Fencing, untrusted blocks, schemas, sanitizers, human map review | A convincing injection can still bias wording the user reads |
| Model pipeline | E | Injection makes the model act | The analysis model has no tools | None in our pipeline |
| Model pipeline | D | Slow or huge replies tie up workers | Timeouts, 8 job workers, one job per board, budgets; a user's own provider gets one call in flight and all users' own providers four together, with no retries | A slow host a user chose can hold up to four threads until its timeouts end |
| Provider settings | I | Reading a saved key | AES-GCM under `APP_SECRET`, owner-bound, never returned | A holder of the session can send the key to another host |
| Provider settings | E | SSRF into the private network | https only, public addresses only, checked at save, test and use, redirects never followed | DNS rebinding, see known limits |
| GitHub importer | E | SSRF through a crafted URL | Fixed host, strict pattern, no redirects | None known |
| GitHub importer | D | Oversized or bomb archives | 30 MB download cap, file count and byte caps | Decompressing a 30 MB archive still costs CPU in a job thread |
| Personal tokens | S | A leaked token acts for the user | Hashed, shown once, revocable, narrow reach, recognizable prefix | Tokens do not expire on their own |
| MCP tools | T | Board text steers the coding agent | Tools return plain text, and map, threat and answer text is folded onto one line so it cannot pose as another id or threat; the agent's own safeguards apply | Evidence and threat text come from untrusted material and reach an agent that has tools |
| Agent changes | D | An agent floods a board | 30 changes per hour, busy boards refuse new work | None known |
| Voice | T | Tampered dynamic variables or tool calls | Grading and budgets stay on the server; tools validate input | A user can change only their own coach's context |
| Voice | D | Voice minutes drained | Per-user daily sessions, budget spent before the token is minted | No overall voice cap; the ElevenLabs plan is the ceiling |
| Dictation | D | Speech to Text credits drained | Per-user daily and per-minute caps spent before ElevenLabs is called, clips of about a minute at most, the body cap | No overall dictation cap; the ElevenLabs plan is the ceiling |
| Usage records | R | Denying a spend | Every model call, voice session and dictation is a `usage` row | No audit log of other actions |
| Database | I | Dump or backup leaks | Only hashes of sessions and tokens, sealed keys, no upload content | Maps, threats and quiz answers are in clear text |
| Admin | E | An admin page gets attacked | No admin page; CLI on the host only | Anyone with shell access on the host is an admin |

## Known limits

- **Rate limits are in memory.** They reset when the server restarts and apply per instance. The app is deployed as one instance. Budgets are in the database and do not reset.
- **DNS rebinding window.** A provider base URL is checked just before each use, but DNS is not pinned between the check and the call, so a host that changes its answer in that window could reach a private address.
- **Shared networks share a lockout.** The tight lockout keys on username and network, so someone on the same network, such as a venue's shared connection, can still lock a user out for 15 minutes.
- **Per-IP limits trust the proxy setting.** With `TRUST_PROXY=true`, the client IP comes from the `CLIENT_IP_HEADER` the platform sets. Turn it on only behind a proxy that overwrites that header, or clients could pick their own IP.
- **Failed jobs still spend.** A model call is counted when the job is accepted, even if the model then fails.
- **Demo grading is keyword based.** In demo mode, open answers score by shared words, which is easy to game and says little about understanding.
- **No email, no reset.** There is no email verification and no password reset. A user who forgets their password needs an operator to delete the account.
- **Voice context is client supplied.** The browser passes the dynamic variables to ElevenLabs, so a user can change what their own coach is told. Grading and budgets stay on the server.
- **Third parties receive data.** The model provider, Backboard and ElevenLabs receive the data listed above and keep it under their own terms.
- **Masking is pattern based.** It can miss secrets that do not look like a key or an assignment, such as a password in prose. Do not upload material you would not show the model provider.
- **Map text reaches coding agents.** MCP tools return evidence and threat text drawn from uploaded material. A poisoned upload could try to steer a connected coding agent.
- **The model can be wrong.** Threats, attack paths and grades come from a model. They can miss real threats or invent ones that do not apply.

## Reporting a problem

If you find a security problem, report it privately to the repository owner through GitHub, using the repository's private vulnerability reporting if it is enabled. Include the steps to reproduce and what an attacker gains. Please do not open a public issue with exploit details, and do not test against other users' accounts or data.
