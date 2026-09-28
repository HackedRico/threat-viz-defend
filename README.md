# ThreatViz Defend

Runtime threat modeling while you vibe code.

Coding agents let anyone ship an app they cannot explain. ThreatViz Defend reads your code and docs, or watches your coding agent as it works, draws the system as a threat model, and coaches you by text or voice until you can defend it at a whiteboard.

**[Demo video](https://www.youtube.com/watch?v=0jWPZnt6eMM)** · **[Pitch deck](docs/pitch/threatviz-defend-pitch.pdf)** · Winner at [hackUMBC 2026](https://hackumbc.tech/)

## The problem

Vibe coding is building software by telling a coding agent what you want and shipping what it writes. The code comes fast, but the understanding never forms. Nobody on the team holds a mental model of what shipped, so nobody can say which parts exist, where the data goes, or what trusts what.

Security depends on that model. Threat modeling, code review and incident response all assume someone understands the design. With vibe coding, often no one does, and the flaws stay hidden until an attacker finds them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/problem-dark.svg">
  <img alt="What you asked for: one prompt, and the agent says done, tests pass, deployed. What you shipped: an AI agent that reads email from anyone, with four ways to attack it." src="docs/images/problem-light.svg" width="100%">
</picture>

## Our solution

ThreatViz Defend builds that mental model with you, from your own code, and then checks that it stuck. Reading a threat report is not the same as understanding it, so every board ends with a quiz on your own design.

It does not tell you a system is secure. It shows you where to look, and checks that you understood.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/how-it-works-dark.svg">
  <img alt="Add material, draft the map, confirm it, find threats, defend it. A coding agent's edits feed the same map." src="docs/images/how-it-works-light.svg" width="100%">
</picture>

![The example board: a data flow map with numbered threat pins, and the ranked threats beside it](docs/images/map.png)

<sub>The Inbox Helper from the problem above, mapped by ThreatViz Defend. Each numbered pin is a threat.</sub>

| Know what to fix first | Prove you understand it |
|:---:|:---:|
| <img alt="The fix first note: fix the triage agent first, turn off auto-send and fence its tools" src="docs/images/fix-first.png" width="100%"> | <img alt="A quiz question: which of these flows cross a trust boundary, with flows to pick from" src="docs/images/quiz.png" width="100%"> |

### Runtime threat modeling

The map keeps up while your agent codes. Connect Claude Code or Cursor once, and every turn that changes the architecture updates the board.

1. **A turn ends.** Our hook runs when the agent stops.
2. **Snapshot.** It copies the working tree into a private git ref. Your branch, index, stash and files stay untouched.
3. **Diff.** It compares the snapshot with the last report, and files that hold secrets never enter the snapshot.
4. **Architectural or not.** It posts only changes to manifests, Dockerfiles, infrastructure, routes, env vars, databases, queues, model SDKs or auth. UI and refactor work is skipped.
5. **The map updates.** The board redraws, marks what changed, and waits for you to confirm it.

Over MCP the agent can also list your boards, read the map, ask the board what a change risks, report a change, and run the Defend questions right in the editor. [integrations/README.md](integrations/README.md) sets it up.

### What it checks

Threat modeling means mapping how a system works, where its data flows and what trusts what, then asking what can go wrong at each step and fixing the worst of it before it ships. ThreatViz Defend runs that method on any codebase in minutes:

- **STRIDE on every part**, decided by rules in code, so what gets checked never depends on the model.
- **Every flow that crosses a trust boundary**, with the question of how the receiver knows the sender.
- **The lethal trifecta on AI agents**: private data, untrusted input and a way to send data out, all in one component.
- **A person confirms the map first**, and threats are only found on a map someone checked.

It is defensive only. It reads the material you give it, and never scans, probes or attacks a running system.

| Standard | How ThreatViz Defend uses it |
|---|---|
| [Threat Modeling Manifesto](https://www.threatmodelingmanifesto.org/) | Its four questions shape the flow: what are we working on, what can go wrong, what are we going to do about it, did we do a good enough job |
| STRIDE | The six threat categories, checked by rules on every part of the map |
| [OWASP](https://owasp.org/) | The Top 10 for LLM Applications 2025: prompt injection, data disclosure and excessive agency checks on every AI part |
| [CWE](https://cwe.mitre.org/) | Threats link to CWE and OWASP ids, and only when the model is sure of them |
| [NIST SSDF](https://csrc.nist.gov/projects/ssdf) | Practice PW.1.1 calls for threat modeling during design. ThreatViz Defend puts it in every developer's hands |

## Try it

**Watch it first.** Open [demo/index.html](demo/index.html) in a browser for a 30 second walkthrough: Claude Code builds an app, the hook posts each git diff, and the threat model draws and updates itself. It is a scripted animation with no setup.

**Run it on your machine.** You need Python 3.12 with [uv](https://docs.astral.sh/uv/), Node 24 and git.

```sh
git clone https://github.com/HackedRico/threat-viz-defend.git
cd threat-viz-defend
./scripts/dev.sh
```

Open http://localhost:5173 and sign in with `DEV_USERNAME` and `DEV_PASSWORD` from `.env`, which the script creates from [.env.example](.env.example) on the first run.

Without a model key, the app runs in demo mode on the example board, "Example: Inbox Helper": explore it, ask its recorded questions, and take its quiz. To map your own system, give it a model that speaks the OpenAI Chat Completions API:

- **For everyone on the server.** Set `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY` in `.env`, then restart. `.env.example` starts with DigitalOcean serverless inference.
- **For your account only.** Save a base URL, model and key under Settings, **Model provider**. It works in demo mode too, including with a local Ollama.

Then connect a coding agent with [integrations/README.md](integrations/README.md), or turn on the voice coach, memory or the Snowflake export from [docs/services.md](docs/services.md).

**Run it in Docker.** `docker compose up --build` starts Postgres and one container that serves the API and the built web app at http://localhost:8080. [docs/deploy.md](docs/deploy.md) takes it to production on DigitalOcean App Platform.

## How it is built

Anything you bring becomes a threat model. Every input is untrusted, so it passes through one API that owns every rule, every model call and all storage.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/pipeline-dark.svg">
  <img alt="Pasted notes, files or a code folder, and a public GitHub URL come from the browser, and a coding agent comes from the editor. The API masks secrets, drafts a map with the model, waits for you to confirm it, then finds threats with STRIDE rules and the model, and returns a threat model diagram with its threats pinned." src="docs/images/pipeline-light.svg" width="100%">
</picture>

- **The API** is Python and FastAPI. It masks secrets, drafts the map, runs the rules, calls the model and stores boards in SQLite or Postgres.
- **The web app** is React and TypeScript. It only draws what the API returns, so editing the page cannot change a threat or a grade.
- **The model** is any OpenAI-compatible endpoint, and every call must return JSON that matches a schema.
- **Coding agents** connect to `/mcp` with a personal token, or send diffs from a hook.
- **Optional services** add a voice coach and dictation (ElevenLabs), memory of each developer's progress (Backboard) and an export to your own Snowflake account. [docs/services.md](docs/services.md) says what each one does and receives.

[docs/architecture.md](docs/architecture.md) walks through every component, the board lifecycle and each model call.

## Security by design

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/output-checks-dark.svg">
  <img alt="Untrusted input is masked and fenced, the model has no tools, and its reply is validated, sanitized and shown as plain text." src="docs/images/output-checks-light.svg" width="100%">
</picture>

- Uploads are never stored, only their names and sizes.
- API keys never reach the browser or the logs.
- There is no admin page. Admin runs from the command line.
- Invite codes and daily budgets cap what any one account can spend.

[docs/security.md](docs/security.md) lists every control, our own threat model and the known limits. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Docs

| Doc | What it covers |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Every screen and control, step by step, and troubleshooting |
| [docs/architecture.md](docs/architecture.md) | Components, the board lifecycle, model calls, rules, quiz, storage and the frontend |
| [docs/services.md](docs/services.md) | The optional services: DigitalOcean, ElevenLabs, Backboard and Snowflake |
| [docs/api.md](docs/api.md) | Every endpoint and MCP tool, errors, rate limits and budgets |
| [docs/security.md](docs/security.md) | What we protect, every control, our own threat model and known limits |
| [docs/deploy.md](docs/deploy.md) | Deploying to DigitalOcean App Platform, and the admin commands |
| [integrations/README.md](integrations/README.md) | Connecting Claude Code and Cursor: MCP server and hook |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running it locally, making a change and opening a pull request |

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks and the security rules every change keeps, and [AGENTS.md](AGENTS.md) is the guide for coding agents working in this repo. Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Tech stack

FastAPI, Pydantic, SQLAlchemy (SQLite or Postgres), argon2, the OpenAI Python SDK, the MCP Python SDK, React 19, Vite, ELK for layout, Rough.js for the hand-drawn look, zustand, and the ElevenLabs React SDK for voice.

## Team

Built at hackUMBC 2026 by [Ricky](https://github.com/HackedRico) (core engine), [MD](https://github.com/mdieng123) (diagrams), Eman (voice) and [Jonathan](https://github.com/jonsoloo) (hosting). [docs/team.md](docs/team.md) shows who owns which area.

## License

ThreatViz Defend is open source under the [Apache License 2.0](LICENSE). The fonts in `demo/fonts/` keep their own SIL Open Font License, with each license beside its font.
